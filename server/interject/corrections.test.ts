/**
 * V3-008: what Sotto says out loud about the conversation, which is almost
 * nothing.
 */
import { describe, expect, it } from "vitest";
import type { Candidate, CandidateType } from "../../shared/candidates.js";
import {
  FREQUENCY_LIMITS,
  boldnessLevels,
  type Boldness,
  type DeliveredLevel,
  type PolicyDecision,
} from "../../shared/policy.js";
import {
  CORRECTION_TYPES,
  correctedClaim,
  correctionLine,
  isCorrection,
  spokenCorrection,
  spokenCorrectionAllowed,
} from "./corrections.js";
import type { Interjection } from "./InterjectionPolicy.js";

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: "cand-7",
    createdAtMs: 60_000,
    run: 3,
    type: "factual_error",
    headline: "Instagram launched in 2010, not 2014",
    detail: "Two pages put the launch in October 2010.",
    whyNow: "the timeline is being costed off that year",
    evidenceTurnIds: ["0:9"],
    relatedBoardItemIds: [],
    scores: { relevance: 0.9, novelty: 0.9, importance: 0.8, confidence: 0.9 },
    evidence: [{ turnId: "0:9", quote: "Instagram came out in 2014.", speaker: "A" }],
    verification: {
      verdict: "wrong",
      correction: "It launched in October 2010.",
      citations: [{ url: "https://example.com/instagram", title: "Instagram" }],
      searched: true,
    },
    ...over,
  };
}

function interjection(
  over: { candidate?: Partial<Candidate>; level?: DeliveredLevel; boldness?: Boldness } = {},
): Interjection {
  const decision: PolicyDecision = {
    decision: over.level ?? "interject",
    reason: "delivered",
    score: 0.68,
    level: over.level ?? "interject",
    thresholds: { glow: 0.25, interject: 0.45 },
    limits: FREQUENCY_LIMITS.normal,
    settings: { frequency: "normal", boldness: over.boldness ?? "bold" },
  };
  return {
    candidate: candidate(over.candidate),
    level: over.level ?? "interject",
    decision,
    atMs: 62_000,
  };
}

describe("the five corrections", () => {
  it("is every candidate type but the research hook", () => {
    expect([...CORRECTION_TYPES]).toEqual([
      "contradiction",
      "factual_error",
      "untested_assumption",
      "dropped_thread",
      "unanswered_question",
    ]);
    expect(isCorrection("research_hook")).toBe(false);
    for (const type of CORRECTION_TYPES) expect(isCorrection(type)).toBe(true);
  });

  it("says none of them out loud, at any boldness — bar the one exception", () => {
    const spoken: string[] = [];
    for (const boldness of boldnessLevels) {
      for (const type of CORRECTION_TYPES) {
        for (const level of ["interject", "glow"] as const) {
          const allowed = spokenCorrectionAllowed({
            boldness,
            type,
            verified: true,
            level,
          });
          if (allowed) spoken.push(`${boldness}/${type}/${level}`);
        }
      }
    }
    expect(spoken).toEqual(["bold/factual_error/interject"]);
  });

  it("will not speak a factual error the web check never confirmed", () => {
    const input = {
      boldness: "bold" as Boldness,
      type: "factual_error" as CandidateType,
      level: "interject" as DeliveredLevel,
    };
    expect(spokenCorrectionAllowed({ ...input, verified: true })).toBe(true);
    expect(spokenCorrectionAllowed({ ...input, verified: false })).toBe(false);
  });
});

describe("spokenCorrection", () => {
  it("gives a bold session one sentence to say", () => {
    expect(spokenCorrection(interjection())).toBe(
      "Quick correction: Instagram launched in 2010, not 2014.",
    );
  });

  it("gives every other session nothing", () => {
    expect(spokenCorrection(interjection({ boldness: "normal" }))).toBeNull();
    expect(spokenCorrection(interjection({ boldness: "cautious" }))).toBeNull();
    // A glow is the level the policy picked for a quiet thought — and the
    // level the budget downgrades an interject to, which must not buy a floor
    // the frequency setting has just said is not there.
    expect(spokenCorrection(interjection({ level: "glow" }))).toBeNull();
    expect(
      spokenCorrection(interjection({ candidate: { type: "contradiction" } })),
    ).toBeNull();
    const unchecked = interjection();
    delete unchecked.candidate.verification;
    expect(spokenCorrection(unchecked)).toBeNull();
  });

  it("asks the still-current check about the claim, not about the correction", () => {
    expect(correctedClaim(interjection())).toBe("Instagram came out in 2014.");
    // A candidate whose cited turn the assembler never produced has no quote,
    // and the headline is all there is.
    expect(correctedClaim(interjection({ candidate: { evidence: [] } }))).toBe(
      "Instagram launched in 2010, not 2014",
    );
  });
});

describe("correctionLine", () => {
  it("ends in a full stop, because it is heard and not read", () => {
    expect(correctionLine("The commission is 15 to 30 percent, not 40")).toBe(
      "Quick correction: The commission is 15 to 30 percent, not 40.",
    );
    expect(correctionLine("It launched in 2010.")).toBe(
      "Quick correction: It launched in 2010.",
    );
  });

  it("drops the ellipsis a clipped headline keeps on screen", () => {
    expect(correctionLine("The standard commission is fifteen percent, not forty…")).toBe(
      "Quick correction: The standard commission is fifteen percent, not forty.",
    );
  });

  it("says nothing a listener would have to read: no markdown, no URL", () => {
    const line = correctionLine("The App Store takes 15%, not 40%");
    expect(line).not.toMatch(/[*#_[\]`]|https?:/);
  });

  it("has nothing to say about an empty headline", () => {
    expect(correctionLine("   ")).toBe("");
    expect(spokenCorrection(interjection({ candidate: { headline: " " } }))).toBeNull();
  });
});
