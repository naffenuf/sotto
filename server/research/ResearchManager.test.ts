import { describe, expect, it } from "vitest";
import { emptyBoard } from "../../shared/board.js";
import type { Candidate } from "../../shared/candidates.js";
import {
  MAX_CONCURRENT_JOBS,
  MAX_JOBS_PER_WINDOW,
  RESEARCH_WINDOW_MS,
  type ResearchGateRecord,
  type ResearchIdeaRecord,
  type ResearchLogLine,
  type ResearchPacket,
  type ResearchStartRecord,
} from "../../shared/research.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import type { ModelClient, StructuredCall } from "../model/client.js";
import type { JudgmentClient } from "../model/judgment.js";
import { PLANNER_INTERVAL_MS } from "./ResearchPlanner.js";
import { ResearchManager, type ResearchManagerOptions } from "./ResearchManager.js";

const quiet = { log: () => {}, warn: () => {} };

/** A model the planner is never allowed to reach in these tests. */
const noModel: ModelClient = {
  structured: () => Promise.reject(new Error("unexpected planner call")),
  grounded: () => Promise.reject(new Error("unexpected grounded call")),
  prose: () => Promise.reject(new Error("unexpected prose call")),
};

/** A hook as the observer would hand it over (V2-011). */
function hook(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "cand-1",
    type: "research_hook",
    headline: "What do Otter and Fireflies charge per seat per month?",
    detail: "They are costing a paid tier off numbers nobody can back up.",
    whyNow: "the pricing decision is on the table",
    evidenceTurnIds: ["0:4"],
    relatedBoardItemIds: [],
    scores: { relevance: 0.8, novelty: 0.8, importance: 0.7, confidence: 0.7 },
    createdAtMs: 1_000,
    run: 1,
    evidence: [],
    ...overrides,
  };
}

function turn(index: number, text = `line ${index}`): TurnUpdate {
  return {
    turnId: `0:${index}`,
    speaker: "A",
    speakerMappingUncertain: false,
    text,
    final: true,
    startMs: index * 1_000,
    endMs: index * 1_000 + 800,
  };
}

interface Harness {
  clock: SimulatedClock;
  manager: ResearchManager;
  records: ResearchLogLine[];
  started: string[];
  finish: (ideaId: string) => void;
  gateCalls: StructuredCall[];
}

/**
 * A manager whose gate answers from a script and whose jobs finish when the
 * test says so.
 */
function harness(
  options: {
    scores?: (() => Promise<unknown>)[];
    /** `instant` finishes a job straight away; `held` waits for `finish`. */
    jobs?: "instant" | "held" | "none";
    model?: ModelClient;
    extra?: Partial<ResearchManagerOptions>;
  } = {},
): Harness {
  const clock = new SimulatedClock(0);
  const records: ResearchLogLine[] = [];
  const started: string[] = [];
  const gateCalls: StructuredCall[] = [];
  const resolvers = new Map<string, () => void>();
  const scores = options.scores ?? [];
  const client: JudgmentClient = {
    where: "local",
    structured: (call) => {
      gateCalls.push(call);
      const next = scores.shift();
      return next === undefined
        ? Promise.resolve({ useful: 0.9, unknown: 0.9, answerable: 0.9 })
        : next();
    },
  };
  const manager = new ResearchManager({
    clock,
    model: options.model ?? noModel,
    client: () => Promise.resolve(client),
    board: emptyBoard,
    logger: quiet,
    onRecord: (record) => records.push(record),
    ...(options.jobs === "none"
      ? {}
      : {
          run: (idea) => {
            started.push(idea.id);
            if (options.jobs !== "held") return Promise.resolve();
            return new Promise<void>((resolve) => resolvers.set(idea.id, resolve));
          },
        }),
    ...options.extra,
  });
  return {
    clock,
    manager,
    records,
    started,
    gateCalls,
    finish: (ideaId) => {
      const resolve = resolvers.get(ideaId);
      if (resolve === undefined) throw new Error(`${ideaId} was never started`);
      resolvers.delete(ideaId);
      resolve();
    },
  };
}

function ideaRecords(records: readonly ResearchLogLine[]): ResearchIdeaRecord[] {
  return records.filter((record): record is ResearchIdeaRecord => record.kind === "idea");
}

