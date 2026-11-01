import { describe, expect, it } from "vitest";
import type { CandidateScores } from "../../shared/candidates.js";
import { candidateTypes } from "../../shared/candidates.js";
import {
  BOLDNESS_THRESHOLDS,
  FREQUENCY_LIMITS,
  boldnessLevels,
  frequencyLevels,
  limitsFor,
  thresholdsFor,
  type Boldness,
  type Frequency,
  type PolicySettings,
} from "../../shared/policy.js";
import type { PauseState } from "../../shared/turns.js";
import {
  BUDGET_WINDOW_MS,
  COURTESY_MS,
  PAUSE_MS,
  STALE_MS,
  STALE_TURNS,
  boldnessAllows,
  candidateScore,
  decide,
  scoresFromGate,
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

/** The `normal` frequency's cooldown and budget, which the old code hard-coded. */
const COOLDOWN_MS = FREQUENCY_LIMITS.normal.cooldownMs;
const MAX_INTERJECTS_PER_WINDOW = FREQUENCY_LIMITS.normal.maxInterjectsPerWindow;

/** A setting pair, defaulting to the one the old `normal` chattiness was. */
function settings(overrides: Partial<PolicySettings> = {}): PolicySettings {
  return { frequency: "normal", boldness: "normal", ...overrides };
}
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
    type: "contradiction",
    verified: false,
    nowMs: 10_000,
    pause,
    settings: settings(),
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
  for (const boldness of boldnessLevels) {
    const { glow, interject } = BOLDNESS_THRESHOLDS[boldness];

    it(`${boldness}: glow at ${glow} and interject at ${interject}, inclusive`, () => {
      const at = (score: number): string =>
        decide(input({ settings: settings({ boldness }), scores: scoring(score) })).decision;

      expect(at(glow - 0.001)).toBe("silent");
      expect(at(glow)).toBe("glow");
      expect(at(interject - 0.001)).toBe("glow");
      expect(at(interject)).toBe("interject");
    });
  }

  it("reports the score, the level, the thresholds and the limits it used", () => {
    const decision = decide(
      input({ settings: settings({ boldness: "cautious" }), scores: scoring(0.5) }),
    );
    expect(decision).toEqual({
      decision: "glow",
      reason: "delivered",
      score: 0.5,
      level: "glow",
      thresholds: { glow: 0.45, interject: 0.75 },
      limits: FREQUENCY_LIMITS.normal,
      settings: { frequency: "normal", boldness: "cautious" },
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

  it("raises the same candidate further at a bolder setting", () => {
    const scores = scoring(0.5);
    const level = (boldness: Boldness): string =>
      decide(input({ settings: settings({ boldness }), scores })).decision;
    expect(level("cautious")).toBe("glow");
    expect(level("normal")).toBe("glow");
    expect(level("bold")).toBe("interject");
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
  it("downgrades an interject to a glow for the frequency's cooldown after one", () => {
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

  it("allows the frequency's interjects in a quarter of an hour and no more", () => {
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
    const sofar = Math.round(PAUSE_MS / 2);
    expect(
      nextCheckDelay(input({ pause: { speaking: false, silentForMs: sofar } })),
    ).toBe(PAUSE_MS - sofar);
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

describe("scoresFromGate (V2-016)", () => {
  it("maps each of the gate's four questions onto the score it replaces", () => {
    expect(
      scoresFromGate({ true: 0.1, new: 0.2, worthSaying: 0.3, stillRelevant: 0.4 }),
    ).toEqual({ confidence: 0.1, novelty: 0.2, importance: 0.3, relevance: 0.4 });
  });

  it("leaves the formula and the thresholds doing exactly what they did", () => {
    // The same four numbers, whoever produced them, score the same.
    const gated = scoresFromGate({
      true: 0.9,
      new: 0.8,
      worthSaying: 0.7,
      stillRelevant: 0.6,
    });
    expect(candidateScore(gated)).toBeCloseTo(
      candidateScore({ confidence: 0.9, novelty: 0.8, importance: 0.7, relevance: 0.6 }),
    );
  });

  it("can sink a candidate the observer was sure of, which is the point", () => {
    const observer: CandidateScores = {
      relevance: 1,
      novelty: 1,
      importance: 0.9,
      confidence: 0.9,
    };
    expect(candidateScore(observer)).toBeGreaterThan(BOLDNESS_THRESHOLDS.normal.interject);
    // The group said it themselves five minutes ago.
    const gated = scoresFromGate({
      true: 0.9,
      new: 0.1,
      worthSaying: 0.8,
      stillRelevant: 0.3,
    });
    expect(candidateScore(gated)).toBeLessThan(BOLDNESS_THRESHOLDS.normal.glow);
  });
});

describe("frequency (V2-017)", () => {
  const spentAt = (times: readonly number[], nowMs: number, frequency: Frequency) =>
    decide(
      input({
        nowMs,
        settings: settings({ frequency }),
        history: history({ seenAtMs: nowMs, interjectedAtMs: times }),
      }),
    );

  it("is the PRD's table: cooldown 5 / 3 / 1.5 min, budget 2 / 3 / 5", () => {
    expect(FREQUENCY_LIMITS.rare).toMatchObject({
      cooldownMs: 5 * 60_000,
      maxInterjectsPerWindow: 2,
    });
    expect(FREQUENCY_LIMITS.normal).toMatchObject({
      cooldownMs: 3 * 60_000,
      maxInterjectsPerWindow: 3,
    });
    expect(FREQUENCY_LIMITS.often).toMatchObject({
      cooldownMs: 1.5 * 60_000,
      maxInterjectsPerWindow: 5,
    });
  });

  it("rations research cards from the same setting, normal being V2-014's pair", () => {
    expect(FREQUENCY_LIMITS.normal.researchCardCooldownMs).toBe(60_000);
    expect(FREQUENCY_LIMITS.normal.maxResearchCardsPerWindow).toBe(4);
    // Rarer is slower and fewer at every step; more often is faster and more.
    const cooldowns = frequencyLevels.map((one) => FREQUENCY_LIMITS[one].researchCardCooldownMs);
    const caps = frequencyLevels.map((one) => FREQUENCY_LIMITS[one].maxResearchCardsPerWindow);
    expect(cooldowns).toEqual([...cooldowns].sort((a, b) => b - a));
    expect(caps).toEqual([...caps].sort((a, b) => a - b));
  });

  it("holds each frequency to its own cooldown", () => {
    for (const frequency of frequencyLevels) {
      const cooldownMs = FREQUENCY_LIMITS[frequency].cooldownMs;
      expect(spentAt([0], cooldownMs - 1, frequency).reason).toBe("cooldown");
      expect(spentAt([0], cooldownMs, frequency).decision).toBe("interject");
    }
  });

  it("holds each frequency to its own budget", () => {
    for (const frequency of frequencyLevels) {
      const { cooldownMs, maxInterjectsPerWindow } = FREQUENCY_LIMITS[frequency];
      // Spaced past the cooldown, so only the budget can turn the next down.
      const spent = Array.from({ length: maxInterjectsPerWindow }, (_, i) => i * cooldownMs);
      const nowMs = maxInterjectsPerWindow * cooldownMs;
      expect(spentAt(spent, nowMs, frequency)).toMatchObject({
        decision: "glow",
        reason: "budget",
      });
      expect(spentAt(spent.slice(1), nowMs, frequency).decision).toBe("interject");
    }
  });
});

describe("boldness (V2-017)", () => {
  it("carries today's quiet / normal / active thresholds, in that order", () => {
    expect(boldnessLevels.map((one) => BOLDNESS_THRESHOLDS[one])).toEqual([
      { glow: 0.45, interject: 0.75 },
      { glow: 0.35, interject: 0.6 },
      { glow: 0.25, interject: 0.45 },
    ]);
  });

  it("lets cautious raise a contradiction and a verified factual error only", () => {
    expect(boldnessAllows("cautious", "contradiction", false)).toBe(true);
    expect(boldnessAllows("cautious", "factual_error", true)).toBe(true);
    expect(boldnessAllows("cautious", "factual_error", false)).toBe(false);
    for (const type of ["untested_assumption", "dropped_thread", "unanswered_question"] as const) {
      expect(boldnessAllows("cautious", type, true)).toBe(false);
    }
  });

  it("lets normal and bold raise everything", () => {
    for (const boldness of ["normal", "bold"] as const) {
      for (const type of candidateTypes) {
        expect(boldnessAllows(boldness, type, false)).toBe(true);
      }
    }
  });

  it("says boldness, not below_threshold, for a type a cautious session won't raise", () => {
    expect(
      decide(
        input({ settings: settings({ boldness: "cautious" }), type: "dropped_thread" }),
      ),
    ).toMatchObject({ decision: "silent", reason: "boldness" });
    // The same candidate at normal boldness is heard.
    expect(decide(input({ type: "dropped_thread" })).decision).toBe("interject");
  });

  it("scores a type it won't raise first, so the log says it was below the bar", () => {
    expect(
      decide(
        input({
          settings: settings({ boldness: "cautious" }),
          type: "dropped_thread",
          scores: scoring(0.1),
        }),
      ).reason,
    ).toBe("below_threshold");
  });
});

describe("normal/normal is today's normal chattiness, exactly (V2-017)", () => {
  // The three numbers the one old setting decided: the two thresholds, which
  // were `CHATTINESS_THRESHOLDS.normal`, and the cooldown and budget, which
  // were constants in this file.
  it("keeps the thresholds at 0.35 and 0.6", () => {
    expect(thresholdsFor("normal")).toEqual({ glow: 0.35, interject: 0.6 });
  });

  it("keeps the cooldown at three minutes and the budget at three", () => {
    expect(limitsFor("normal")).toMatchObject({
      cooldownMs: 180_000,
      maxInterjectsPerWindow: 3,
    });
  });

  it("raises every type, as the old policy did: nothing was type-aware", () => {
    for (const type of candidateTypes) {
      expect(boldnessAllows("normal", type, false)).toBe(true);
    }
  });

  it("decides the old normal's borderline cases the same way", () => {
    const at = (score: number): string => decide(input({ scores: scoring(score) })).decision;
    expect(at(0.349)).toBe("silent");
    expect(at(0.35)).toBe("glow");
    expect(at(0.599)).toBe("glow");
    expect(at(0.6)).toBe("interject");
  });
});
