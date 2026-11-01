import { describe, expect, it } from "vitest";
import type { Candidate } from "../../shared/candidates.js";
import { FREQUENCY_LIMITS, type PolicyDecision } from "../../shared/policy.js";
import { cardForInterjection, deliveredCardId } from "./delivery.js";
import type { Interjection } from "./InterjectionPolicy.js";

const decision: PolicyDecision = {
  decision: "interject",
  reason: "delivered",
  score: 0.72,
  level: "interject",
  thresholds: { glow: 0.35, interject: 0.6 },
  limits: FREQUENCY_LIMITS.normal,
  settings: { frequency: "normal", boldness: "normal" },
};

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: "cand-3",
    createdAtMs: 41_000,
    run: 2,
    type: "contradiction",
    headline: "A $12 solo tier does not fit the $4,000 a month floor",
    detail: "At $12 a seat you need 333 paying solos to clear the floor.",
    whyNow: "the price is about to be written down",
    evidenceTurnIds: ["0:4", "0:11"],
    relatedBoardItemIds: ["c1"],
    scores: { relevance: 0.9, novelty: 0.8, importance: 0.9, confidence: 0.9 },
    evidence: [
      { turnId: "0:4", quote: "We can't go below four thousand a month.", speaker: "A" },
      { turnId: "0:11", quote: "So solo is twelve dollars, done.", speaker: "B" },
    ],
    ...over,
  };
}

function interjection(over: Partial<Interjection> = {}): Interjection {
  return { candidate: candidate(), level: "interject", decision, atMs: 52_000, ...over };
}

describe("cardForInterjection", () => {
  it("lays an interjection out as a ready interject card", () => {
    const card = cardForInterjection(interjection());

    expect(card).toEqual({
      id: "card-cand-3",
      variant: "interject",
      state: "ready",
      createdAtMs: 52_000,
      headline: "A $12 solo tier does not fit the $4,000 a month floor",
      // V3-008: Sotto is holding this and not saying it, which is what
      // V3-017's raised hand counts.
      raised: true,
      whyNow: "the price is about to be written down",
      detailMd: "At $12 a seat you need 333 paying solos to clear the floor.",
      evidence: [
        { turnId: "0:4", quote: "We can't go below four thousand a month.", speaker: "A" },
        { turnId: "0:11", quote: "So solo is twelve dollars, done.", speaker: "B" },
      ],
    });
    expect(card.id).toBe(deliveredCardId("cand-3"));
  });

  it("makes the level the variant and changes nothing else", () => {
    const full = cardForInterjection(interjection());
    const glow = cardForInterjection(interjection({ level: "glow" }));

    // A glow the reader opens has to be exactly the card an interjection
    // would have been, so only the variant may differ.
    expect(glow).toEqual({ ...full, variant: "glow" });
  });

  it("attributes the quotes to whoever the group has named", () => {
    const card = cardForInterjection(interjection(), { A: "Craig", B: "Dana" });

    expect(card.evidence?.map((one) => one.speaker)).toEqual(["Craig", "Dana"]);
    // The quotes themselves are untouched.
    expect(card.evidence?.map((one) => one.quote)).toEqual([
      "We can't go below four thousand a month.",
      "So solo is twelve dollars, done.",
    ]);
  });

  it("leaves a label alone when nobody has named it, and a quote with no speaker as it is", () => {
    const card = cardForInterjection(
      interjection({
        candidate: candidate({
          evidence: [
            { turnId: "0:4", quote: "Four thousand is the floor.", speaker: "A" },
            { turnId: "0:7", quote: "Nobody knows yet." },
          ],
        }),
      }),
      { B: "Dana" },
    );

    expect(card.evidence).toEqual([
      { turnId: "0:4", quote: "Four thousand is the floor.", speaker: "A" },
      { turnId: "0:7", quote: "Nobody knows yet." },
    ]);
  });

  it("carries the fact check's citations through", () => {
    const citations = [{ url: "https://example.com/launch", title: "Launch" }];
    const card = cardForInterjection(
      interjection({ candidate: candidate({ type: "factual_error", citations }) }),
    );

    expect(card.citations).toEqual(citations);
  });

  it("omits what the candidate does not have rather than sending blanks", () => {
    const card = cardForInterjection(
      interjection({
        candidate: candidate({ detail: "", whyNow: "  ", evidence: [], citations: [] }),
      }),
    );

    expect(card).toEqual({
      id: "card-cand-3",
      variant: "interject",
      state: "ready",
      createdAtMs: 52_000,
      headline: "A $12 solo tier does not fit the $4,000 a month floor",
      raised: true,
    });
  });

  // V3-008: every correction is shown and not said, so the hand goes up for
  // all of them — bar the one sentence a `bold` session says out loud, which
  // is on its way to the room's ears and needs no calling on.
  describe("the raised hand", () => {
    const verified = {
      type: "factual_error" as const,
      verification: {
        verdict: "wrong" as const,
        correction: "It was 2010.",
        citations: [],
        searched: true,
      },
    };

    it("goes up for a correction Sotto is keeping to itself", () => {
      expect(cardForInterjection(interjection()).raised).toBe(true);
      expect(cardForInterjection(interjection({ level: "glow" })).raised).toBe(true);
      expect(
        cardForInterjection(
          interjection({ candidate: candidate({ type: "untested_assumption" }) }),
        ).raised,
      ).toBe(true);
      expect(
        cardForInterjection(interjection({ candidate: candidate(verified) })).raised,
      ).toBe(true);
    });

    it("stays down for the one correction a bold session speaks", () => {
      const card = cardForInterjection({
        ...interjection({ candidate: candidate(verified) }),
        decision: { ...decision, settings: { frequency: "normal", boldness: "bold" } },
      });

      expect(card.raised).toBeUndefined();
    });
  });
});
