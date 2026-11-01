import { describe, expect, it } from "vitest";
import type { Board, Item } from "../../shared/board.js";
import type { AnswerLogRecord } from "../../shared/answers.js";
import type {
  Candidate,
  CandidateLogRecord,
  DecisionLogRecord,
  VerificationLogRecord,
} from "../../shared/candidates.js";
import type { ResearchPacketRecord } from "../../shared/research.js";
import {
  DIGEST_SECTIONS,
  MAX_SUPPRESSED,
  NOTHING,
  NOTHING_TO_WRAP_UP,
  SessionDigest,
  asksForWrapUp,
} from "./digest.js";

function item(id: string, text: string, status: Item["status"] = "open"): Item {
  return { id, text, status, sourceTurnIds: ["s:1"], createdAtMs: 0, updatedAtMs: 0 };
}

function board(overrides: Partial<Board> = {}): Board {
  return {
    summary: "The team is planning the autumn offsite.",
    constraints: [],
    points: [],
    questions: [item("q1", "Who's handling food?")],
    decisions: [item("d1", "Thursday is the day")],
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "cand-1",
    type: "contradiction",
    headline: "Alex can't do Thursday at all",
    detail: "Earlier Alex was free Thursday afternoon.",
    whyNow: "The day is being locked in",
    evidenceTurnIds: ["s:4"],
    relatedBoardItemIds: ["d1"],
    scores: { relevance: 1, novelty: 1, importance: 0.8, confidence: 0.9 },
    createdAtMs: 1_000,
    run: 1,
    evidence: [],
    ...overrides,
  };
}

function candidateLine(value: Candidate): CandidateLogRecord {
  return { kind: "candidate", atMs: value.createdAtMs, candidate: value };
}

function decision(overrides: Partial<DecisionLogRecord>): DecisionLogRecord {
  return {
    kind: "decision",
    atMs: 2_000,
    candidateId: "cand-1",
    headline: "Alex can't do Thursday at all",
    type: "contradiction",
    decision: "silent",
    reason: "below_threshold",
    score: 0.4,
    level: "silent",
    thresholds: { glow: 0.5, interject: 0.7 },
    settings: { frequency: "normal", boldness: "normal" },
    limits: { cooldownMs: 180_000, maxInterjectsPerWindow: 3, researchCardCooldownMs: 60_000, maxResearchCardsPerWindow: 4 },
    heldForMs: 0,
    turnsWaited: 0,
    ...overrides,
  };
}

function answer(overrides: Partial<AnswerLogRecord> = {}): AnswerLogRecord {
  return {
    kind: "answer",
    turnId: "s:9",
    id: "ans-1",
    question: "what's the drive time to the coast?",
    askedBy: "Craig",
    headline: "About ninety minutes each way",
    detailMd: "Traffic on a Friday afternoon adds twenty.",
    citations: [],
    artifacts: [],
    status: "done",
    createdAtMs: 5_000,
    latencyMs: 12_000,
    spokenText: "It's about ninety minutes each way, a bit more on a Friday.",
    ackMs: 300,
    firstAudioMs: 2_000,
    firstLineMs: null,
    continuationMs: null,
    packetIds: [],
    usedPacketIds: [],
    ...overrides,
  };
}

function packetLine(overrides: Partial<ResearchPacketRecord> = {}): ResearchPacketRecord {
  return {
    kind: "packet",
    atMs: 7_000,
    ideaId: "idea-1",
    question: "What venues near the coast take twenty people in October?",
    outcome: "ready",
    packet: {
      id: "packet-1",
      ideaId: "idea-1",
      title: "Three coastal venues take twenty in October",
      teaser: "Two have midweek availability; one needs a minimum spend.",
      keyPoints: ["The Boathouse: £40 a head midweek"],
      sources: [{ title: "The Boathouse", url: "https://example.com/boathouse" }],
      createdAtMs: 7_000,
      latencyMs: 15_000,
    },
    latencyMs: 15_000,
    searched: true,
    ...overrides,
  };
}

