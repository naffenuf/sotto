import { describe, expect, it } from "vitest";
import type {
  DeliveryRecord,
  EvalRunRecord,
  FixtureRunRecord,
  JudgeMatchRecord,
  MomentRecord,
  ResearchDeliveryRecord,
  ResearchRunRecord,
  SpokenRecord,
} from "../../shared/eval.js";
import type { SpokenContributionRecord } from "../../shared/spoken.js";
import { SPOKEN_CONTRIBUTION_STAGE } from "../../shared/spoken.js";
import { policySettingsLabel, type PolicySettings } from "../../shared/policy.js";
import {
  MIN_MOMENT_RECALL,
  MIN_RESEARCH_RECALL,
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

/** A planted `research_hook`, which only a research card can catch (V2-019). */
function hook(overrides: Partial<MomentRecord> = {}): MomentRecord {
  return moment({
    id: "h1",
    type: "research_hook",
    expectedLevel: "research",
    description: "nobody knows what the market is worth",
    ...overrides,
  });
}

function researchCard(
  overrides: Partial<ResearchDeliveryRecord> = {},
): ResearchDeliveryRecord {
  return {
    cardId: "research-packet-1",
    packetId: "packet-1",
    ideaId: "idea-1",
    title: "Meeting-tool market size",
    question: "How big is the meeting-assistant market?",
    teaser: "About $2bn in 2025, growing fast.",
    detail: "- two vendors hold most of it",
    sources: 3,
    deliveredAtMs: 110_000,
    inPause: true,
    pause: { speaking: false, silentForMs: 2_000 },
    atSessionEnd: false,
    ...overrides,
  };
}

function research(overrides: Partial<ResearchRunRecord> = {}): ResearchRunRecord {
  return {
    ideas: 3,
    queued: 1,
    rejected: 2,
    gateFailed: 0,
    localGateCalls: 3,
    packets: 1,
    unsourced: 0,
    failed: 0,
    cards: [researchCard()],
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
    expect(gate(group, "every delivery in a pause").status).toBe("fail");
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
    expect(gate(group, "every delivery in a pause").status).toBe("pass");
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

/**
 * The research half of the score (V2-019).
 *
 * A `research_hook` is caught by a research-ready card and by nothing else,
 * and it is kept out of the recall the policy is gated on — the two are
 * different halves of the stage with different targets, so mixing them would
 * let a good search cover for a missed contradiction, or the reverse.
 */
describe("scoreFixture with research", () => {
  const matched = match({ cardId: "research-packet-1", momentId: "h1" });

  it("counts a research card inside the window as catching its hook", () => {
    const scored = scoreFixture(
      run({ moments: [hook()], research: research(), matches: [matched] }),
    );
    expect(scored.researchCaught).toBe(1);
    expect(scored.researchMissed).toBe(0);
    expect(scored.moments[0]).toMatchObject({
      momentId: "h1",
      outcome: "caught",
      cardId: "research-packet-1",
      deliveredLevel: "research",
      delayMs: 8_000,
    });
    expect(scored.researchCards[0]).toMatchObject({
      cardId: "research-packet-1",
      packetId: "packet-1",
      inPause: true,
      matchedMomentIds: ["h1"],
      unmatched: false,
    });
    // It is not one of the policy's deliveries, so it is in neither the
    // precision count nor the pause gate's denominator.
    expect(scored.deliveries).toEqual([]);
    expect(scored.caught).toBe(0);
  });

  it("counts a research card after the deadline as late, not as a catch", () => {
    const scored = scoreFixture(
      run({
        moments: [hook()],
        research: research({ cards: [researchCard({ deliveredAtMs: 130_000 })] }),
        matches: [matched],
      }),
    );
    expect(scored.researchLate).toBe(1);
    expect(scored.researchCaught).toBe(0);
    expect(scored.moments[0]?.outcome).toBe("late");
  });

  it("misses a hook no card matched, and counts the card as raising nothing", () => {
    const scored = scoreFixture(
      run({
        moments: [hook()],
        research: research(),
        matches: [match({ cardId: "research-packet-1", momentId: "h1", matches: false })],
      }),
    );
    expect(scored.researchMissed).toBe(1);
    expect(scored.researchCards[0]?.unmatched).toBe(true);
  });

  it("never lets an interjection catch a hook, however the judge matched it", () => {
    const scored = scoreFixture(
      run({
        moments: [hook()],
        deliveries: [delivery()],
        research: research({ cards: [] }),
        matches: [match({ cardId: "card-cand-1", momentId: "h1" })],
      }),
    );
    expect(scored.researchMissed).toBe(1);
    expect(scored.moments[0]?.outcome).toBe("missed");
  });

  it("keeps the two kinds of moment in their own counts", () => {
    const scored = scoreFixture(
      run({
        moments: [moment(), hook()],
        deliveries: [delivery()],
        research: research(),
        matches: [match(), matched],
      }),
    );
    expect(scored.caught).toBe(1);
    expect(scored.researchCaught).toBe(1);
    expect(scored.moments).toHaveLength(2);
  });

  it("is empty-but-not-null-counted for a run recorded before V2-019", () => {
    const scored = scoreFixture(run({ moments: [hook()] }));
    expect(scored.research).toBeNull();
    expect(scored.researchCards).toEqual([]);
    expect(scored.researchMissed).toBe(1);
  });
});

describe("scoreSettings with research", () => {
  const hookRun = (overrides: Partial<FixtureRunRecord> = {}): FixtureRunRecord =>
    run({
      fixture: "research-business-idea",
      moments: [hook()],
      research: research(),
      matches: [match({ cardId: "research-packet-1", momentId: "h1" })],
      ...overrides,
    });

  it("gates research recall on its own threshold", () => {
    const group = scoreSettings({ frequency: "normal", boldness: "normal" }, [hookRun()], true);
    expect(group.researchRecall).toBe(1);
    expect(group.researchRecall).toBeGreaterThanOrEqual(MIN_RESEARCH_RECALL);
    expect(gate(group, "research recall").status).toBe("pass");
    // The policy caught nothing because nothing was asked of it.
    expect(group.recall).toBe(1);
    expect(gate(group, "moment recall").detail).toContain("no moments");
    expect(group.passed).toBe(true);
  });

  it("fails below half the hooks and passes at half", () => {
    const missed = hookRun({ matches: [] });
    const half = scoreSettings(
      { frequency: "normal", boldness: "normal" },
      [hookRun(), missed],
      true,
    );
    expect(half.researchRecall).toBe(0.5);
    expect(gate(half, "research recall").status).toBe("pass");
    const none = scoreSettings({ frequency: "normal", boldness: "normal" }, [missed], true);
    expect(none.researchRecall).toBe(0);
    expect(gate(none, "research recall").status).toBe("fail");
    expect(none.passed).toBe(false);
  });

  it("skips the research gate when judging was skipped", () => {
    const group = scoreSettings(
      { frequency: "normal", boldness: "normal" },
      [hookRun({ matches: [] })],
      false,
    );
    expect(gate(group, "research recall").status).toBe("skipped");
    expect(group.passed).toBe(true);
  });

  it("totals the packets, the unsourced ones and the local gate calls", () => {
    const group = scoreSettings(
      { frequency: "normal", boldness: "normal" },
      [
        hookRun(),
        hookRun({
          fixture: "offsite-plan",
          moments: [hook({ id: "h2" })],
          matches: [],
          research: research({
            ideas: 2,
            queued: 2,
            rejected: 0,
            packets: 0,
            unsourced: 1,
            failed: 1,
            localGateCalls: 2,
            cards: [],
          }),
        }),
      ],
      true,
    );
    expect(group.totals).toMatchObject({
      researchMoments: 2,
      researchCaught: 1,
      researchMissed: 1,
      researchIdeas: 5,
      researchQueued: 3,
      researchRejected: 2,
      researchPackets: 1,
      unsourcedPackets: 1,
      failedPackets: 1,
      localResearchGateCalls: 5,
      researchCards: 1,
      researchCardsInPause: 1,
      researchCardsAtSessionEnd: 0,
    });
  });

  it("keeps a research card out of the pause gate, flushed after the end or not", () => {
    const flushed = hookRun({
      research: research({
        cards: [researchCard({ inPause: false, atSessionEnd: true, deliveredAtMs: 180_000 })],
      }),
      matches: [],
    });
    const group = scoreSettings({ frequency: "normal", boldness: "normal" }, [flushed], true);
    expect(group.totals.researchCardsInPause).toBe(0);
    expect(group.totals.researchCardsAtSessionEnd).toBe(1);
    expect(group.pauseRate).toBe(1);
    expect(gate(group, "every delivery in a pause").status).toBe("pass");
  });
});

/**
 * Unprompted speech, scored (PRD V3-010).
 *
 * The run record carries the spoken lines already placed in the conversation
 * (`server/eval/spoken.ts` does the placing, and has its own tests), so these
 * build the placed shape by hand and check what the scoring makes of it: the
 * four conditions a catch has to meet, the near miss where a card went up
 * instead, and the two gates that are about harm rather than judgment.
 */
function spokenLine(
  overrides: Partial<SpokenRecord> = {},
  record: Partial<SpokenContributionRecord> = {},
): SpokenRecord {
  return {
    id: "spoken-0",
    record: {
      stage: SPOKEN_CONTRIBUTION_STAGE,
      kind: "answer",
      atMs: 110_000,
      ideaId: "idea-1",
      turnId: "0:10",
      topic: "the drive time",
      spoken: true,
      text: "On the drive time: about two hours fifteen.",
      questionToSpeechMs: 21_000,
      pauseWaitMs: 900,
      ...record,
    },
    atStreamMs: 110_000,
    endsAtStreamMs: 112_200,
    inPause: true,
    pause: { speaking: false, silentForMs: 1_200 },
    overTurnId: null,
    overrunMeasured: true,
    ...overrides,
  };
}

/** A planted question the room wondered aloud, which only speech catches. */
function speakMoment(overrides: Partial<MomentRecord> = {}): MomentRecord {
  return moment({
    id: "s1",
    type: "research_hook",
    expectedLevel: "speak",
    description: "nobody knows how long the drive is",
    ...overrides,
  });
}

function spokenMatch(overrides: Partial<JudgeMatchRecord> = {}): JudgeMatchRecord {
  return match({ cardId: "spoken-0", momentId: "s1", ...overrides });
}

describe("scoreFixture, speech", () => {
  it("counts a sentence in a pause inside the window as the catch", () => {
    const score = scoreFixture(
      run({
        fixture: "offsite-plan",
        moments: [speakMoment()],
        spoken: [spokenLine()],
        matches: [spokenMatch()],
      }),
    );
    expect(score.moments[0]?.outcome).toBe("caught");
    expect(score.moments[0]?.deliveredLevel).toBe("speak");
    expect(score.speakCaught).toBe(1);
    // A speak moment is in its own bucket, so it is not in the policy's
    // recall and is not gated at two thresholds at once.
    expect(score.caught + score.caughtLow + score.late + score.missed).toBe(0);
    expect(score.spoken[0]?.matchedMomentIds).toEqual(["s1"]);
    expect(score.spoken[0]?.falseSpeech).toBe(false);
  });

  it("calls a card instead of a sentence caught low, which is the near miss", () => {
    const score = scoreFixture(
      run({
        fixture: "offsite-plan",
        moments: [speakMoment()],
        research: research(),
        matches: [match({ cardId: "research-packet-1", momentId: "s1" })],
      }),
    );
    expect(score.moments[0]?.outcome).toBe("caught_low");
    expect(score.moments[0]?.deliveredLevel).toBe("research");
    expect(score.speakCaught).toBe(0);
    expect(score.speakCaughtLow).toBe(1);
  });

  it("does not count a sentence said over somebody as a catch", () => {
    const score = scoreFixture(
      run({
        fixture: "offsite-plan",
        moments: [speakMoment()],
        spoken: [spokenLine({ inPause: false })],
        matches: [spokenMatch()],
      }),
    );
    expect(score.moments[0]?.outcome).toBe("missed");
    expect(score.spoken[0]?.inPause).toBe(false);
  });

  it("does not count an answer the room had already given itself", () => {
    const score = scoreFixture(
      run({
        fixture: "offsite-plan",
        moments: [speakMoment()],
        spoken: [
          spokenLine(
            {},
            {
              stillCurrent: {
                verdict: "answered",
                agrees: true,
                latencyMs: 1_900,
                fallback: false,
                turns: 4,
              },
            },
          ),
        ],
        matches: [spokenMatch()],
      }),
    );
    expect(score.moments[0]?.outcome).toBe("missed");
    expect(score.spoken[0]?.stillCurrent).toBe("answered");
  });

  it("calls a sentence after the deadline late, as it does a card", () => {
    const score = scoreFixture(
      run({
        fixture: "offsite-plan",
        moments: [speakMoment()],
        spoken: [spokenLine({ atStreamMs: 130_000 })],
        matches: [spokenMatch()],
      }),
    );
    expect(score.moments[0]?.outcome).toBe("late");
    expect(score.speakLate).toBe(1);
  });

  it("scores a claim separately from the catch, with its own latency", () => {
    const score = scoreFixture(
      run({
        fixture: "offsite-plan",
        moments: [speakMoment()],
        spoken: [
          spokenLine(
            { id: "spoken-0", atStreamMs: 104_000 },
            {
              kind: "reserve",
              text: "I'll check the drive time.",
              questionToReserveMs: 2_400,
            },
          ),
          spokenLine({ id: "spoken-1" }),
        ],
        matches: [spokenMatch({ cardId: "spoken-1" })],
      }),
    );
    expect(score.moments[0]?.outcome).toBe("caught");
    expect(score.moments[0]?.reserved).toEqual({
      spokenId: "spoken-0",
      atMs: 104_000,
      questionToReserveMs: 2_400,
    });
  });
});

describe("scoreSettings, speech", () => {
  function gated(runs: FixtureRunRecord[]) {
    return scoreSettings({ frequency: "normal", boldness: "normal" }, runs, true);
  }

  it("gates speak recall on sentences, not on cards", () => {
    const group = gated([
      run({
        fixture: "offsite-plan",
        moments: [speakMoment(), speakMoment({ id: "s2" })],
        research: research(),
        matches: [match({ cardId: "research-packet-1", momentId: "s2" })],
        spoken: [spokenLine()],
      }),
    ]);
    expect(group.totals.speakMoments).toBe(2);
    expect(group.speakRecall).toBe(0);
    expect(gate(group, "speak recall").status).toBe("fail");
  });

  it("fails on an unprompted line that raised nothing, in a quiet conversation", () => {
    const group = gated([
      run({
        fixture: "brainstorm",
        moments: [],
        spoken: [spokenLine({}, { kind: "reserve", text: "I'll check the greenhouse." })],
      }),
    ]);
    expect(group.totals.falseSpeech).toBe(1);
    expect(gate(group, "no false speech").status).toBe("fail");
  });

  it("does not call a line about a planted moment false speech", () => {
    const group = gated([
      run({
        fixture: "rhetorical-questions",
        moments: [speakMoment()],
        spoken: [spokenLine()],
        matches: [spokenMatch()],
      }),
    ]);
    expect(group.totals.falseSpeech).toBe(0);
    expect(gate(group, "no false speech").status).toBe("pass");
  });

  it("leaves an unmatched line on a conversation with moments uncounted", () => {
    const group = gated([
      run({ fixture: "offsite-plan", moments: [speakMoment()], spoken: [spokenLine()] }),
    ]);
    expect(group.totals.spokenLines).toBe(1);
    expect(group.totals.falseSpeech).toBe(0);
    expect(group.fixtures[0]?.spoken[0]?.unmatched).toBe(true);
  });

  it("fails on a line said while somebody was talking", () => {
    const group = gated([
      run({ fixture: "offsite-plan", spoken: [spokenLine({ inPause: false })] }),
    ]);
    expect(group.totals.spokenInPause).toBe(0);
    expect(group.totals.spokenPlaced).toBe(1);
    expect(gate(group, "every unprompted line in a pause").status).toBe("fail");
  });

  it("fails on a line Sotto carried on over somebody with", () => {
    const group = gated([
      run({ fixture: "offsite-plan", spoken: [spokenLine({ overTurnId: "0:11" })] }),
    ]);
    expect(group.totals.spokenOverHuman).toBe(1);
    expect(gate(group, "nothing spoken over a human turn").status).toBe("fail");
  });

  it("passes the overrun gate as unmeasurable when the clock said nothing", () => {
    const group = gated([
      run({
        fixture: "offsite-plan",
        spoken: [spokenLine({ overTurnId: null, overrunMeasured: false })],
      }),
    ]);
    expect(group.totals.spokenOverrunMeasured).toBe(0);
    const over = gate(group, "nothing spoken over a human turn");
    expect(over.status).toBe("pass");
    expect(over.detail).toContain("not measurable");
  });

  it("counts a line nobody heard as neither in a pause nor out of one", () => {
    const group = gated([
      run({
        fixture: "offsite-plan",
        spoken: [
          spokenLine(
            { atStreamMs: null, inPause: null, pause: null },
            { spoken: false, reason: "no_gap" },
          ),
        ],
      }),
    ]);
    expect(group.totals.spokenLines).toBe(0);
    expect(group.totals.spokenSkipped).toBe(1);
    expect(gate(group, "every unprompted line in a pause").status).toBe("pass");
  });

  it("leaves a card the room called for out of every gate about speaking up", () => {
    const group = gated([
      run({
        fixture: "brainstorm",
        spoken: [
          spokenLine(
            { inPause: false, overTurnId: "0:11" },
            { kind: "called_on", ideaId: "card-cand-1", text: "Sotto noticed the budget." },
          ),
        ],
      }),
    ]);
    expect(group.totals.calledOn).toBe(1);
    expect(group.totals.spokenLines).toBe(0);
    expect(group.totals.falseSpeech).toBe(0);
    expect(group.totals.spokenOverHuman).toBe(0);
    expect(group.passed).toBe(true);
  });

  it("passes the speak gate when nothing was planted to speak about", () => {
    const group = gated([run({ fixture: "brainstorm" })]);
    expect(group.speakRecall).toBe(1);
    expect(gate(group, "speak recall").detail).toContain("no speak moments");
  });
});
