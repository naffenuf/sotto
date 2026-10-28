import { describe, expect, it } from "vitest";
import { emptyBoard, type Board } from "../../shared/board.js";
import {
  MAX_CANDIDATES_PER_RUN,
  OBSERVER_SCHEMA_NAME,
  ObserverCandidateSchema,
  type Candidate,
  type CandidateLogRecord,
  type ObserverCandidate,
} from "../../shared/candidates.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import type { ModelClient, StructuredCall } from "../model/client.js";
import {
  CURRENT_TOPIC_TURNS,
  Observer,
  OBSERVER_TRACK_LABEL,
  findDuplicate,
  renderObserverRequest,
} from "./Observer.js";

/** A model that answers from a script instead of over the network. */
class FakeModel implements ModelClient {
  readonly calls: StructuredCall[] = [];

  constructor(private readonly replies: (() => Promise<unknown>)[]) {}

  async structured(call: StructuredCall): Promise<unknown> {
    this.calls.push(call);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error(`unexpected model call ${this.calls.length}`);
    return reply();
  }
}

/** One candidate as the model would return it, with everything defaulted. */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "contradiction",
    headline: "The $20k studio doesn't fit the $4k budget",
    detail: "They capped the first version at $4,000 and are proposing $20,000 of design.",
    whyNow: "They are about to book it",
    evidenceTurnIds: ["0:3"],
    relatedBoardItemIds: ["c1"],
    scores: { relevance: 0.9, novelty: 0.8, importance: 0.9, confidence: 0.8 },
    ...overrides,
  };
}

/** A reply the model gives straight back. */
function candidates(...list: unknown[]): () => Promise<unknown> {
  return () => Promise.resolve({ candidates: list });
}

interface Harness {
  clock: SimulatedClock;
  model: FakeModel;
  observer: Observer;
  /** Every candidate written to `candidates.jsonl`, in order. */
  records: CandidateLogRecord[];
  /** The candidates handed on to the policy. */
  passed: Candidate[];
  states: [state: string, detail: string][];
  logs: string[];
  warnings: string[];
  /** Feeds final turns, numbered from where the last one left off. */
  say(count: number): TurnUpdate[];
}

function harness(replies: (() => Promise<unknown>)[]): Harness {
  const clock = new SimulatedClock(0);
  const model = new FakeModel(replies);
  const records: CandidateLogRecord[] = [];
  const passed: Candidate[] = [];
  const states: [string, string][] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const observer = new Observer({
    clock,
    model,
    onRecord: (record) => records.push(record),
    onCandidate: (candidate) => passed.push(candidate),
    onModelState: (state, detail) => states.push([state, detail]),
    logger: { log: (text: string) => logs.push(text), warn: (text: string) => warnings.push(text) },
  });

  let next = 0;
  return {
    clock,
    model,
    observer,
    records,
    passed,
    states,
    logs,
    warnings,
    say: (count) => {
      const said: TurnUpdate[] = [];
      for (let i = 0; i < count; i += 1) {
        const turn = finalTurn(next);
        next += 1;
        said.push(turn);
        observer.acceptTurn(turn);
      }
      return said;
    },
  };
}

function finalTurn(index: number): TurnUpdate {
  return {
    turnId: `0:${index}`,
    speaker: index % 2 === 0 ? "A" : "B",
    text: `turn ${index}`,
    final: true,
    startMs: index * 5_000,
    endMs: index * 5_000 + 4_000,
    speakerMappingUncertain: false,
  };
}

/** A board with one constraint on it, which a candidate can point at. */
function boardWithConstraint(): Board {
  return {
    ...emptyBoard(),
    summary: "They are scoping the first version.",
    constraints: [
      {
        id: "c1",
        text: "$4,000 for the whole first version",
        status: "open",
        sourceTurnIds: ["0:3"],
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      },
    ],
  };
}