/** A job that came back with nothing to show: no packet at all. */
function unfinished(overrides: Partial<ResearchPacketRecord>): ResearchPacketRecord {
  const { packet: _packet, ...rest } = packetLine();
  return { ...rest, ...overrides };
}

describe("digest.md (V2-018)", () => {
  it("writes all seven sections, even for a session that produced nothing", () => {
    const markdown = new SessionDigest().render();
    for (const section of DIGEST_SECTIONS) expect(markdown).toContain(`## ${section}`);
    expect(markdown.match(new RegExp(NOTHING, "g"))).toHaveLength(DIGEST_SECTIONS.length);
  });

  it("takes the summary, the decisions and the open questions off the board", () => {
    const digest = new SessionDigest();
    digest.board(
      board({
        questions: [item("q1", "Who's handling food?"), item("q2", "Answered one", "covered")],
        decisions: [item("d1", "Thursday is the day"), item("d2", "Gone", "dropped")],
      }),
    );
    const markdown = digest.render();
    expect(markdown).toContain("The team is planning the autumn offsite.");
    expect(markdown).toContain("- Thursday is the day");
    expect(markdown).not.toContain("- Gone");
    expect(markdown).toContain("- Who's handling food?");
    expect(markdown).not.toContain("Answered one");
  });

  it("lists what Sotto said, with who asked and the interrupted ones marked", () => {
    const digest = new SessionDigest();
    digest.answer(answer());
    digest.answer(
      answer({
        id: "ans-2",
        question: "what did you find on venues?",
        spokenText: "Yes, I looked into that. Three places take twenty.",
        spokenSoFar: "Yes, I looked into that.",
        usedPacketIds: ["packet-1"],
      }),
    );
    const markdown = digest.render();
    expect(markdown).toContain("“what's the drive time to the coast?” — asked by Craig");
    expect(markdown).toContain("It's about ninety minutes each way");
    expect(markdown).toContain("_Briefed from packet-1._");
    expect(markdown).toContain("Yes, I looked into that. _(interrupted)_");
  });

  it("counts a rewritten answer record once", () => {
    const digest = new SessionDigest();
    digest.answer(answer({ status: "thinking", headline: "" }));
    digest.answer(answer());
    expect(digest.input().spoken).toHaveLength(1);
  });

  it("separates what reached the stage from what was held back, with reasons", () => {
    const digest = new SessionDigest();
    const said = candidate({ id: "cand-1" });
    const held = candidate({ id: "cand-2", headline: "Nobody has checked the venue's capacity", type: "untested_assumption" });
    digest.candidate(candidateLine(said));
    digest.candidate(candidateLine(held));
    digest.candidate(decision({ candidateId: "cand-1", decision: "interject", reason: "delivered", score: 0.82 }));
    digest.candidate(decision({ candidateId: "cand-2", decision: "silent", reason: "cooldown", score: 0.61 }));
    const markdown = digest.render();
    expect(markdown).toContain("- **Alex can't do Thursday at all** — Earlier Alex was free Thursday afternoon.");
    expect(markdown).toContain("(contradiction, interject, score 0.82)");
    expect(markdown).toContain("- **Nobody has checked the venue's capacity** — cooldown _(untested assumption, score 0.61)_");
    expect(digest.input().suppressed).toHaveLength(1);
    expect(digest.input().delivered).toHaveLength(1);
  });

  it("keeps the five best held-back candidates, highest score first", () => {
    const digest = new SessionDigest();
    for (let index = 1; index <= MAX_SUPPRESSED + 2; index += 1) {
      const id = `cand-${index}`;
      digest.candidate(candidateLine(candidate({ id, headline: `Point ${index}` })));
      digest.candidate(decision({ candidateId: id, score: index / 10 }));
    }
    const held = digest.input().suppressed;
    expect(held).toHaveLength(MAX_SUPPRESSED);
    expect(held.map((one) => one.headline)).toEqual(["Point 7", "Point 6", "Point 5", "Point 4", "Point 3"]);
  });

  it("explains a candidate the policy never saw, and never calls a hook one", () => {
    const digest = new SessionDigest();
    const checked = candidate({ id: "cand-1", type: "factual_error", headline: "The ferry runs hourly" });
    const duplicate = candidate({ id: "cand-2", duplicateOf: "cand-1" });
    const hook = candidate({ id: "cand-3", type: "research_hook", headline: "What do venues charge?" });
    for (const value of [checked, duplicate, hook]) digest.candidate(candidateLine(value));
    const check: VerificationLogRecord = {
      kind: "verification", atMs: 3_000, candidateId: "cand-1",
      headline: "The ferry runs hourly", outcome: "unverified",
    };
    digest.candidate(check);
    const held = digest.input().suppressed;
    expect(held.map((one) => one.reason)).toEqual([
      "checked against the web and not wrong",
      "duplicate of cand-1",
    ]);
    // The observer's own four scores, since nothing else ever scored it.
    expect(held[0]?.score).toBeCloseTo(0.72, 5);
  });

  it("lists the research that produced a sourced packet, and counts what was thrown away", () => {
    const digest = new SessionDigest();
    digest.research(packetLine());
    digest.research(unfinished({ outcome: "unsourced", title: "Nothing to follow" }));
    digest.research(unfinished({ outcome: "failed", error: "timed out" }));
    const markdown = digest.render();
    expect(markdown).toContain("### Three coastal venues take twenty in October");
    expect(markdown).toContain("Two have midweek availability");
    expect(markdown).toContain("- [The Boathouse](https://example.com/boathouse)");
    expect(markdown).toContain("_Discarded: 1 search(es)");
    expect(digest.input().packets).toHaveLength(1);
  });
});

