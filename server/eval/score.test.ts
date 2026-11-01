import { describe, expect, it } from "vitest";
import type {
  DeliveryRecord,
  EvalRunRecord,
  FixtureRunRecord,
  JudgeMatchRecord,
  MomentRecord,
} from "../../shared/eval.js";
import { policySettingsLabel, type PolicySettings } from "../../shared/policy.js";
import {
  MIN_MOMENT_RECALL,
  boldnessFromChattiness,
  isQuietFixture,
  median,
  outcomeFor,
  scoreFixture,
  scoreRun,
  scoreSettings,
  settingsOf,
  windowFor,
} from "./score.js";

/**
 * Hand-built run results. Nothing here replays anything: the whole point of
 * US-016 part 2 is that the numbers come off the record, so the record is
 * written by hand and the arithmetic is checked against it.
 */
function moment(overrides: Partial<MomentRecord> = {}): MomentRecord {
  return {
    id: "m1",
    type: "contradiction",
    expectedLevel: "interject",
    description: "the budget was contradicted",
    triggerLine: 10,
    deadlineLine: 14,
    triggerEndMs: 100_000,
    deadlineEndMs: 118_000,
    setupTurnIds: ["0:2"],
    triggerTurnIds: ["0:10"],
    triggerTurnEndMs: 102_000,
    deadlineTurnEndMs: 120_000,
    ...overrides,
  };
}

function delivery(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    cardId: "card-cand-1",
    candidateId: "cand-1",
    type: "contradiction",
    level: "interject",
    headline: "We agreed on $4,000 and this adds $1,800",
    detail: "detail",
    whyNow: "there is a pause",
    deliveredAtMs: 110_000,
    inPause: true,
    pause: { speaking: false, silentForMs: 2_000 },
    reason: "delivered",
    score: 0.81,
    ...overrides,
  };
}

function match(overrides: Partial<JudgeMatchRecord> = {}): JudgeMatchRecord {
  return {
    cardId: "card-cand-1",
    momentId: "m1",
    matches: true,
    reason: "the card names both figures",
    cached: false,
    ...overrides,
  };
}

function run(overrides: Partial<FixtureRunRecord> = {}): FixtureRunRecord {
  return {
    fixture: "moment-contradiction",
    settings: { frequency: "normal", boldness: "normal" },
    sessionDir: "/tmp/session",
    durationMs: 130_000,
    finalTurns: 26,
    candidates: 1,
    decisions: 2,
    deliveries: [],
    moments: [],
    matches: [],
    elapsedMs: 60_000,
    ...overrides,
  };
}

function record(runs: FixtureRunRecord[], overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  const seen = new Map<string, PolicySettings>();
  for (const one of runs) seen.set(policySettingsLabel(settingsOf(one)), settingsOf(one));
  return {
    id: "2026-10-28_120000",
    startedAt: "2026-10-28T12:00:00.000Z",
    finishedAt: "2026-10-28T12:10:00.000Z",
    gitCommit: "abc1234",
    settings: [...seen.values()],
    fixtures: [...new Set(runs.map((one) => one.fixture))],
    judge: { model: "muse-spark-1.3", promptHash: "deadbeef1234", calls: 1, cacheHits: 0 },
    runs,
    ...overrides,
  };
}

describe("windowFor", () => {
  it("puts the window on the session clock, where the delivery times are", () => {
    expect(windowFor(moment())).toEqual({ startMs: 102_000, endMs: 120_000 });
  });

  it("falls back to the scripted audio times for a line that produced no turn", () => {
    const silent = moment({ triggerTurnEndMs: null, deadlineTurnEndMs: null });
    expect(windowFor(silent)).toEqual({ startMs: 100_000, endMs: 118_000 });
  });

  it("never inverts: a deadline trimmed before its trigger becomes the trigger", () => {
    const tight = moment({ triggerTurnEndMs: 50_000, deadlineTurnEndMs: 49_000 });
    expect(windowFor(tight)).toEqual({ startMs: 50_000, endMs: 50_000 });
  });
});

