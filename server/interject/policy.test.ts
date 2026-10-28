import { describe, expect, it } from "vitest";
import type { CandidateScores } from "../../shared/candidates.js";
import {
  CHATTINESS_THRESHOLDS,
  chattinessLevels,
  type Chattiness,
} from "../../shared/policy.js";
import type { PauseState } from "../../shared/turns.js";
import {
  BUDGET_WINDOW_MS,
  COOLDOWN_MS,
  COURTESY_MS,
  MAX_INTERJECTS_PER_WINDOW,
  PAUSE_MS,
  STALE_MS,
  STALE_TURNS,
  candidateScore,
  decide,
  nextCheckDelay,
  type PolicyHistory,
  type PolicyInput,
} from "./policy.js";

/** Scores that multiply out to exactly `score`, by moving confidence alone. */
function scoring(score: number): CandidateScores {
  // relevance 1 and novelty 1 make the multiplier 1, so confidence is the dial.
  return { relevance: 1, novelty: 1, importance: 1, confidence: score };
}

const pause: PauseState = { speaking: false, silentForMs: PAUSE_MS };
const speaking: PauseState = { speaking: true, silentForMs: 0 };

function history(overrides: Partial<PolicyHistory> = {}): PolicyHistory {
  return {
    seenAtMs: 0,
    turnsWaited: 0,
    interjectedAtMs: [],
    answerThinking: false,
    wakeAtMs: null,
    ...overrides,
  };
}

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    scores: scoring(0.9),
    nowMs: 10_000,
    pause,
    chattiness: "normal",
    history: history(),
    ...overrides,
  };
}

describe("candidateScore", () => {
  it("is importance × confidence × (0.5 + 0.5 × relevance) × novelty", () => {
    expect(
      candidateScore({ importance: 0.8, confidence: 0.5, relevance: 0.6, novelty: 0.9 }),
    ).toBeCloseTo(0.8 * 0.5 * 0.8 * 0.9, 10);
  });

  it("lets importance, confidence or novelty veto on their own", () => {
    const strong = { importance: 1, confidence: 1, relevance: 1, novelty: 1 };
    expect(candidateScore({ ...strong, importance: 0 })).toBe(0);
    expect(candidateScore({ ...strong, confidence: 0 })).toBe(0);
    expect(candidateScore({ ...strong, novelty: 0 })).toBe(0);
    // Relevance only halves it: an off-topic but serious point still counts.
    expect(candidateScore({ ...strong, relevance: 0 })).toBe(0.5);
  });
});

describe("decide: thresholds", () => {
  for (const chattiness of chattinessLevels) {
    const { glow, interject } = CHATTINESS_THRESHOLDS[chattiness];

    it(`${chattiness}: glow at ${glow} and interject at ${interject}, inclusive`, () => {
      const at = (score: number): string =>
        decide(input({ chattiness, scores: scoring(score) })).decision;

      expect(at(glow - 0.001)).toBe("silent");
      expect(at(glow)).toBe("glow");
      expect(at(interject - 0.001)).toBe("glow");
      expect(at(interject)).toBe("interject");
    });
  }

  it("reports the score, the level and the thresholds it used", () => {
    const decision = decide(input({ chattiness: "quiet", scores: scoring(0.5) }));
    expect(decision).toEqual({
      decision: "glow",
      reason: "delivered",
      score: 0.5,
      level: "glow",
      thresholds: { glow: 0.45, interject: 0.75 },
      chattiness: "quiet",
    });
  });

  it("says below_threshold, not stale, for something it would never raise", () => {
    const decision = decide(
      input({
        scores: scoring(0.1),
        nowMs: STALE_MS * 2,
        history: history({ turnsWaited: STALE_TURNS + 1 }),
      }),
    );
    expect(decision).toMatchObject({ decision: "silent", reason: "below_threshold" });
  });

  it("raises the same candidate further at a looser setting", () => {
    const scores = scoring(0.5);
    const level = (chattiness: Chattiness): string => decide(input({ chattiness, scores })).decision;
    expect(level("quiet")).toBe("glow");
    expect(level("normal")).toBe("glow");
    expect(level("active")).toBe("interject");
  });
});

describe("decide: timing", () => {
  it("holds while somebody is talking", () => {
    expect(decide(input({ pause: speaking }))).toMatchObject({
      decision: "hold",
      reason: "waiting_for_pause",
      level: "interject",
    });
  });

  it("holds through a breath and delivers at a pause", () => {
    expect(
      decide(input({ pause: { speaking: false, silentForMs: PAUSE_MS - 1 } })).decision,
    ).toBe("hold");
    expect(decide(input({ pause: { speaking: false, silentForMs: PAUSE_MS } })).decision).toBe(
      "interject",
    );
  });
});

