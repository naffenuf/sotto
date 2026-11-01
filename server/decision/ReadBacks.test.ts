/**
 * V3-013's rationing and matching on a simulated clock: what a closing
 * decision picks up, what it pins to the stage, and the two limits.
 */
import { describe, expect, it } from "vitest";
import type { Candidate, CandidateType } from "../../shared/candidates.js";
import { SimulatedClock } from "../clock.js";
import type { DecisionClosing } from "../question/question.js";
import type { SpokenContributionRecord } from "../question/Reservations.js";
import { ReadBacks } from "./ReadBacks.js";
import {
  ATTACHED_COOLDOWN_MS,
  READBACK_COOLDOWN_MS,
  type ReadBackRequest,
} from "./readback.js";

const quiet = { log: () => {}, warn: () => {} };

interface Harness {
  clock: SimulatedClock;
  readBacks: ReadBacks;
  spoken: ReadBackRequest[];
  pinned: { candidateId: string; decision: string }[];
  timing: Record<string, unknown>[];
  /** What the room heard, as `Reservations` reports it back. */
  heard: (request: ReadBackRequest, atMs?: number) => void;
}

function setup(): Harness {
  const clock = new SimulatedClock(0);
  const spoken: ReadBackRequest[] = [];
  const pinned: { candidateId: string; decision: string }[] = [];
  const timing: Record<string, unknown>[] = [];
  const readBacks = new ReadBacks({
    clock,
    speak: (request) => spoken.push(request),
    pinCard: (candidateId, decision) => pinned.push({ candidateId, decision }),
    onTiming: (record) => timing.push(record),
    logger: quiet,
  });
  return {
    clock,
    readBacks,
    spoken,
    pinned,
    timing,
    heard: (request, atMs = clock.now()) => {
      const record: SpokenContributionRecord = {
        stage: "spoken_contribution",
        kind: "readback",
        atMs,
        ideaId: request.id,
        turnId: request.turnId,
        topic: request.decision,
        spoken: true,
        text: request.text,
        attached: request.attached,
      };
      readBacks.observe(record);
    },
  };
}

function candidate(type: CandidateType, over: Partial<Candidate> = {}): Candidate {
  return {
    id: "cand-1",
    type,
    headline: "Before six sheds: what if only one association signs?",
    detail: "",
    whyNow: "They are about to send the agreements out.",
    scores: { confidence: 0.8, novelty: 0.8, importance: 0.8, relevance: 0.8 },
    evidenceTurnIds: ["0:13"],
    relatedBoardItemIds: [],
    evidence: [
      { turnId: "0:13", quote: "What if only one of them actually signs?", speaker: "EJ" },
    ],
    createdAtMs: 1_000,
    run: 1,
    ...over,
  } as Candidate;
}

function closing(over: Partial<DecisionClosing> = {}): DecisionClosing {
  return {
    turnId: "0:20",
    decision: "six sheds, one per association",
    decidedBy: "Craig",
    decidedAtMs: 100_000,
    ...over,
  };
}