function gateRecords(records: readonly ResearchLogLine[]): ResearchGateRecord[] {
  return records.filter((record): record is ResearchGateRecord => record.kind === "gate");
}

function startRecords(records: readonly ResearchLogLine[]): ResearchStartRecord[] {
  return records.filter((record): record is ResearchStartRecord => record.kind === "start");
}

describe("ResearchManager: hooks become ideas", () => {
  it("turns a research_hook into an idea, gates it and starts it", async () => {
    const { manager, records, started } = harness();
    manager.acceptHook(hook());
    await manager.flush();

    const ideas = ideaRecords(records);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.origin).toBe("hook");
    expect(ideas[0]?.candidateId).toBe("cand-1");
    expect(ideas[0]?.idea.id).toBe("idea-1");
    expect(ideas[0]?.idea.question).toBe(hook().headline);
    expect(ideas[0]?.idea.sourceTurnIds).toEqual(["0:4"]);
    expect(gateRecords(records).map((record) => record.decision)).toEqual(["queued"]);
    expect(started).toEqual(["idea-1"]);
    expect(manager.ideas()).toHaveLength(1);
  });

  it("logs the idea before the gate verdict, so the file is never behind", async () => {
    const { manager, records } = harness();
    manager.acceptHook(hook());
    await manager.flush();
    expect(records.map((record) => record.kind)).toEqual(["idea", "gate", "start"]);
  });

  it("records every gate decision, including one that failed", async () => {
    const { manager, records, started } = harness({
      scores: [() => Promise.reject(new Error("Glimmer is not running"))],
    });
    manager.acceptHook(hook());
    await manager.flush();
    const gates = gateRecords(records);
    expect(gates[0]?.decision).toBe("failed");
    expect(gates[0]?.error).toContain("Glimmer is not running");
    expect(started).toEqual([]);
  });
});

describe("ResearchManager: dedupe", () => {
  it("writes down a repeat and takes it no further", async () => {
    const { manager, records, started } = harness();
    manager.acceptHook(hook());
    await manager.flush();
    manager.acceptHook(hook({ id: "cand-2", headline: "Per seat per month, what do Otter and Fireflies charge?" }));
    await manager.flush();

    const ideas = ideaRecords(records);
    expect(ideas).toHaveLength(2);
    expect(ideas[1]?.duplicateOf).toBe("idea-1");
    // Only the first one was ever gated or started.
    expect(gateRecords(records)).toHaveLength(1);
    expect(started).toEqual(["idea-1"]);
    expect(manager.ideas()).toHaveLength(1);
  });

  it("lets a genuinely different question through", async () => {
    const { manager, records, started } = harness();
    manager.acceptHook(hook());
    manager.acceptHook(
      hook({ id: "cand-2", headline: "How long may voice recordings be stored under GDPR?" }),
    );
    await manager.flush();
    expect(ideaRecords(records).every((record) => record.duplicateOf === undefined)).toBe(true);
    expect(started).toEqual(["idea-1", "idea-2"]);
  });

  it("dedupes against an idea already searched, because ideas are never forgotten", async () => {
    const { manager, records, finish } = harness({ jobs: "held" });
    manager.acceptHook(hook());
    await tick();
    finish("idea-1");
    manager.acceptHook(hook({ id: "cand-9" }));
    await manager.flush();
    expect(ideaRecords(records)[1]?.duplicateOf).toBe("idea-1");
  });

  it("numbers every idea, duplicate or not, so a log line is never ambiguous", async () => {
    const { manager, records } = harness();
    manager.acceptHook(hook());
    manager.acceptHook(hook({ id: "cand-2" }));
    await manager.flush();
    expect(ideaRecords(records).map((record) => record.idea.id)).toEqual(["idea-1", "idea-2"]);
  });
});

