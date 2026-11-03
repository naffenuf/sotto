/**
 * The record an unprompted line leaves, read back (PRD V3-010).
 *
 * `timing.jsonl` is written as `unknown` and carries two dozen other stages,
 * so the narrowing is the load-bearing part: a line from a future version of
 * the pipeline has to be dropped rather than guessed at.
 */
import { describe, expect, it } from "vitest";
import {
  SPOKEN_CHARS_PER_SECOND,
  SPOKEN_CONTRIBUTION_STAGE,
  asSpokenContribution,
  estimateSpokenMs,
  isUnpromptedKind,
  spokenContributionKinds,
  spokenTurnId,
  spokenUtteranceId,
  type SpokenContributionRecord, cleanForSpeech } from "./spoken.js";
import { sottoTurnId } from "./turns.js";

const line: SpokenContributionRecord = {
  stage: SPOKEN_CONTRIBUTION_STAGE,
  kind: "answer",
  atMs: 90_000,
  ideaId: "idea-1",
  turnId: "0:7",
  topic: "the drive time",
  spoken: true,
  text: "On the drive time: about two hours fifteen.",
};

describe("asSpokenContribution", () => {
  it("narrows a spoken_contribution line", () => {
    expect(asSpokenContribution({ ...line })).toEqual(line);
  });

  it("ignores every other stage in the file", () => {
    expect(asSpokenContribution({ stage: "turn_final", atMs: 1 })).toBeNull();
    expect(asSpokenContribution({ stage: "board_complete", atMs: 1 })).toBeNull();
  });

  it("drops a kind this version does not know rather than guessing", () => {
    expect(asSpokenContribution({ ...line, kind: "serenade" })).toBeNull();
  });

  it("drops a line missing what the scoring reads", () => {
    const { atMs, ...noTime } = line;
    expect(atMs).toBe(90_000);
    expect(asSpokenContribution(noTime)).toBeNull();
    expect(asSpokenContribution({ ...line, spoken: "yes" })).toBeNull();
    expect(asSpokenContribution(null)).toBeNull();
    expect(asSpokenContribution("spoken_contribution")).toBeNull();
  });
});

describe("isUnpromptedKind", () => {
  it("is every kind but the two the room asked for", () => {
    const unprompted = spokenContributionKinds.filter(isUnpromptedKind);
    // V3-017's card read out on request, and V3-007's ideas said after a yes.
    expect(unprompted).not.toContain("called_on");
    expect(unprompted).not.toContain("ideas");
    expect(unprompted).toHaveLength(spokenContributionKinds.length - 2);
  });
});

describe("spokenTurnId", () => {
  it("is the transcript row of a first attempt", () => {
    expect(spokenTurnId(line)).toBe(sottoTurnId(spokenUtteranceId("answer", "idea-1")));
  });

  it("stays on the first attempt's row for the yield that ended it", () => {
    expect(spokenTurnId({ ...line, yielded: true, yields: 1 })).toBe(spokenTurnId(line));
  });

  it("moves to the retry's own row, which is numbered from two", () => {
    expect(spokenTurnId({ ...line, yields: 1 })).toBe(sottoTurnId("answer-idea-1-2"));
  });
});

describe("estimateSpokenMs", () => {
  it("reads at the rate the hello was measured at", () => {
    // 361 characters of hello take 21.5 s in Sotto's own voice, Matilda at speed 1.1
    // (River, V3-012, read them in 18.4 s).
    expect(estimateSpokenMs("x".repeat(361)) / 1000).toBeCloseTo(21.5, 1);
    expect(estimateSpokenMs("x".repeat(Math.round(SPOKEN_CHARS_PER_SECOND * 5)))).toBe(5_000);
  });

  it("is zero for nothing", () => {
    expect(estimateSpokenMs("   ")).toBe(0);
  });
});

describe("cleanForSpeech", () => {
  it("says the symbols the voice would otherwise read out", () => {
    expect(cleanForSpeech("PhillyBus is cheapest at ~$10, about 2-3 hours")).toBe(
      "PhillyBus is cheapest at about 10 dollars, about 2 to 3 hours",
    );
    expect(cleanForSpeech("Sunday/Monday departures from Pine St.")).toBe("Sunday or Monday departures from Pine Street");
    expect(cleanForSpeech("buses at 9 AM and 10:30 pm")).toBe("buses at 9 a m and 10:30 p m");
    expect(cleanForSpeech("St. Louis to Washington Ave, $1.2 million")).toBe("Saint Louis to Washington Avenue, 1.2 million dollars");
    expect(cleanForSpeech("They charge $12 a seat.")).toBe("They charge 12 dollars a seat.");
  });

  it("leaves ordinary prose alone", () => {
    const line = "Buses run nearly every hour; the ride is about two hours in traffic.";
    expect(cleanForSpeech(line)).toBe(line);
  });
});
