import { describe, expect, it } from "vitest";
import type { Board, BoardOp } from "../../shared/board.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import type { ModelClient, StructuredCall } from "../model/client.js";
import {
  BoardUpdater,
  CONTEXT_TURNS,
  NEW_TURNS_PER_UPDATE,
  UPDATE_INTERVAL_MS,
  renderBoardRequest,
  type AppliedBoardUpdate,
} from "./BoardUpdater.js";

/**
 * A model that answers from a script instead of over the network.
 *
 * `replies` is consumed one call at a time; a function is called so a test can
 * hand back a promise it resolves itself, which is how the in-flight tests
 * hold an update open.
 */
class FakeModel implements ModelClient {
  readonly calls: StructuredCall[] = [];

  constructor(private readonly replies: (() => Promise<unknown>)[]) {}

  /** The board and the observer never search; US-013's verifier does. */
  async grounded(): Promise<never> {
    throw new Error("unexpected grounded call");
  }

  async structured(call: StructuredCall): Promise<unknown> {
    this.calls.push(call);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error(`unexpected model call ${this.calls.length}`);
    return reply();
  }
}

/** A reply the model gives straight back. */
function ops(...operations: BoardOp[]): () => Promise<unknown> {
  return () => Promise.resolve({ operations });
}

interface Harness {
  clock: SimulatedClock;
  model: FakeModel;
  updater: BoardUpdater;
  updates: AppliedBoardUpdate[];
  states: [state: string, detail: string][];
  warnings: string[];
  /** Feeds final turns, numbered from where the last one left off. */
  say(count: number, text?: (index: number) => string): TurnUpdate[];
}

function harness(replies: (() => Promise<unknown>)[]): Harness {
  const clock = new SimulatedClock(0);
  const model = new FakeModel(replies);
  const updates: AppliedBoardUpdate[] = [];
  const states: [string, string][] = [];
  const warnings: string[] = [];
  const updater = new BoardUpdater({
    clock,
    model,
    onUpdate: (update) => updates.push(update),
    onModelState: (state, detail) => states.push([state, detail]),
    logger: { log: () => {}, warn: (text: string) => warnings.push(text) },
  });

  let next = 0;
  return {
    clock,
    model,
    updater,
    updates,
    states,
    warnings,
    say: (count, text = (index) => `turn ${index}`) => {
      const said: TurnUpdate[] = [];
      for (let i = 0; i < count; i += 1) {
        const turn = finalTurn(next, text(next));
        next += 1;
        said.push(turn);
        updater.acceptTurn(turn);
      }
      return said;
    },
  };
}

function finalTurn(index: number, text: string): TurnUpdate {
  const startMs = index * 5_000;
  return {
    turnId: `0:${index}`,
    speaker: index % 2 === 0 ? "A" : "B",
    text,
    final: true,
    startMs,
    endMs: startMs + 4_000,
    speakerMappingUncertain: false,
  };
}

const add: BoardOp = { op: "add_point", text: "Start with an off-the-shelf API", sourceTurnIds: ["0:1"] };
const summary: BoardOp = { op: "set_summary", text: "Two engineers scoping a fridge app." };

describe("BoardUpdater triggers", () => {
  it("updates as soon as four new final turns have arrived", async () => {
    const h = harness([ops(add)]);
    h.say(NEW_TURNS_PER_UPDATE - 1);
    await h.clock.settle();
    expect(h.model.calls).toHaveLength(0);

    h.say(1);
    await h.clock.settle();
    expect(h.model.calls).toHaveLength(1);
    expect(h.updates).toHaveLength(1);
  });

  it("updates after the interval with one turn, and not a moment before", async () => {
    const h = harness([ops(add)]);
    h.say(1);

    h.clock.advanceBy(UPDATE_INTERVAL_MS - 1);
    await h.clock.settle();
    expect(h.model.calls).toHaveLength(0);

    h.clock.advanceBy(1);
    await h.clock.settle();
    expect(h.model.calls).toHaveLength(1);
  });

  it("never runs on time alone, with no new turn to show", async () => {
    const h = harness([]);
    h.clock.advanceBy(UPDATE_INTERVAL_MS * 5);
    await h.clock.settle();
    expect(h.model.calls).toHaveLength(0);
    expect(h.clock.pending).toBe(0);
  });

  it("ignores partials: the board is built from what people finished saying", async () => {
    const h = harness([]);
    for (let i = 0; i < 8; i += 1) {
      h.updater.acceptTurn({ ...finalTurn(i, "half a sent"), final: false });
    }
    h.clock.advanceBy(UPDATE_INTERVAL_MS * 2);
    await h.clock.settle();
    expect(h.model.calls).toHaveLength(0);
  });

  it("re-arms the interval for turns left over after an update", async () => {
    const h = harness([ops(add), ops(summary)]);
    h.say(NEW_TURNS_PER_UPDATE);
    await h.clock.settle();
    expect(h.model.calls).toHaveLength(1);

    h.say(1);
    h.clock.advanceBy(UPDATE_INTERVAL_MS);
    await h.clock.settle();
    expect(h.model.calls).toHaveLength(2);
  });

  it("stop() ends the loop, and leaves no timer armed", async () => {
    const h = harness([]);
    h.say(1);
    expect(h.clock.pending).toBe(1);

    h.updater.stop();
    expect(h.clock.pending).toBe(0);

    h.say(NEW_TURNS_PER_UPDATE * 2);
    h.clock.advanceBy(UPDATE_INTERVAL_MS * 2);
    await h.clock.settle();
    expect(h.model.calls).toHaveLength(0);
  });
});

