/**
 * V3-013's words and matching, which are pure: what a read-back says, and
 * which of the room's unsettled questions goes with which decision.
 */
import { describe, expect, it } from "vitest";
import type { Candidate } from "../../shared/candidates.js";
import {
  attachmentFor,
  decisionId,
  decisionNote,
  decisionRelevance,
  groupAttachedLine,
  ownAttachedLine,
  readBackLine,
  DECISION_RELEVANCE,
  GROUP_ATTACHMENT_TYPES,
  OWN_ATTACHMENT_TYPES,
} from "./readback.js";

/** A candidate as the observer produces one, with only what matters here. */
function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: "cand-1",
    type: "unanswered_question",
    headline: "Before six sheds: what if only one association signs?",
    detail: "",
    whyNow: "They are about to send the agreements out.",
    scores: { confidence: 0.8, novelty: 0.8, importance: 0.8, relevance: 0.8 },
    evidenceTurnIds: ["0:13"],
    relatedBoardItemIds: [],
    evidence: [
      {
        turnId: "0:13",
        quote: "What if only one of them actually signs the agreement when it lands?",
        speaker: "EJ",
      },
    ],
    createdAtMs: 1_000,
    run: 1,
    ...over,
  } as Candidate;
}

describe("readback: the words", () => {
  it("says the decision back in the scribe's voice", () => {
    expect(readBackLine("six sheds, Saturday")).toBe("Got it: six sheds, Saturday.");
    expect(readBackLine("  six sheds.  ")).toBe("Got it: six sheds.");
    expect(readBackLine("")).toBe("");
  });

  it("quotes the group's own question rather than paraphrasing it", () => {
    expect(groupAttachedLine("six sheds", candidate(), "EJ")).toBe(
      "Got it: six sheds. EJ asked, What if only one of them actually signs the agreement when" +
        " it lands. Did that get settled?",
    );
  });

  it("names nobody it cannot name", () => {
    expect(groupAttachedLine("six sheds", candidate(), null)).toContain("Somebody asked,");
  });

  it("takes the question out of a longer turn", () => {
    const quoted = groupAttachedLine(
      "six sheds",
      candidate({
        evidence: [
          {
            turnId: "0:13",
            quote: "Good question. And are we sure six will even sign up? Anyway, the adapters.",
            speaker: "Craig",
          },
        ],
      }),
      "Craig",
    );
    expect(quoted).toContain("Craig asked, And are we sure six will even sign up. Did that get");
    expect(quoted).not.toContain("adapters");
  });

  it("falls back to the headline when no quote survived", () => {
    const line = groupAttachedLine("six sheds", candidate({ evidence: [] }), "EJ");
    expect(line).toBe(
      "Got it: six sheds. One thing nobody settled: Before six sheds: what if only one" +
        " association signs?",
    );
  });

  it("puts one of Sotto's own questions straight after the read-back", () => {
    expect(
      ownAttachedLine(
        "Saturday the fourteenth",
        candidate({ type: "contradiction", headline: "What about the 1400 ceiling" }),
      ),
    ).toBe("Got it: Saturday the fourteenth. What about the 1400 ceiling?");
  });

  it("names the card's line and the id the log uses", () => {
    expect(decisionNote("six sheds")).toBe('Still open against "six sheds"');
    expect(decisionId("0:20")).toBe("decision-0:20");
  });
});

describe("readback: which candidate goes with which decision", () => {
  it("splits the five types the way V3-008 does", () => {
    expect(GROUP_ATTACHMENT_TYPES).toEqual(["dropped_thread", "unanswered_question"]);
    expect(OWN_ATTACHMENT_TYPES).toEqual(["contradiction", "untested_assumption"]);
    expect(attachmentFor("unanswered_question")).toBe("group");
    expect(attachmentFor("contradiction")).toBe("own");
    // A wrong number has its own route to the room's ears (V3-008), and a
    // hook never reaches the policy at all (V2-011).
    expect(attachmentFor("factual_error")).toBeNull();
    expect(attachmentFor("research_hook")).toBeNull();
  });

  it("scores a candidate about the decision above the threshold", () => {
    expect(decisionRelevance("six sheds, one per association", candidate())).toBeGreaterThanOrEqual(
      DECISION_RELEVANCE,
    );
  });

  it("scores a candidate about something else at nothing", () => {
    const elsewhere = candidate({
      headline: "Who is bringing the coffee urn?",
      whyNow: "Nobody said.",
      evidence: [{ turnId: "0:3", quote: "And somebody has to bring an urn.", speaker: "EJ" }],
    });
    expect(decisionRelevance("six sheds, one per association", elsewhere)).toBeLessThan(
      DECISION_RELEVANCE,
    );
  });

  it("matches on stems, so sheds and shed are the same word", () => {
    expect(decisionRelevance("six sheds", candidate({ headline: "Only one shed signed up?" })))
      .toBeGreaterThanOrEqual(DECISION_RELEVANCE);
  });

  it("is nothing for a decision with no words of its own", () => {
    expect(decisionRelevance("so", candidate())).toBe(0);
    // A date and a count say when and how many, not what, so a decision made
    // of nothing else has nothing to match on.
    expect(decisionRelevance("Saturday the 14th", candidate())).toBe(0);
  });

  /**
   * The pair the real model produced on `decision-closings`, verbatim. One
   * shared word of the three that mean anything — and the two words that do
   * not ("Saturday", "the 14th") would have halved it.
   */
  it("matches the real observer's question to the real decision", () => {
    const mechanic = candidate({
      type: "contradiction",
      headline: "The bike mechanic — where does that fit with $1400 and nothing on top?",
      whyNow: "the launch costs are being agreed",
      evidence: [{ turnId: "0:7", quote: "He wants 300 for the day.", speaker: "Craig" }],
    });
    expect(
      decisionRelevance("Saturday the 14th, mechanic and coffee cart", mechanic),
    ).toBeGreaterThanOrEqual(DECISION_RELEVANCE);
    // And it is not about the next decision, two minutes later.
    expect(decisionRelevance("paper sheets, type up monthly", mechanic)).toBeLessThan(
      DECISION_RELEVANCE,
    );
  });
});