describe("outcomeFor", () => {
  const window = { startMs: 102_000, endMs: 120_000 };

  it("counts an interjection inside the window for an interject moment as caught", () => {
    expect(outcomeFor(moment(), delivery(), window)).toBe("caught");
  });

  it("counts a glow where an interjection was wanted as caught low", () => {
    expect(outcomeFor(moment(), delivery({ level: "glow" }), window)).toBe("caught_low");
  });

  it("counts an interjection where a glow was wanted as caught: higher is allowed", () => {
    const expected = moment({ expectedLevel: "glow" });
    expect(outcomeFor(expected, delivery(), window)).toBe("caught");
  });

  it("counts anything after the deadline as late, however well pitched", () => {
    expect(outcomeFor(moment(), delivery({ deliveredAtMs: 120_001 }), window)).toBe("late");
    const glow = delivery({ level: "glow", deliveredAtMs: 125_000 });
    expect(outcomeFor(moment(), glow, window)).toBe("late");
  });

  it("still counts a delivery before the trigger line ended as caught", () => {
    expect(outcomeFor(moment(), delivery({ deliveredAtMs: 101_000 }), window)).toBe("caught");
  });
});

describe("scoreFixture", () => {
  it("scores a matched delivery and measures the delay from the trigger line", () => {
    const scored = scoreFixture(
      run({ moments: [moment()], deliveries: [delivery()], matches: [match()] }),
    );
    expect(scored.caught).toBe(1);
    expect(scored.missed).toBe(0);
    expect(scored.falseInterjects).toBe(0);
    expect(scored.moments[0]).toMatchObject({
      momentId: "m1",
      outcome: "caught",
      cardId: "card-cand-1",
      deliveredLevel: "interject",
      delayMs: 8_000,
      judgeReason: "the card names both figures",
    });
    expect(scored.deliveries[0]).toMatchObject({
      cardId: "card-cand-1",
      matchedMomentIds: ["m1"],
      unmatched: false,
    });
  });

  it("misses a moment nothing matched, and leaves its delay unmeasured", () => {
    const scored = scoreFixture(run({ moments: [moment()] }));
    expect(scored.missed).toBe(1);
    expect(scored.moments[0]).toMatchObject({
      outcome: "missed",
      cardId: null,
      deliveredLevel: null,
      delayMs: null,
      judgeReason: null,
    });
  });

  it("misses a moment the judge looked at and rejected", () => {
    const scored = scoreFixture(
      run({
        moments: [moment()],
        deliveries: [delivery()],
        matches: [match({ matches: false, reason: "different issue" })],
      }),
    );
    expect(scored.missed).toBe(1);
    // The card raised nothing planted, so it is a false interject.
    expect(scored.falseInterjects).toBe(1);
  });

  it("counts a delivery matching no moment as false, by the level it went out at", () => {
    const scored = scoreFixture(
      run({
        fixture: "brainstorm",
        deliveries: [
          delivery({ cardId: "card-a" }),
          delivery({ cardId: "card-b", level: "glow" }),
        ],
      }),
    );
    expect(scored.falseInterjects).toBe(1);
    expect(scored.falseGlows).toBe(1);
    expect(scored.deliveries.every((one) => one.unmatched)).toBe(true);
  });

  it("takes the best outcome when two cards matched one moment", () => {
    const glow = delivery({ cardId: "card-a", level: "glow", deliveredAtMs: 105_000 });
    const interject = delivery({ cardId: "card-b", deliveredAtMs: 112_000 });
    const scored = scoreFixture(
      run({
        moments: [moment()],
        deliveries: [glow, interject],
        matches: [
          match({ cardId: "card-a", reason: "the glow raises it" }),
          match({ cardId: "card-b", reason: "the interjection raises it" }),
        ],
      }),
    );
    expect(scored.caught).toBe(1);
    expect(scored.caughtLow).toBe(0);
    expect(scored.moments[0]).toMatchObject({
      cardId: "card-b",
      delayMs: 10_000,
      judgeReason: "the interjection raises it",
    });
  });

  it("prefers the earlier card when two give the same outcome", () => {
    const scored = scoreFixture(
      run({
        moments: [moment()],
        deliveries: [
          delivery({ cardId: "card-late", deliveredAtMs: 115_000 }),
          delivery({ cardId: "card-early", deliveredAtMs: 105_000 }),
        ],
        matches: [match({ cardId: "card-late" }), match({ cardId: "card-early" })],
      }),
    );
    expect(scored.moments[0]?.cardId).toBe("card-early");
  });

  it("counts a delivery outside a pause without taking the policy's word for it", () => {
    const scored = scoreFixture(
      run({ deliveries: [delivery({ inPause: false })], fixture: "brainstorm" }),
    );
    expect(scored.deliveriesInPause).toBe(0);
    expect(scored.deliveries[0]?.inPause).toBe(false);
  });

  it("carries a replay failure through as an empty, flagged fixture", () => {
    const scored = scoreFixture(run({ error: "no capture" }));
    expect(scored.error).toBe("no capture");
    expect(scored.moments).toEqual([]);
  });
});

