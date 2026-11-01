import { describe, expect, it } from "vitest";
import { emptyBoard, type Board } from "../../shared/board.js";
import {
  CANDIDATE_GATE_SCHEMA_NAME,
  type Candidate,
  type CandidateGateLogRecord,
} from "../../shared/candidates.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import { ModelCallError, type StructuredCall } from "../model/client.js";
import type { JudgmentClient, JudgmentWhere } from "../model/judgment.js";
import {
  CANDIDATE_GATE_MAX_TOKENS,
  CANDIDATE_GATE_TRACK_LABEL,
  CandidateGate,
  renderGateRequest,
} from "./CandidateGate.js";
import { candidateScore } from "./policy.js";

const observerScores = { relevance: 0.9, novelty: 0.9, importance: 0.9, confidence: 0.9 };

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "cand-1",
    type: "contradiction",
    headline: "The $20k studio doesn't fit the $4k first-version budget",
    detail: "They set four thousand for v1 and have just proposed twenty.",
    whyNow: "they are about to book it",
    evidenceTurnIds: ["0:4", "0:9"],
    relatedBoardItemIds: ["c1"],
    scores: observerScores,
    createdAtMs: 60_000,
    run: 2,
    evidence: [
      { turnId: "0:4", quote: "we have four thousand for the first version", speaker: "Craig" },
      { turnId: "0:9", quote: "let's book the twenty thousand studio", speaker: "EJ" },
    ],
    ...overrides,
  };
}

/** A judgment client that answers from a script. */
function judge(
  reply: () => Promise<unknown>,
  where: JudgmentWhere = "local",
): { client: JudgmentClient; calls: StructuredCall[] } {
  const calls: StructuredCall[] = [];
  return {
    calls,
    client: {
      where,
      structured: (call) => {
        calls.push(call);
        return reply();
      },
    },
  };
}

interface Harness {
  gate: CandidateGate;
  records: CandidateGateLogRecord[];
  scored: Candidate[];
  clock: SimulatedClock;
}

function gateFor(
  client: JudgmentClient | null,
  options: { mode?: "glimmer" | "spark"; turns?: TurnUpdate[]; board?: Board } = {},
): Harness {
  const records: CandidateGateLogRecord[] = [];
  const scored: Candidate[] = [];
  const clock = new SimulatedClock(0);
  const gate = new CandidateGate({
    clock,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    client: () => Promise.resolve(client),
    board: () => options.board ?? emptyBoard(),
    turns: () => options.turns ?? [],
    onRecord: (record) => records.push(record),
    onScored: (one) => scored.push(one),
    logger: { log: () => {}, warn: () => {} },
  });
  return { gate, records, scored, clock };
}

const verdict = { true: 0.8, new: 0.7, worthSaying: 0.6, stillRelevant: 0.5 };