describe("ResearchManager: the gate", () => {
  it("queues nothing the gate scored below the threshold", async () => {
    const { manager, records, started } = harness({
      scores: [() => Promise.resolve({ useful: 0.9, unknown: 0.1, answerable: 0.9 })],
    });
    manager.acceptHook(hook());
    await manager.flush();
    expect(gateRecords(records)[0]?.decision).toBe("rejected");
    expect(started).toEqual([]);
    expect(manager.queued()).toEqual([]);
  });

  it("respects a threshold the session passes in", async () => {
    const { manager, started } = harness({
      scores: [() => Promise.resolve({ useful: 0.5, unknown: 0.5, answerable: 0.5 })],
      extra: { threshold: 0.4 },
    });
    manager.acceptHook(hook());
    await manager.flush();
    expect(started).toEqual(["idea-1"]);
  });

  it("scores one idea at a time: Glimmer is one local GPU", async () => {
    let inFlight = 0;
    let most = 0;
    const slow = () =>
      new Promise<unknown>((resolve) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          resolve({ useful: 0.9, unknown: 0.9, answerable: 0.9 });
        }, 0);
      });
    const { manager } = harness({ scores: [slow, slow, slow] });
    manager.acceptHook(hook({ id: "cand-1", headline: "What does Otter charge per seat?" }));
    manager.acceptHook(hook({ id: "cand-2", headline: "How long is the drive to Edale?" }));
    manager.acceptHook(hook({ id: "cand-3", headline: "What does GDPR require for voice data?" }));
    await manager.flush();
    expect(most).toBe(1);
    expect(manager.ideas()).toHaveLength(3);
  });

  it("registers the gate queue on the clock, so a max-speed replay waits", async () => {
    const clock = new SimulatedClock(0);
    const labels: string[] = [];
    const tracked = clock.track.bind(clock);
    clock.track = (label, work) => {
      labels.push(label);
      return tracked(label, work);
    };
    const manager = new ResearchManager({
      clock,
      model: noModel,
      client: () =>
        Promise.resolve({
          where: "local",
          structured: () => Promise.resolve({ useful: 0.9, unknown: 0.9, answerable: 0.9 }),
        }),
      board: emptyBoard,
      logger: quiet,
      onRecord: () => {},
    });
    manager.acceptHook(hook());
    await clock.settle();
    expect(labels).toContain("research");
    expect(manager.queued()).toHaveLength(1);
  });

  it("stops scoring once stopped", async () => {
    const { manager, records } = harness();
    manager.stop();
    manager.acceptHook(hook());
    await manager.flush();
    expect(records).toEqual([]);
  });
});

describe("ResearchManager: the budget", () => {
  /** Four distinct questions, so nothing is deduplicated away. */
  const questions = [
    "What do Otter and Fireflies charge per seat?",
    "How long is the drive from Manchester to Edale?",
    "What does GDPR require for storing voice recordings?",
    "How much RAM does a 30B quantized model need on Apple Silicon?",
  ];

  function submit(manager: ResearchManager, count: number): void {
    for (let index = 0; index < count; index += 1) {
      manager.acceptHook(hook({ id: `cand-${index + 1}`, headline: questions[index]! }));
    }
  }

  it("runs at most two jobs at once", async () => {
    const { manager, started, finish } = harness({ jobs: "held" });
    submit(manager, 3);
    await tick();
    expect(started).toHaveLength(MAX_CONCURRENT_JOBS);
    expect(manager.running()).toBe(MAX_CONCURRENT_JOBS);
    expect(manager.queued()).toHaveLength(1);

    finish(started[0]!);
    await tick();
    expect(started).toHaveLength(3);
    expect(manager.queued()).toHaveLength(0);
  });

  it("starts at most three jobs in ten minutes, and the fourth when the window moves", async () => {
    const { clock, manager, started, records, finish } = harness({ jobs: "held" });
    submit(manager, 4);
    await tick();
    // Two run, the third waits for a slot, the fourth for the window.
    finish(started[0]!);
    await tick();
    finish(started[1]!);
    await tick();
    expect(started).toHaveLength(MAX_JOBS_PER_WINDOW);
    expect(manager.queued()).toHaveLength(1);
    expect(manager.startedInWindow()).toBe(MAX_JOBS_PER_WINDOW);

    finish(started[2]!);
    await tick();
    expect(started).toHaveLength(MAX_JOBS_PER_WINDOW);

    // Nothing arriving says the window has moved on, so a timer has to.
    // `settle()` is deliberately not used: a running job is tracked on the
    // clock (V2-013), so settling would wait for the held one forever.
    clock.advanceBy(RESEARCH_WINDOW_MS + 1);
    await tick();
    expect(started).toHaveLength(4);
    expect(manager.startedInWindow()).toBe(1);
    const starts = startRecords(records);
    expect(starts).toHaveLength(4);
    expect(starts[3]?.ideaId).toBe("idea-4");
    expect(starts[3]?.startedInWindow).toBe(1);
  });

  it("records what each start was up against", async () => {
    const { manager, records } = harness({ jobs: "held" });
    submit(manager, 2);
    await tick();
    const starts = startRecords(records);
    expect(starts.map((record) => record.running)).toEqual([1, 2]);
    expect(starts.map((record) => record.startedInWindow)).toEqual([1, 2]);
  });

  it("holds an approved idea in the queue when nothing runs jobs yet", async () => {
    const { manager, records } = harness({ jobs: "none" });
    submit(manager, 2);
    await manager.flush();
    expect(manager.queued().map((idea) => idea.id)).toEqual(["idea-1", "idea-2"]);
    expect(startRecords(records)).toEqual([]);
  });
});