describe("median", () => {
  it("is null for nothing, the middle for odd, the mean of two middles for even", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe("scoreSettings", () => {
  const caught = run({
    fixture: "moment-contradiction",
    moments: [moment()],
    deliveries: [delivery()],
    matches: [match()],
  });
  const low = run({
    fixture: "moment-mixed",
    moments: [moment({ id: "m2" })],
    deliveries: [delivery({ cardId: "card-b", level: "glow", deliveredAtMs: 106_000 })],
    matches: [match({ cardId: "card-b", momentId: "m2" })],
  });
  const quiet = run({ fixture: "brainstorm" });

  it("computes the three headline metrics the PRD names", () => {
    const group = scoreSettings({ frequency: "normal", boldness: "normal" }, [caught, low, quiet], true);
    expect(group.totals).toMatchObject({
      moments: 2,
      caught: 1,
      caughtLow: 1,
      missed: 0,
      interjects: 1,
      trueInterjects: 1,
      glows: 1,
      quietFalseInterjects: 0,
    });
    expect(group.recall).toBe(1);
    expect(group.interjectPrecision).toBe(1);
    expect(group.pauseRate).toBe(1);
    // 8,000 ms and 4,000 ms.
    expect(group.medianDelayMs).toBe(6_000);
    expect(group.passed).toBe(true);
  });

  it("does not count a late catch towards recall", () => {
    const late = run({
      fixture: "moment-fact",
      moments: [moment({ id: "m3" })],
      deliveries: [delivery({ cardId: "card-c", deliveredAtMs: 130_000 })],
      matches: [match({ cardId: "card-c", momentId: "m3" })],
    });
    const group = scoreSettings({ frequency: "normal", boldness: "normal" }, [late], true);
    expect(group.totals.late).toBe(1);
    expect(group.recall).toBe(0);
    // It matched a moment, so it is not a false interject either.
    expect(group.totals.trueInterjects).toBe(1);
    expect(group.totals.falseInterjects).toBe(0);
    expect(gate(group, "recall").status).toBe("fail");
  });

  it("fails the recall gate below the threshold and passes at it", () => {
    const moments = [moment({ id: "m1" }), moment({ id: "m2" }), moment({ id: "m3" })];
    const missing = run({ moments, deliveries: [delivery()], matches: [match()] });
    expect(scoreSettings({ frequency: "normal", boldness: "normal" }, [missing], true).recall).toBeCloseTo(1 / 3);
    expect(gate(scoreSettings({ frequency: "normal", boldness: "normal" }, [missing], true), "recall").status).toBe("fail");

    const two = run({
      moments: [moment({ id: "m1" }), moment({ id: "m2" })],
      deliveries: [delivery(), delivery({ cardId: "card-b" })],
      matches: [match(), match({ cardId: "card-b", momentId: "m2" })],
    });
    const group = scoreSettings({ frequency: "normal", boldness: "normal" }, [two], true);
    expect(group.recall).toBe(1);
    expect(group.recall).toBeGreaterThanOrEqual(MIN_MOMENT_RECALL);
    expect(gate(group, "recall").status).toBe("pass");
  });

  it("fails the quiet-fixture gate on one false interject in brainstorm", () => {
    const noisy = run({ fixture: "brainstorm", deliveries: [delivery()] });
    const group = scoreSettings({ frequency: "normal", boldness: "normal" }, [caught, noisy], true);
    expect(group.totals.quietFalseInterjects).toBe(1);
    expect(group.interjectPrecision).toBe(0.5);
    expect(gate(group, "false interject").status).toBe("fail");
    expect(group.passed).toBe(false);
  });

  it("does not gate on a false glow, but counts it", () => {
    const glowing = run({
      fixture: "no-wake",
      deliveries: [delivery({ cardId: "card-g", level: "glow" })],
    });
    const group = scoreSettings({ frequency: "normal", boldness: "normal" }, [caught, glowing], true);
    expect(group.totals.falseGlows).toBe(1);
    expect(group.totals.quietFalseInterjects).toBe(0);
    expect(group.passed).toBe(true);
  });

  it("fails on any delivery outside a pause", () => {
    const rude = run({
      fixture: "moment-contradiction",
      moments: [moment()],
      deliveries: [delivery({ inPause: false })],
      matches: [match()],
    });
    const group = scoreSettings({ frequency: "normal", boldness: "normal" }, [rude], true);
    expect(group.pauseRate).toBe(0);
    expect(gate(group, "pause").status).toBe("fail");
    expect(group.passed).toBe(false);
  });

  it("fails on a replay that threw, whatever the rest of the run says", () => {
    const group = scoreSettings({ frequency: "normal", boldness: "normal" }, [caught, run({ error: "boom" })], true);
    expect(group.totals.replayErrors).toBe(1);
    expect(gate(group, "replay").status).toBe("fail");
  });

  it("skips the gates that need matches when judging was skipped", () => {
    const group = scoreSettings({ frequency: "normal", boldness: "normal" }, [run({ moments: [moment()] })], false);
    expect(gate(group, "recall").status).toBe("skipped");
    expect(gate(group, "false interject").status).toBe("skipped");
    expect(gate(group, "pause").status).toBe("pass");
    // A skipped gate is not a failed one: the run is not pronounced bad.
    expect(group.passed).toBe(true);
  });

  it("treats a run with nothing to catch as neither recall nor precision failure", () => {
    const group = scoreSettings({ frequency: "normal", boldness: "normal" }, [quiet], true);
    expect(group.recall).toBe(1);
    expect(group.interjectPrecision).toBe(1);
    expect(group.passed).toBe(true);
    expect(gate(group, "recall").detail).toContain("no moments");
  });
});

/** The gate whose name contains `needle`. */
function gate(group: { gates: { name: string; status: string; detail: string }[] }, needle: string) {
  const found = group.gates.find((one) => one.name.includes(needle));
  if (found === undefined) throw new Error(`no gate matching ${needle}`);
  return found;
}

describe("scoreRun", () => {
  it("scores and gates each pair of settings on its own", () => {
    const cautiousRun = run({
      settings: { frequency: "normal", boldness: "cautious" },
      moments: [moment()],
      deliveries: [],
      matches: [],
    });
    const boldRun = run({
      settings: { frequency: "normal", boldness: "bold" },
      moments: [moment()],
      deliveries: [delivery()],
      matches: [match()],
    });
    const score = scoreRun(record([cautiousRun, boldRun]));
    expect(score.groups.map((group) => policySettingsLabel(group.settings))).toEqual([
      "normal/cautious",
      "normal/bold",
    ]);
    expect(score.groups[0]?.recall).toBe(0);
    expect(score.groups[1]?.recall).toBe(1);
    // One failing setting fails the run.
    expect(score.passed).toBe(false);
  });

  it("reads an empty judge prompt hash as `--no-judge`", () => {
    const score = scoreRun(
      record([run({ moments: [moment()] })], {
        judge: { model: "muse-spark-1.3", promptHash: "", calls: 0, cacheHits: 0 },
      }),
    );
    expect(score.judged).toBe(false);
    expect(score.passed).toBe(true);
  });

  it("falls back to the settings its runs were recorded at", () => {
    const score = scoreRun(record([run()], { settings: [] }));
    expect(score.groups.map((group) => group.settings)).toEqual([
      { frequency: "normal", boldness: "normal" },
    ]);
  });

  it("still renders a run recorded before V2-017, under the new names", () => {
    // `chattiness` decided exactly the thresholds boldness decides now, and
    // the cooldown and budget were `normal` frequency's constants.
    const { settings: _dropped, ...rest } = run({
      moments: [moment()],
      deliveries: [delivery()],
      matches: [match()],
    });
    const old: FixtureRunRecord = { ...rest, chattiness: "active" };
    const { settings: _alsoDropped, ...base } = record([old]);
    const score = scoreRun({ ...base, chattiness: ["active"] });
    expect(score.groups.map((group) => group.settings)).toEqual([
      { frequency: "normal", boldness: "bold" },
    ]);
    expect(score.groups[0]?.recall).toBe(1);
    expect(score.groups[0]?.fixtures[0]?.settings).toEqual({
      frequency: "normal",
      boldness: "bold",
    });
  });

  it("maps quiet/normal/active onto the boldness that carries their thresholds", () => {
    expect(boldnessFromChattiness("quiet")).toBe("cautious");
    expect(boldnessFromChattiness("normal")).toBe("normal");
    expect(boldnessFromChattiness("active")).toBe("bold");
    expect(boldnessFromChattiness(undefined)).toBe("normal");
  });
});

describe("isQuietFixture", () => {
  it("is the two conversations with nothing planted in them", () => {
    expect(isQuietFixture("brainstorm")).toBe(true);
    expect(isQuietFixture("no-wake")).toBe(true);
    expect(isQuietFixture("moment-fact")).toBe(false);
  });
});