describe("Observer", () => {
  it("looks right after a board update, and sends the board, the new turns and the topic", async () => {
    const test = harness([candidates()]);
    test.say(5);
    test.observer.observe(boardWithConstraint());
    await test.observer.flush();

    expect(test.model.calls).toHaveLength(1);
    const call = test.model.calls[0]!;
    expect(call.label).toBe(OBSERVER_TRACK_LABEL);
    expect(call.schemaName).toBe(OBSERVER_SCHEMA_NAME);
    expect(call.system).toContain("empty list is the normal");
    // Every new turn, and the last three again as the current topic.
    for (let index = 0; index < 5; index += 1) expect(call.user).toContain(`[0:${index}]`);
    const topic = call.user.slice(call.user.indexOf("## The current topic"));
    expect(topic).toContain("[0:2]");
    expect(topic).toContain("[0:4]");
    expect(topic).not.toContain("[0:1]");
    expect(test.observer.runs()).toBe(1);
  });

  it("ignores partials, and keeps the topic to the tail of the whole conversation", async () => {
    const test = harness([candidates(), candidates()]);
    test.say(4);
    test.observer.observe(emptyBoard());
    await test.observer.flush();
    test.observer.acceptTurn({ ...finalTurn(4), final: false });
    test.say(1);
    test.observer.observe(emptyBoard());
    await test.observer.flush();

    const second = test.model.calls[1]!.user;
    // Only the one new turn since the last look...
    const since = second.slice(
      second.indexOf("## The transcript since you last looked"),
      second.indexOf("## The current topic"),
    );
    expect(since).toContain("[0:4]");
    expect(since).not.toContain("[0:3]");
    // ...but the current topic still reaches back three turns.
    const topic = second.slice(second.indexOf("## The current topic"));
    expect(topic).toContain("[0:2]");
    expect(topic).toContain("[0:4]");
    expect(topic.match(/\[0:\d+\]/g)).toHaveLength(CURRENT_TOPIC_TURNS);
  });

  it("ids every candidate, records it before passing it on, and stamps the clock", async () => {
    const test = harness([candidates(raw(), raw({ type: "dropped_thread", headline: "Nobody answered who owns the data" }))]);
    test.say(4);
    test.clock.advanceBy(60_000);
    test.observer.observe(boardWithConstraint());
    await test.observer.flush();

    expect(test.records.map((record) => record.candidate.id)).toEqual(["cand-1", "cand-2"]);
    expect(test.passed.map((candidate) => candidate.id)).toEqual(["cand-1", "cand-2"]);
    for (const record of test.records) {
      expect(record.kind).toBe("candidate");
      expect(record.atMs).toBe(60_000);
      expect(record.candidate.createdAtMs).toBe(60_000);
      expect(record.candidate.run).toBe(1);
      expect(record.candidate.duplicateOf).toBeUndefined();
    }
    expect(test.records[0]!.candidate.scores.confidence).toBe(0.8);
    expect(test.states).toEqual([
      ["connecting", "looking for something worth saying"],
      ["active", "model client ready"],
    ]);
  });

  it("marks a repeat of an earlier candidate and does not pass it on", async () => {
    const test = harness([candidates(raw()), candidates(raw({ headline: "Booking the studio breaks the budget they set" }))]);
    test.say(4);
    test.observer.observe(boardWithConstraint());
    await test.observer.flush();
    test.say(4);
    test.observer.observe(boardWithConstraint());
    await test.observer.flush();

    expect(test.records).toHaveLength(2);
    expect(test.records[1]!.candidate.duplicateOf).toBe("cand-1");
    expect(test.passed.map((candidate) => candidate.id)).toEqual(["cand-1"]);
    expect(test.logs.join("\n")).toContain("cand-2 repeats cand-1");
    // And the model is told what has already been raised, so it can score
    // novelty without having to be caught out by the check.
    expect(test.model.calls[1]!.user).toContain("## Already raised");
    expect(test.model.calls[1]!.user).toContain(test.records[0]!.candidate.headline);
  });

  it("passes on a different type about the same board item", async () => {
    const test = harness([
      candidates(raw(), raw({ type: "untested_assumption", headline: "Nobody has asked the studio for a smaller package" })),
    ]);
    test.say(4);
    test.observer.observe(boardWithConstraint());
    await test.observer.flush();

    expect(test.records.map((record) => record.candidate.duplicateOf)).toEqual([
      undefined,
      undefined,
    ]);
    expect(test.passed).toHaveLength(2);
  });

  it("drops a malformed candidate and keeps the good one beside it", async () => {
    const test = harness([candidates({ type: "nitpick" }, raw())]);
    test.say(4);
    test.observer.observe(emptyBoard());
    await test.observer.flush();

    expect(test.passed).toHaveLength(1);
    expect(test.passed[0]!.id).toBe("cand-1");
    expect(test.warnings.join("\n")).toContain("ignored candidate 0");
  });

  it("keeps only the first three candidates of a run", async () => {
    const test = harness([
      candidates(
        raw({ type: "contradiction", headline: "One", relatedBoardItemIds: [] }),
        raw({ type: "factual_error", headline: "Two", relatedBoardItemIds: [] }),
        raw({ type: "untested_assumption", headline: "Three", relatedBoardItemIds: [] }),
        raw({ type: "dropped_thread", headline: "Four", relatedBoardItemIds: [] }),
      ),
    ]);
    test.say(4);
    test.observer.observe(emptyBoard());
    await test.observer.flush();

    expect(test.records).toHaveLength(MAX_CANDIDATES_PER_RUN);
    expect(test.passed.map((candidate) => candidate.headline)).toEqual(["One", "Two", "Three"]);
    expect(test.warnings.join("\n")).toContain("keeping the first 3");
  });

  it("keeps the turns and tries them again when a call fails", async () => {
    const test = harness([
      () => Promise.reject(new Error("the model is on fire")),
      candidates(),
    ]);
    test.say(4);
    test.observer.observe(emptyBoard());
    await test.observer.flush();

    expect(test.observer.runs()).toBe(0);
    expect(test.warnings.join("\n")).toContain("run 1 failed: the model is on fire");
    expect(test.states.at(-1)).toEqual(["error", "the model is on fire"]);

    test.say(1);
    test.observer.observe(emptyBoard());
    await test.observer.flush();
    const retried = test.model.calls[1]!.user;
    for (let index = 0; index < 5; index += 1) expect(retried).toContain(`[0:${index}]`);
  });

  it("never runs two looks at once, and merges a board update that arrived mid-call", async () => {
    let release = (): void => {};
    const held = new Promise<unknown>((resolve) => {
      release = () => resolve({ candidates: [] });
    });
    const test = harness([() => held, candidates()]);
    test.say(4);
    test.observer.observe(emptyBoard());
    test.say(2);
    test.observer.observe(boardWithConstraint());
    test.observer.observe(boardWithConstraint());
    expect(test.model.calls).toHaveLength(1);
    expect(test.clock.inFlight()).toEqual([OBSERVER_TRACK_LABEL]);

    release();
    await test.observer.flush();
    expect(test.model.calls).toHaveLength(2);
    // The second look got the newer board and the turns that arrived during
    // the first one, once.
    expect(test.model.calls[1]!.user).toContain("[c1]");
    const second = test.model.calls[1]!.user;
    const since = second.slice(
      second.indexOf("## The transcript since you last looked"),
      second.indexOf("## The current topic"),
    );
    expect(since.match(/\[0:\d+\]/g)).toEqual(["0:4", "0:5"].map((id) => `[${id}]`));
    expect(test.clock.inFlight()).toEqual([]);
  });

  it("stops looking once stopped", async () => {
    const test = harness([]);
    test.say(4);
    test.observer.stop();
    test.observer.observe(emptyBoard());
    test.observer.acceptTurn(finalTurn(9));
    await test.observer.flush();
    expect(test.model.calls).toHaveLength(0);
  });
});