describe("ResearchManager: the planner", () => {
  class PlannerModel implements ModelClient {
    readonly calls: StructuredCall[] = [];
    async grounded(): Promise<never> {
      throw new Error("unexpected grounded call");
    }
    async prose(): Promise<never> {
      throw new Error("unexpected prose call");
    }
    async structured(call: StructuredCall): Promise<unknown> {
      this.calls.push(call);
      return {
        ideas: [
          {
            topic: "venue capacity",
            question: "How many people does the Edale barn hold?",
            why: "the headcount is the thing the day hangs on",
            sourceTurnIds: ["0:1"],
          },
        ],
      };
    }
  }

  it("gates what the planner proposes, the same way a hook is gated", async () => {
    const model = new PlannerModel();
    const { clock, manager, records, started } = harness({ model });
    for (let index = 0; index < 4; index += 1) manager.acceptTurn(turn(index));
    clock.advanceBy(PLANNER_INTERVAL_MS);
    await clock.settle();
    await manager.flush();

    expect(model.calls).toHaveLength(1);
    const ideas = ideaRecords(records);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.origin).toBe("planner");
    expect(ideas[0]?.candidateId).toBeUndefined();
    expect(gateRecords(records)[0]?.decision).toBe("queued");
    expect(started).toEqual(["idea-1"]);
  });

  it("ignores Sotto's own lines: what Sotto said is not the group's need", async () => {
    const model = new PlannerModel();
    const { clock, manager } = harness({ model });
    for (let index = 0; index < 5; index += 1) {
      manager.acceptTurn({ ...turn(index), speaker: "Sotto", sotto: true });
    }
    clock.advanceBy(PLANNER_INTERVAL_MS * 2);
    await clock.settle();
    expect(model.calls).toHaveLength(0);
  });

  it("tells the planner what has already been thought of", async () => {
    const model = new PlannerModel();
    const { clock, manager } = harness({ model });
    manager.acceptHook(hook());
    await manager.flush();
    for (let index = 0; index < 4; index += 1) manager.acceptTurn(turn(index));
    clock.advanceBy(PLANNER_INTERVAL_MS);
    await clock.settle();
    expect(model.calls[0]?.user).toContain("Already being looked up");
    expect(model.calls[0]?.user).toContain(hook().headline);
  });
});

/**
 * Drains every pending microtask, so the gate queue runs to the end without
 * waiting for the jobs it started — which, in the budget tests, is the point:
 * a held job never finishes until the test says so.
 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A question as V3-002's classifier hands it over. */
function asked(overrides: Partial<Parameters<ResearchManager["acceptQuestion"]>[0]> = {}) {
  return {
    turnId: "0:12",
    question: "How long is the drive from the city to the farmhouse venue?",
    topic: "the drive time",
    askedBy: "Craig",
    askedAtMs: 12_000,
    ...overrides,
  };
}