describe("CandidateGate", () => {
  it("replaces the observer's scores with the gate's, and says who answered", async () => {
    const { client, calls } = judge(() => Promise.resolve(verdict));
    const { gate, records, scored } = gateFor(client);
    gate.accept(candidate());
    await gate.flush();

    expect(scored).toHaveLength(1);
    expect(scored[0]?.scores).toEqual({
      confidence: 0.8,
      novelty: 0.7,
      importance: 0.6,
      relevance: 0.5,
    });
    // The observer's own four are kept, never thrown away.
    expect(scored[0]?.observerScores).toEqual(observerScores);
    expect(scored[0]?.gate?.gate).toBe("glimmer");
    expect(scored[0]?.gate?.scores).toEqual(verdict);
    expect(calls[0]?.schemaName).toBe(CANDIDATE_GATE_SCHEMA_NAME);
    expect(calls[0]?.maxTokens).toBe(CANDIDATE_GATE_MAX_TOKENS);
    // The moment is passing while this is thought about.
    expect(calls[0]?.reasoningEffort).toBe("low");

    const record = records[0];
    expect(record?.kind).toBe("gate");
    expect(record?.candidateId).toBe("cand-1");
    expect(record?.type).toBe("contradiction");
    expect(record?.gate).toBe("glimmer");
    expect(record?.observerScores).toEqual(observerScores);
    expect(record?.gateScores).toEqual(verdict);
    expect(record?.score).toBeCloseTo(candidateScore(scored[0]!.scores));
    expect(record?.error).toBeUndefined();
  });

  it("records a cloud answer as the fallback it is (V2-010)", async () => {
    const { client } = judge(() => Promise.resolve(verdict), "cloud");
    const { gate, records, scored } = gateFor(client);
    gate.accept(candidate());
    await gate.flush();
    expect(records[0]?.gate).toBe("spark-fallback");
    expect(scored[0]?.gate?.gate).toBe("spark-fallback");
  });

  it("keeps the observer's scores when the call fails: no gate must not mean no speech", async () => {
    const { client } = judge(() => Promise.reject(new ModelCallError("truncated")));
    const { gate, records, scored } = gateFor(client);
    gate.accept(candidate());
    await gate.flush();

    expect(scored).toHaveLength(1);
    expect(scored[0]?.scores).toEqual(observerScores);
    expect(scored[0]?.gate).toBeUndefined();
    expect(records[0]?.gate).toBe("glimmer");
    expect(records[0]?.gateScores).toBeUndefined();
    expect(records[0]?.scores).toEqual(observerScores);
    expect(records[0]?.error).toContain("truncated");
  });

  it("keeps them when a reply does not fit the schema", async () => {
    const { client } = judge(() => Promise.resolve({ true: 0.8, new: 0.7 }));
    const { gate, records, scored } = gateFor(client);
    gate.accept(candidate());
    await gate.flush();
    expect(scored[0]?.scores).toEqual(observerScores);
    expect(records[0]?.error).toContain("did not match the schema");
  });

  it("keeps them when there is no model to ask at all", async () => {
    const { gate, records, scored } = gateFor(null);
    gate.accept(candidate());
    await gate.flush();
    expect(scored[0]?.scores).toEqual(observerScores);
    expect(records[0]?.gate).toBeNull();
    expect(records[0]?.error).toContain("no model");
  });

  it("makes no call at all in spark mode, and hands the candidate straight on", async () => {
    const { client, calls } = judge(() => Promise.resolve(verdict));
    const { gate, records, scored } = gateFor(client, { mode: "spark" });
    const one = candidate();
    gate.accept(one);
    // Synchronously: not gating costs the candidate nothing.
    expect(scored).toEqual([one]);
    await gate.flush();
    expect(calls).toHaveLength(0);
    expect(records).toHaveLength(0);
    expect(gate.calls()).toBe(0);
  });

  it("scores candidates concurrently and waits for all of them in flush", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const { client } = judge(async () => {
      if (first) {
        first = false;
        await held;
      }
      return verdict;
    });
    const { gate, scored } = gateFor(client);
    gate.accept(candidate({ id: "cand-1" }));
    gate.accept(candidate({ id: "cand-2" }));
    expect(gate.pending()).toBe(2);
    // The second was not held up behind the first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scored.map((one) => one.id)).toEqual(["cand-2"]);
    release?.();
    await gate.flush();
    expect(scored.map((one) => one.id)).toEqual(["cand-2", "cand-1"]);
    expect(gate.calls()).toBe(2);
  });

  it("registers the call on the clock, so a max replay stops for it", async () => {
    const { client } = judge(() => Promise.resolve(verdict));
    const { gate, clock, scored } = gateFor(client);
    gate.accept(candidate());
    expect(clock.inFlight()).toContain(CANDIDATE_GATE_TRACK_LABEL);
    await clock.settle();
    expect(scored).toHaveLength(1);
  });

  it("stops handing candidates on once the session has gone", async () => {
    const { client } = judge(() => Promise.resolve(verdict));
    const { gate, records, scored } = gateFor(client);
    gate.accept(candidate());
    gate.stop();
    await gate.flush();
    // The record is still written: the call happened and was paid for.
    expect(records).toHaveLength(1);
    expect(scored).toHaveLength(0);
    gate.accept(candidate({ id: "cand-2" }));
    expect(gate.pending()).toBe(0);
  });
});

describe("renderGateRequest", () => {
  it("leads with the quotes the point rests on, and asks for the four numbers", () => {
    const text = renderGateRequest(emptyBoard(), [], candidate());
    expect(text).toContain("## What the point rests on");
    expect(text).toContain("Craig: we have four thousand for the first version");
    expect(text).toContain("Kind: contradiction");
    expect(text).toContain("The $20k studio");
    expect(text).toContain("four probabilities");
    // No turn ids: the gate answers about the point, not about a turn.
    expect(text).not.toContain("0:4");
  });

  it("says so when nothing was cited, which is itself a reason to doubt it", () => {
    const text = renderGateRequest(emptyBoard(), [], candidate({ evidence: [] }));
    expect(text).toContain("_nothing was cited");
  });

  it("includes the board and the last few turns", () => {
    const board: Board = {
      ...emptyBoard(),
      summary: "costing the first version",
      constraints: [
        {
          id: "c1",
          text: "four thousand for v1",
          status: "open",
          sourceTurnIds: ["0:4"],
          createdAtMs: 40_000,
          updatedAtMs: 40_000,
        },
      ],
    };
    const turns: TurnUpdate[] = [
      {
        turnId: "0:9",
        startMs: 60_000,
        endMs: 63_000,
        text: "let's book the twenty thousand studio",
        final: true,
        speaker: "EJ",
        speakerMappingUncertain: false,
      },
    ];
    const text = renderGateRequest(board, turns, candidate());
    expect(text).toContain("costing the first version");
    expect(text).toContain("- four thousand for v1");
    expect(text).toContain("EJ: let's book the twenty thousand studio");
  });
});