describe("findDuplicate", () => {
  /** One candidate, through the schema, as the observer would have it. */
  const one = (overrides: Record<string, unknown> = {}): ObserverCandidate =>
    ObserverCandidateSchema.parse(raw(overrides));

  const earlier = (overrides: Record<string, unknown> = {}): Candidate => ({
    ...one(overrides),
    id: "cand-1",
    createdAtMs: 0,
    run: 1,
  });

  it("finds the same type pointing at an overlapping board item", () => {
    const previous = earlier({ relatedBoardItemIds: ["c1", "p2"] });
    const repeat = one({ headline: "Something else entirely", relatedBoardItemIds: ["p2"] });
    expect(findDuplicate(repeat, [previous])).toBe("cand-1");
  });

  it("finds the same type saying the same thing in other words", () => {
    const previous = earlier({
      headline: "The $20k studio doesn't fit the $4k budget",
      relatedBoardItemIds: [],
    });
    const repeat = one({
      headline: "A $20k studio does not fit their $4k budget",
      relatedBoardItemIds: [],
    });
    expect(findDuplicate(repeat, [previous])).toBe("cand-1");
  });

  it("does not confuse different types or different points", () => {
    const previous = earlier({ relatedBoardItemIds: ["c1"] });
    const otherType = one({ type: "factual_error", relatedBoardItemIds: ["c1"] });
    const otherPoint = one({
      headline: "Nobody has checked whether the API supports batching",
      relatedBoardItemIds: ["p7"],
    });
    expect(findDuplicate(otherType, [previous])).toBeUndefined();
    expect(findDuplicate(otherPoint, [previous])).toBeUndefined();
    expect(findDuplicate(otherPoint, [])).toBeUndefined();
  });
});

describe("renderObserverRequest", () => {
  it("prints the board as lines with ids, and leaves dropped items out", () => {
    const board = boardWithConstraint();
    board.points = [
      {
        id: "p1",
        text: "start with an off-the-shelf vision API",
        status: "open",
        sourceTurnIds: [],
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      {
        id: "p2",
        text: "train our own model",
        status: "dropped",
        sourceTurnIds: [],
        createdAtMs: 0,
        updatedAtMs: 0,
      },
    ];
    const rendered = renderObserverRequest(board, [finalTurn(0)], [finalTurn(0)], []);
    expect(rendered).toContain("They are scoping the first version.");
    expect(rendered).toContain("[c1] $4,000 for the whole first version");
    expect(rendered).toContain("[p1] start with an off-the-shelf vision API");
    expect(rendered).not.toContain("train our own model");
    expect(rendered).not.toContain("## Already raised");
  });

  it("says so when there is no board and nothing new", () => {
    const rendered = renderObserverRequest(emptyBoard(), [], [], []);
    expect(rendered).toContain("_no summary yet_");
    expect(rendered).toContain("_nothing new_");
    expect(rendered).not.toContain("## The current topic");
  });
});