describe("ResearchManager: the fast path from a question (V3-003)", () => {
  it("searches at once, with no gate call at all", async () => {
    const { manager, records, started, gateCalls } = harness();
    const result = manager.acceptQuestion(asked());
    await manager.flush();

    expect(result?.outcome).toBe("accepted");
    const ideas = ideaRecords(records);
    expect(ideas[0]?.origin).toBe("open_question");
    expect(ideas[0]?.idea.question).toBe(asked().question);
    expect(ideas[0]?.idea.topic).toBe("the drive time");
    expect(ideas[0]?.idea.askedAtMs).toBe(12_000);
    expect(ideas[0]?.idea.sourceTurnIds).toEqual(["0:12"]);
    // The whole point of the path: no judgment, because the classifier made it.
    expect(gateCalls).toEqual([]);
    expect(gateRecords(records)).toEqual([]);
    expect(records.map((record) => record.kind)).toEqual(["idea", "start"]);
    expect(started).toEqual(["idea-1"]);
  });

  it("still gates a hook beside it, which nobody is waiting for", async () => {
    const { manager, records, started, gateCalls } = harness();
    manager.acceptQuestion(asked());
    manager.acceptHook(hook());
    await manager.flush();

    expect(gateCalls).toHaveLength(1);
    expect(gateRecords(records).map((record) => record.ideaId)).toEqual(["idea-2"]);
    expect(started.sort()).toEqual(["idea-1", "idea-2"]);
  });

  it("spends the same budget the planner and the hooks do", async () => {
    const { manager, started, finish } = harness({ jobs: "held", extra: { maxConcurrent: 1 } });
    manager.acceptHook(hook());
    await tick();
    expect(started).toEqual(["idea-1"]);

    manager.acceptQuestion(asked());
    // One slot, already taken: the question waits rather than racing it.
    expect(started).toEqual(["idea-1"]);
    expect(manager.queued().map((one) => one.id)).toEqual(["idea-2"]);

    finish("idea-1");
    await tick();
    expect(started).toEqual(["idea-1", "idea-2"]);
  });

  it("goes ahead of a hook already waiting on the budget: the room is waiting for it", async () => {
    const { manager, started, finish } = harness({
      jobs: "held",
      extra: { maxConcurrent: 1 },
    });
    manager.acceptHook(hook());
    manager.acceptHook(hook({ id: "cand-2", headline: "What does a day rate at a farmhouse venue cost?" }));
    await tick();
    expect(started).toEqual(["idea-1"]);
    expect(manager.queued().map((one) => one.id)).toEqual(["idea-2"]);

    manager.acceptQuestion(asked());
    expect(manager.queued().map((one) => one.id)).toEqual(["idea-3", "idea-2"]);
    finish("idea-1");
    await tick();
    expect(started).toEqual(["idea-1", "idea-3"]);
  });

  it("answers a repeated question from the packet the first one found", async () => {
    const packet: ResearchPacket = {
      id: "packet-1",
      ideaId: "idea-1",
      title: "About two hours fifteen each way",
      teaser: "The farmhouse is 78 miles out; 2h15 off-peak.",
      keyPoints: ["78 miles, 2h15 off-peak"],
      spokenAnswer: "About two hours fifteen each way.",
      sources: [{ url: "https://example.com/route", title: "Route" }],
      createdAtMs: 30_000,
      latencyMs: 18_000,
    };
    const { manager, records, started } = harness({ extra: { packets: () => [packet] } });
    manager.acceptQuestion(asked());
    await manager.flush();
    expect(started).toEqual(["idea-1"]);

    const again = manager.acceptQuestion(
      asked({ turnId: "0:20", question: "How long is that drive from the city to the farmhouse?" }),
    );
    await manager.flush();

    expect(again?.outcome).toBe("reused");
    expect(again?.outcome === "reused" ? again.packet.id : null).toBe("packet-1");
    expect(ideaRecords(records)[1]?.duplicateOf).toBe("idea-1");
    // No second search, and no second idea in the session's memory.
    expect(started).toEqual(["idea-1"]);
    expect(manager.ideas()).toHaveLength(1);
  });

  it("stops at the dedupe while the first search is still running", async () => {
    const { manager, started } = harness({ jobs: "held" });
    manager.acceptQuestion(asked());
    await tick();
    const again = manager.acceptQuestion(asked({ turnId: "0:20" }));

    expect(again?.outcome).toBe("duplicate");
    expect(again?.outcome === "duplicate" ? again.duplicateOf : null).toBe("idea-1");
    expect(started).toEqual(["idea-1"]);
  });

  it("answers nothing once the session has stopped", () => {
    const { manager, started } = harness();
    manager.stop();
    expect(manager.acceptQuestion(asked())).toBeNull();
    expect(started).toEqual([]);
  });
});