describe("the spoken wrap-up (V2-018)", () => {
  it("says there is nothing yet when the board is empty", () => {
    expect(new SessionDigest().spokenSummary()).toBe(NOTHING_TO_WRAP_UP);
  });

  it("speaks the decisions, the open questions and the research, without markdown", () => {
    const digest = new SessionDigest();
    digest.board(
      board({
        decisions: [item("d1", "Thursday is the day"), item("d2", "The coast, not the city.")],
        questions: [item("q1", "Who's handling food?")],
      }),
    );
    digest.research(packetLine());
    const spoken = digest.spokenSummary();
    expect(spoken).toContain("Here's where we got to.");
    expect(spoken).toContain("You decided two things: Thursday is the day, and The coast, not the city.");
    expect(spoken).toContain("One question is still open: Who's handling food?");
    expect(spoken).toContain("I also did some digging. Three coastal venues take twenty in October.");
    expect(spoken).not.toMatch(/[*_#[\]]|http/);
  });

  it("falls back to the summary alone when the board has no lists", () => {
    const digest = new SessionDigest();
    digest.board(board({ decisions: [], questions: [] }));
    expect(digest.spokenSummary()).toBe(
      "Here's where we got to. The team is planning the autumn offsite.",
    );
  });
});

describe("asking for a wrap-up", () => {
  it("hears the ways a group asks for one", () => {
    for (const asked of [
      "wrap us up",
      "wrap up where we got to",
      "can you wrap this up for us",
      "sum it up for us",
      "give us a recap",
      "summarise what we decided",
      "where did we get to",
    ]) {
      expect(asksForWrapUp(asked), asked).toBe(true);
    }
  });

  it("leaves an ordinary question to the answer agent", () => {
    for (const asked of [
      "what do the main competitors charge per month?",
      "what did we decide about the venue?",
      "can you list what depends on what here, so we know what to lock first?",
      "what did you find on competitors?",
    ]) {
      expect(asksForWrapUp(asked), asked).toBe(false);
    }
  });
});