describe("BoardUpdater with one update in flight", () => {
  it("merges triggers that arrive meanwhile into the next run", async () => {
    let release = (): void => {};
    const held = new Promise<unknown>((resolve) => {
      release = () => resolve({ operations: [add] });
    });
    const h = harness([() => held, ops(summary)]);

    h.say(NEW_TURNS_PER_UPDATE);
    await Promise.resolve();
    expect(h.model.calls).toHaveLength(1);

    // Eight more turns while the call is out: two triggers' worth, and still
    // only one call outstanding.
    h.say(NEW_TURNS_PER_UPDATE * 2);
    await Promise.resolve();
    expect(h.model.calls).toHaveLength(1);

    release();
    await h.clock.settle();

    expect(h.model.calls).toHaveLength(2);
    // All eight went into the one merged run, none of them twice.
    expect(h.updates[1]?.turnIds).toEqual([
      "0:4",
      "0:5",
      "0:6",
      "0:7",
      "0:8",
      "0:9",
      "0:10",
      "0:11",
    ]);
  });

  it("holds simulated time at the moment the call was made", async () => {
    let release = (): void => {};
    const held = new Promise<unknown>((resolve) => {
      release = () => resolve({ operations: [add] });
    });
    const h = harness([() => held]);

    h.say(NEW_TURNS_PER_UPDATE);
    h.clock.advanceBy(1_000);
    const settled = h.clock.settle();
    expect(h.clock.inFlight()).toEqual(["board"]);
    release();
    await settled;

    // The item is stamped with the time the reply came back, which on a
    // simulated clock is still the time the call went out.
    expect(h.updates[0]?.board.points[0]?.createdAtMs).toBe(1_000);
  });
});

describe("BoardUpdater applying a reply", () => {
  it("folds the operations in and reports what changed", async () => {
    const h = harness([
      ops(summary, add, {
        op: "add_constraint",
        text: "$4,000 for the whole first version",
        sourceTurnIds: ["0:3"],
      }),
    ]);
    h.say(NEW_TURNS_PER_UPDATE);
    await h.clock.settle();

    const update = h.updates[0] as AppliedBoardUpdate;
    expect(update.summaryChanged).toBe(true);
    expect(update.changedIds).toEqual(["p1", "c1"]);
    expect(update.board.constraints[0]?.text).toBe("$4,000 for the whole first version");
    expect(update.board.constraints[0]?.sourceTurnIds).toEqual(["0:3"]);
    expect(update.markdown).toContain("$4,000 for the whole first version");
    expect(update.markdown).toContain("Two engineers scoping a fridge app.");
    expect(h.updater.board()).toEqual(update.board);
    expect(h.updater.updates()).toBe(1);
  });

  it("publishes an update even when the model changed nothing", async () => {
    const h = harness([ops()]);
    h.say(NEW_TURNS_PER_UPDATE);
    await h.clock.settle();

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.changedIds).toEqual([]);
    expect(h.updates[0]?.board.points).toEqual([]);
  });

  it("keeps the good operations beside a bad one, and logs it", async () => {
    const h = harness([ops({ op: "set_status", id: "p9", status: "covered" }, add)]);
    h.say(NEW_TURNS_PER_UPDATE);
    await h.clock.settle();

    expect(h.updates[0]?.board.points).toHaveLength(1);
    expect(h.updates[0]?.ignored).toEqual([
      { op: { op: "set_status", id: "p9", status: "covered" }, reason: "unknown id", id: "p9" },
    ]);
    expect(h.warnings.join("\n")).toContain("ignored set_status p9: unknown id");
  });

  it("drives the model status dot around each call", async () => {
    const h = harness([ops(add)]);
    h.say(NEW_TURNS_PER_UPDATE);
    await h.clock.settle();
    expect(h.states).toEqual([
      ["connecting", "updating the board"],
      ["active", "model client ready"],
    ]);
  });
});