describe("ReadBacks", () => {
  it("reads a decision back bare when nothing relates to it", () => {
    const harness = setup();
    harness.readBacks.closing(closing());
    expect(harness.spoken).toHaveLength(1);
    expect(harness.spoken[0]).toMatchObject({
      id: "decision-0:20",
      turnId: "0:20",
      attached: null,
      candidateId: null,
      text: "Got it: six sheds, one per association.",
    });
    expect(harness.pinned).toEqual([]);
    expect(harness.timing[0]).toMatchObject({
      stage: "decision_closing", found: null, attached: null,
    });
  });

  it("carries the room's own unanswered question, quoted", () => {
    const harness = setup();
    harness.readBacks.accept(candidate("unanswered_question"));
    harness.readBacks.closing(closing());
    expect(harness.spoken[0]).toMatchObject({ attached: "group", candidateId: "cand-1" });
    expect(harness.spoken[0]?.text).toContain("EJ asked, What if only one of them actually signs");
    expect(harness.spoken[0]?.bareText).toBe("Got it: six sheds, one per association.");
    // Said out loud, so nothing is pinned: the quote *is* the contribution.
    expect(harness.pinned).toEqual([]);
  });

  it("pins one of Sotto's own corrections to the stage instead", () => {
    const harness = setup();
    harness.readBacks.accept(candidate("contradiction"));
    harness.readBacks.closing(closing());
    expect(harness.pinned).toEqual([
      { candidateId: "cand-1", decision: "six sheds, one per association" },
    ]);
    // The line is composed for a `bold` session; `Reservations` degrades it
    // to the bare read-back at anything else.
    expect(harness.spoken[0]).toMatchObject({ attached: "own" });
    expect(harness.spoken[0]?.text).toContain("Before six sheds");
  });

  it("ignores a type that is nobody's business here", () => {
    const harness = setup();
    harness.readBacks.accept(candidate("factual_error"));
    harness.readBacks.accept(candidate("research_hook", { id: "cand-2" }));
    harness.readBacks.closing(closing());
    expect(harness.spoken[0]).toMatchObject({ attached: null });
  });

  it("prefers the room's own question to Sotto's reading of it", () => {
    const harness = setup();
    harness.readBacks.accept(candidate("contradiction", { id: "cand-own" }));
    harness.readBacks.accept(candidate("dropped_thread", { id: "cand-group" }));
    harness.readBacks.closing(closing());
    expect(harness.spoken[0]).toMatchObject({ attached: "group", candidateId: "cand-group" });
  });

  it("attaches one candidate once, however many decisions follow", () => {
    const harness = setup();
    harness.readBacks.accept(candidate("unanswered_question"));
    harness.readBacks.closing(closing());
    harness.clock.advanceBy(READBACK_COOLDOWN_MS);
    harness.readBacks.closing(closing({ turnId: "0:25", decidedAtMs: 400_000 }));
    expect(harness.spoken[1]).toMatchObject({ attached: null, candidateId: null });
  });

  it("leaves a decision with no words of its own alone", () => {
    const harness = setup();
    harness.readBacks.closing(closing({ decision: "   " }));
    expect(harness.spoken).toEqual([]);
    expect(harness.timing).toEqual([]);
  });

  it("reads nothing back for five minutes after one the room heard", () => {
    const harness = setup();
    harness.readBacks.closing(closing());
    harness.heard(harness.spoken[0] as ReadBackRequest);
    harness.clock.advanceBy(READBACK_COOLDOWN_MS - 1);
    harness.readBacks.closing(closing({ turnId: "0:25", decidedAtMs: 200_000 }));
    expect(harness.spoken).toHaveLength(1);
    expect(harness.timing[1]).toMatchObject({ skipped: "readback_limit" });

    harness.clock.advanceBy(1);
    harness.readBacks.closing(closing({ turnId: "0:31", decidedAtMs: 400_000 }));
    expect(harness.spoken).toHaveLength(2);
  });

  it("spends neither window on a read-back nothing could say", () => {
    const harness = setup();
    harness.readBacks.accept(candidate("unanswered_question"));
    harness.readBacks.closing(closing());
    harness.readBacks.observe({
      stage: "spoken_contribution",
      kind: "readback",
      atMs: harness.clock.now(),
      ideaId: "decision-0:20",
      turnId: "0:20",
      topic: "six sheds",
      spoken: false,
      text: "Got it: six sheds.",
      attached: "group",
      reason: "unheard",
    });
    harness.readBacks.accept(candidate("dropped_thread", { id: "cand-2" }));
    harness.readBacks.closing(closing({ turnId: "0:25", decidedAtMs: 110_000 }));
    expect(harness.spoken[1]).toMatchObject({ attached: "group", candidateId: "cand-2" });
  });

  it("keeps the read-back and drops the question inside the ten minutes", () => {
    const harness = setup();
    harness.readBacks.accept(candidate("unanswered_question"));
    harness.readBacks.closing(closing());
    harness.heard(harness.spoken[0] as ReadBackRequest);

    // Past the read-back limit but inside the attachment's: the decision is
    // still said back, with nothing on it.
    harness.clock.advanceBy(READBACK_COOLDOWN_MS + 1_000);
    harness.readBacks.accept(candidate("dropped_thread", { id: "cand-2" }));
    harness.readBacks.closing(closing({ turnId: "0:40", decidedAtMs: 420_000 }));
    expect(harness.spoken[1]).toMatchObject({
      attached: null,
      text: "Got it: six sheds, one per association.",
    });
    expect(harness.timing[1]).toMatchObject({ found: "group", degraded: "attached_limit" });

    expect(ATTACHED_COOLDOWN_MS).toBe(2 * READBACK_COOLDOWN_MS);
  });

  it("stops with the session", () => {
    const harness = setup();
    harness.readBacks.stop();
    harness.readBacks.accept(candidate("unanswered_question"));
    harness.readBacks.closing(closing());
    expect(harness.spoken).toEqual([]);
  });
});
