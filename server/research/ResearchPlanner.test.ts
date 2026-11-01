import { describe, expect, it } from "vitest";
import { emptyBoard, type Board } from "../../shared/board.js";
import type { PlannerIdea, ResearchIdea } from "../../shared/research.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import type { ModelClient, StructuredCall } from "../model/client.js";
import {
  PLANNER_INTERVAL_MS,
  PLANNER_MIN_NEW_TURNS,
  PLANNER_TRACK_LABEL,
  ResearchPlanner,
  renderPlannerRequest,
} from "./ResearchPlanner.js";

/** A model that answers from a script instead of over the network. */
class FakeModel implements ModelClient {
  readonly calls: StructuredCall[] = [];

  constructor(private readonly replies: (() => Promise<unknown>)[]) {}

  async grounded(): Promise<never> {
    throw new Error("unexpected grounded call");
  }

  async prose(): Promise<never> {
    throw new Error("unexpected prose call");
  }

  async structured(call: StructuredCall): Promise<unknown> {
    this.calls.push(call);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error(`unexpected model call ${this.calls.length}`);
    return reply();
  }
}

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: "competitor pricing",
    question: "What do Otter and Fireflies charge per seat per month?",
    why: "the pricing argument rests on a number nobody has",
    sourceTurnIds: ["0:4"],
    ...overrides,
  };
}

function ideas(...list: unknown[]): () => Promise<unknown> {
  return () => Promise.resolve({ ideas: list });
}

function turn(index: number, text = `line ${index}`): TurnUpdate {
  return {
    turnId: `0:${index}`,
    speaker: index % 2 === 0 ? "A" : "B",
    speakerMappingUncertain: false,
    text,
    final: true,
    startMs: index * 1_000,
    endMs: index * 1_000 + 800,
  };
}

interface Harness {
  clock: SimulatedClock;
  model: FakeModel;
  planner: ResearchPlanner;
  seen: PlannerIdea[][];
  known: ResearchIdea[];
}

function harness(replies: (() => Promise<unknown>)[], board: Board = emptyBoard()): Harness {
  const clock = new SimulatedClock(0);
  const model = new FakeModel(replies);
  const seen: PlannerIdea[][] = [];
  const known: ResearchIdea[] = [];
  const planner = new ResearchPlanner({
    clock,
    model,
    board: () => board,
    known: () => known,
    onIdeas: (list) => seen.push(list),
  });
  return { clock, model, planner, seen, known };
}