describe("decide: expiry", () => {
  it("goes stale after 90 seconds of waiting", () => {
    const seenAtMs = 1_000;
    expect(
      decide(input({ nowMs: seenAtMs + STALE_MS - 1, history: history({ seenAtMs }) })).decision,
    ).toBe("interject");
    expect(
      decide(input({ nowMs: seenAtMs + STALE_MS, history: history({ seenAtMs }), pause: speaking })),
    ).toMatchObject({ decision: "silent", reason: "stale" });
  });

  it("goes stale after six final turns, however quickly they went by", () => {
    expect(
      decide(input({ nowMs: 2_000, history: history({ turnsWaited: STALE_TURNS - 1 }) })).decision,
    ).toBe("interject");
    expect(
      decide(input({ nowMs: 2_000, history: history({ turnsWaited: STALE_TURNS }) })),
    ).toMatchObject({ decision: "silent", reason: "stale" });
  });
});

describe("decide: courtesy", () => {
  it("holds while an answer is still being written", () => {
    expect(decide(input({ history: history({ answerThinking: true }) }))).toMatchObject({
      decision: "hold",
      reason: "courtesy",
    });
  });

  it("holds for five seconds after a wake phrase, then speaks", () => {
    const wakeAtMs = 10_000;
    const at = (nowMs: number): string => decide(input({ nowMs, history: history({ wakeAtMs }) })).decision;
    expect(at(wakeAtMs)).toBe("hold");
    expect(at(wakeAtMs + COURTESY_MS - 1)).toBe("hold");
    expect(at(wakeAtMs + COURTESY_MS)).toBe("interject");
  });

  it("still expires a candidate that waited out the courtesy window", () => {
    expect(
      decide(
        input({
          nowMs: STALE_MS,
          history: history({ seenAtMs: 0, answerThinking: true }),
        }),
      ),
    ).toMatchObject({ decision: "silent", reason: "stale" });
  });
});

describe("decide: budget", () => {
  it("downgrades an interject to a glow for three minutes after one", () => {
    const interjectedAtMs = [10_000];
    // `seenAtMs` moves with the clock, so the cooldown is the only rule in play.
    const at = (nowMs: number) =>
      decide(input({ nowMs, history: history({ seenAtMs: nowMs, interjectedAtMs }) }));
    expect(at(10_001)).toMatchObject({ decision: "glow", reason: "cooldown", level: "interject" });
    expect(at(10_000 + COOLDOWN_MS - 1).decision).toBe("glow");
    expect(at(10_000 + COOLDOWN_MS).decision).toBe("interject");
  });

  it("leaves a glow a glow: the cooldown only rations interrupting", () => {
    expect(
      decide(
        input({
          scores: scoring(0.4),
          nowMs: 11_000,
          history: history({ interjectedAtMs: [10_000] }),
        }),
      ),
    ).toMatchObject({ decision: "glow", reason: "delivered", level: "glow" });
  });

  it("allows three interjects in a quarter of an hour and no more", () => {
    // Spaced past the cooldown, so only the budget can turn the fourth down.
    const spent = [0, COOLDOWN_MS, COOLDOWN_MS * 2];
    expect(spent).toHaveLength(MAX_INTERJECTS_PER_WINDOW);
    const nowMs = COOLDOWN_MS * 3;
    expect(
      decide(input({ nowMs, history: history({ seenAtMs: nowMs, interjectedAtMs: spent }) })),
    ).toMatchObject({ decision: "glow", reason: "budget" });

    // Once the oldest falls out of the window, there is room again.
    const later = spent[0]! + BUDGET_WINDOW_MS;
    expect(
      decide(input({ nowMs: later, history: history({ seenAtMs: later, interjectedAtMs: spent }) })),
    ).toMatchObject({ decision: "interject", reason: "delivered" });
  });
});

describe("nextCheckDelay", () => {
  it("waits out the rest of the silence a pause needs", () => {
    expect(
      nextCheckDelay(input({ pause: { speaking: false, silentForMs: 400 } })),
    ).toBe(PAUSE_MS - 400);
  });

  it("falls back to expiry while somebody is talking", () => {
    expect(nextCheckDelay(input({ nowMs: 1_000, pause: speaking, history: history() }))).toBe(
      STALE_MS - 1_000,
    );
  });

  it("waits out the courtesy window after a wake phrase", () => {
    expect(
      nextCheckDelay(input({ nowMs: 10_200, history: history({ wakeAtMs: 10_000 }) })),
    ).toBe(COURTESY_MS - 200);
  });

  it("never asks for a time that has already passed", () => {
    expect(
      nextCheckDelay(input({ nowMs: STALE_MS * 3, pause: speaking, history: history() })),
    ).toBe(0);
  });
});