describe("BoardUpdater when the model misbehaves", () => {
  it("does not lose the turns of a failed call", async () => {
    const h = harness([() => Promise.reject(new Error("503 upstream")), ops(add)]);
    const said = h.say(NEW_TURNS_PER_UPDATE);
    await h.clock.settle();

    expect(h.updates).toHaveLength(0);
    expect(h.states.at(-1)).toEqual(["error", "503 upstream"]);
    expect(h.warnings.join("\n")).toContain("update 1 failed: 503 upstream");

    // The interval is re-armed for the turns that came back, so the same four
    // are retried rather than dropped.
    h.clock.advanceBy(UPDATE_INTERVAL_MS);
    await h.clock.settle();
    expect(h.updates[0]?.turnIds).toEqual(said.map((turn) => turn.turnId));
  });

  it("treats a reply that does not fit the schema as a failed update", async () => {
    const h = harness([() => Promise.resolve({ operations: [{ op: "delete_everything" }] })]);
    h.say(NEW_TURNS_PER_UPDATE);
    await h.clock.settle();

    expect(h.updates).toHaveLength(0);
    expect(h.warnings.join("\n")).toContain("board operations did not match the schema");
  });
});

describe("BoardUpdater.flush", () => {
  it("runs a last update for the turns that never reached a trigger", async () => {
    const h = harness([ops(add)]);
    h.say(2);
    await h.updater.flush();

    expect(h.model.calls).toHaveLength(1);
    expect(h.updates[0]?.turnIds).toEqual(["0:0", "0:1"]);
  });

  it("does nothing when the board has seen everything", async () => {
    const h = harness([ops(add)]);
    h.say(NEW_TURNS_PER_UPDATE);
    await h.clock.settle();
    await h.updater.flush();
    expect(h.model.calls).toHaveLength(1);
  });

  it("waits for an update that is already in flight", async () => {
    let release = (): void => {};
    const held = new Promise<unknown>((resolve) => {
      release = () => resolve({ operations: [add] });
    });
    const h = harness([() => held]);
    h.say(NEW_TURNS_PER_UPDATE);
    await Promise.resolve();

    const flushed = h.updater.flush();
    release();
    await flushed;
    expect(h.updates).toHaveLength(1);
  });
});

describe("the board update request", () => {
  it("carries the board, the new turns and the ten before them", async () => {
    const h = harness([ops(add), ops(), ops(), ops(), ops()]);
    // Five updates of four turns each, so the last one has twenty turns
    // behind it and has to choose which to send.
    for (let batch = 0; batch < 5; batch += 1) {
      h.say(NEW_TURNS_PER_UPDATE);
      await h.clock.settle();
    }
    expect(h.model.calls).toHaveLength(5);

    const last = h.model.calls[4] as StructuredCall;
    expect(last.schemaName).toBe("board_operations");
    // The item the first update added is in the board the last one is shown.
    expect(last.user).toContain("Start with an off-the-shelf API");
    // Turns 16-19 are new, 6-15 are context, and 0-5 are left out.
    for (let i = 0; i < 6; i += 1) expect(last.user).not.toContain(`[0:${i}]`);
    for (let i = 6; i < NEW_TURNS_PER_UPDATE * 5; i += 1) {
      expect(last.user).toContain(`[0:${i}]`);
    }
    expect(CONTEXT_TURNS).toBe(10);
  });

  it("prints a turn as its id, speaker, time and text", () => {
    const board: Board = {
      summary: "",
      constraints: [],
      points: [],
      questions: [],
      decisions: [],
    };
    const rendered = renderBoardRequest(
      board,
      [finalTurn(25, "Twenty thousand,  roughly.")],
      [finalTurn(24, "How much?")],
    );
    expect(rendered).toContain("[0:24] A (02:00): How much?");
    // Whitespace is collapsed: one turn, one line.
    expect(rendered).toContain("[0:25] B (02:05): Twenty thousand, roughly.");
    expect(rendered).toContain('"summary": ""');
  });

  it("says so when there is no context yet", () => {
    const rendered = renderBoardRequest(
      { summary: "", constraints: [], points: [], questions: [], decisions: [] },
      [finalTurn(0, "Hello")],
      [],
    );
    expect(rendered).not.toContain("for context only");
  });
});