describe("ResearchPlanner", () => {
  it("does nothing until the interval, and then only with enough new turns", async () => {
    const { clock, model, planner, seen } = harness([ideas(raw())]);
    for (let index = 0; index < PLANNER_MIN_NEW_TURNS; index += 1) {
      planner.acceptTurn(turn(index));
    }
    expect(model.calls).toHaveLength(0);

    await clock.advanceBy(PLANNER_INTERVAL_MS);
    await clock.settle();
    expect(model.calls).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]?.topic).toBe("competitor pricing");
  });

  it("skips a tick that has not heard enough, and looks at the next one", async () => {
    const { clock, model, planner } = harness([ideas(raw())]);
    planner.acceptTurn(turn(0));
    planner.acceptTurn(turn(1));
    await clock.advanceBy(PLANNER_INTERVAL_MS);
    await clock.settle();
    expect(model.calls).toHaveLength(0);

    planner.acceptTurn(turn(2));
    await clock.advanceBy(PLANNER_INTERVAL_MS);
    await clock.settle();
    expect(model.calls).toHaveLength(1);
    expect(planner.runs()).toBe(1);
  });

  it("ignores partials", async () => {
    const { clock, model, planner } = harness([ideas(raw())]);
    for (let index = 0; index < 5; index += 1) {
      planner.acceptTurn({ ...turn(index), final: false });
    }
    await clock.advanceBy(PLANNER_INTERVAL_MS * 2);
    await clock.settle();
    expect(model.calls).toHaveLength(0);
  });

  it("keeps at most two ideas and drops a malformed one on its own", async () => {
    const { clock, planner, seen } = harness([
      ideas(raw(), { topic: "", question: "" }, raw({ topic: "b" }), raw({ topic: "c" })),
    ]);
    for (let index = 0; index < 4; index += 1) planner.acceptTurn(turn(index));
    await clock.advanceBy(PLANNER_INTERVAL_MS);
    await clock.settle();
    expect(seen[0]?.map((idea) => idea.topic)).toEqual(["competitor pricing", "b"]);
  });

  it("says nothing when the model proposes nothing", async () => {
    const { clock, planner, seen } = harness([ideas()]);
    for (let index = 0; index < 4; index += 1) planner.acceptTurn(turn(index));
    await clock.advanceBy(PLANNER_INTERVAL_MS);
    await clock.settle();
    expect(seen).toEqual([]);
    expect(planner.runs()).toBe(1);
  });

  it("puts the turns of a failed look back for the next tick", async () => {
    const { clock, model, planner, seen } = harness([
      () => Promise.reject(new Error("boom")),
      ideas(raw()),
    ]);
    for (let index = 0; index < 3; index += 1) planner.acceptTurn(turn(index));
    await clock.advanceBy(PLANNER_INTERVAL_MS);
    await clock.settle();
    expect(model.calls).toHaveLength(1);
    expect(seen).toEqual([]);

    // No new turns: the retry only happens because the old ones came back.
    await clock.advanceBy(PLANNER_INTERVAL_MS);
    await clock.settle();
    expect(model.calls).toHaveLength(2);
    const retried = model.calls[1]?.user ?? "";
    expect(retried).toContain("[0:0]");
    expect(retried).toContain("[0:2]");
    expect(seen).toHaveLength(1);
  });

  it("registers the look on the clock, so a max-speed replay waits for it", async () => {
    const clock = new SimulatedClock(0);
    const labels: string[] = [];
    const tracked = clock.track.bind(clock);
    clock.track = (label, work) => {
      labels.push(label);
      return tracked(label, work);
    };
    const planner = new ResearchPlanner({
      clock,
      model: new FakeModel([ideas(raw())]),
      board: () => emptyBoard(),
      known: () => [],
      onIdeas: () => {},
    });
    for (let index = 0; index < 3; index += 1) planner.acceptTurn(turn(index));
    await clock.advanceBy(PLANNER_INTERVAL_MS);
    await clock.settle();
    expect(labels).toContain(PLANNER_TRACK_LABEL);
  });

  it("stops looking once stopped", async () => {
    const { clock, model, planner } = harness([ideas(raw())]);
    for (let index = 0; index < 3; index += 1) planner.acceptTurn(turn(index));
    planner.stop();
    await clock.advanceBy(PLANNER_INTERVAL_MS * 3);
    await clock.settle();
    expect(model.calls).toHaveLength(0);
  });

  it("does not take a final look on flush: a finished conversation needs no research", async () => {
    const { clock, model, planner } = harness([ideas(raw())]);
    for (let index = 0; index < 5; index += 1) planner.acceptTurn(turn(index));
    await planner.flush();
    await clock.settle();
    expect(model.calls).toHaveLength(0);
  });
});

describe("renderPlannerRequest", () => {
  const known: ResearchIdea[] = [
    {
      id: "idea-1",
      topic: "drive time",
      question: "How long is the drive to Edale?",
      why: "the return time hangs on it",
      sourceTurnIds: ["0:2"],
    },
  ];

  it("prints turn ids exactly as the assembler made them", () => {
    const rendered = renderPlannerRequest(emptyBoard(), [turn(7, "we should check")], [], []);
    expect(rendered).toContain("[0:7] B (00:07): we should check");
  });

  it("lists what is already being looked up", () => {
    const rendered = renderPlannerRequest(emptyBoard(), [turn(7)], [], known);
    expect(rendered).toContain("Already being looked up");
    expect(rendered).toContain("(drive time) How long is the drive to Edale?");
  });

  it("says so when nothing is new", () => {
    expect(renderPlannerRequest(emptyBoard(), [], [], [])).toContain("_nothing new_");
  });

  it("marks the earlier turns as context only", () => {
    const rendered = renderPlannerRequest(emptyBoard(), [turn(7)], [turn(1)], []);
    expect(rendered).toContain("for context only");
    expect(rendered).toContain("[0:1]");
  });
});
