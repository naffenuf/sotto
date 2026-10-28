/**
 * Turning a run record into numbers (PRD US-016 part 2).
 *
 * Pure, and deliberately separate from the replaying: `eval/runs/<id>.json`
 * holds everything a replay saw, so a scoring change — a different window, a
 * different threshold — is recomputed from the file and costs no API calls.
 * `npm run eval:report` exists for exactly that.
 *
 * Two things here are easy to get subtly wrong, so they are stated once:
 *
 *   - **Which clock the window is on.** A moment's window is "after
 *     `triggerLine` ends, before `deadlineLine` ends" and those lines are
 *     positions in the *audio*; a delivery time is on the session clock,
 *     ~700 ms ahead of the audio it describes. So the window is taken from
 *     the session-clock ends of the turns those very lines produced
 *     (`MomentRecord.triggerTurnEndMs` / `deadlineTurnEndMs`, resolved from
 *     `timing.json` in `moments.ts`), and the scripted times are the fallback
 *     for a line no turn overlapped. Same lines, right clock.
 *   - **Which delivery a moment is scored by.** A moment can match more than
 *     one card — a glow, then an interjection. The PRD lists the outcomes in
 *     order of quality, so the *best* of them is the moment's outcome, and
 *     the card that earned it is the one the report names.
 */
import type {
  DeliveryRecord,
  EvalRunRecord,
  FixtureRunRecord,
  JudgeMatchRecord,
  MomentRecord,
} from "../../shared/eval.js";
import type { Chattiness, DeliveredLevel } from "../../shared/policy.js";

/** The gate: below this, `npm run eval` exits non-zero. */
export const MIN_MOMENT_RECALL = 0.7;

/**
 * The conversations with nothing planted in them. Sotto interjecting here is
 * a false positive with no judgement call about it, so it is its own gate.
 */
export const QUIET_FIXTURES = ["brainstorm", "no-wake"] as const;

export function isQuietFixture(fixture: string): boolean {
  return (QUIET_FIXTURES as readonly string[]).includes(fixture);
}

/** What became of one planted moment. Best first; {@link outcomeRank} agrees. */
export const momentOutcomes = ["caught", "caught_low", "late", "missed"] as const;
export type MomentOutcome = (typeof momentOutcomes)[number];

function outcomeRank(outcome: MomentOutcome): number {
  return momentOutcomes.indexOf(outcome);
}

/** `glow` < `interject`: "the expected level or higher" in one number. */
function levelRank(level: DeliveredLevel): number {
  return level === "interject" ? 1 : 0;
}

/** One planted moment, scored. */
export interface MomentScore {
  momentId: string;
  type: MomentRecord["type"];
  expectedLevel: MomentRecord["expectedLevel"];
  description: string;
  outcome: MomentOutcome;
  /** The card the outcome came from, or `null` when the moment was missed. */
  cardId: string | null;
  deliveredLevel: DeliveredLevel | null;
  /** The window, on the session clock. A delivery is compared to these. */
  windowStartMs: number;
  windowEndMs: number;
  /** Delivery minus {@link windowStartMs}; negative if Sotto got there first. */
  delayMs: number | null;
  /** The judge's sentence, for the report's notes column. */
  judgeReason: string | null;
}

/** One card, scored. */
export interface DeliveryScore {
  cardId: string;
  level: DeliveredLevel;
  type: DeliveryRecord["type"];
  headline: string;
  deliveredAtMs: number;
  inPause: boolean;
  reason: DeliveryRecord["reason"];
  score: number | null;
  /** The moments the judge matched it to. Empty means it raised nothing planted. */
  matchedMomentIds: string[];
  /** A delivery matching no planted moment: a false interject or false glow. */
  unmatched: boolean;
}

/** One fixture at one setting, scored. */
export interface FixtureScore {
  fixture: string;
  chattiness: Chattiness;
  moments: MomentScore[];
  deliveries: DeliveryScore[];
  caught: number;
  caughtLow: number;
  late: number;
  missed: number;
  /** `interject` cards matching no moment. On a quiet fixture, a gate failure. */
  falseInterjects: number;
  /** `glow` cards matching no moment. Counted, not gated. */
  falseGlows: number;
  deliveriesInPause: number;
  /** Set when the replay failed; everything else is then empty. */
  error?: string;
}

/** The totals the headline metrics are computed from. */
export interface ScoreTotals {
  moments: number;
  caught: number;
  caughtLow: number;
  late: number;
  missed: number;
  deliveries: number;
  deliveriesInPause: number;
  interjects: number;
  /** `interject` cards matching at least one moment. */
  trueInterjects: number;
  glows: number;
  falseInterjects: number;
  falseGlows: number;
  /** False interjects on `brainstorm` and `no-wake` only. Gated. */
  quietFalseInterjects: number;
  replayErrors: number;
}

export type GateStatus = "pass" | "fail" | "skipped";

/** One thing the run has to be true for `npm run eval` to exit zero. */
export interface GateResult {
  name: string;
  status: GateStatus;
  detail: string;
}

/** Everything one chattiness setting scored. */
export interface ChattinessScore {
  chattiness: Chattiness;
  fixtures: FixtureScore[];
  totals: ScoreTotals;
  /** (caught + caught_low) / moments. A `late` catch does not count. */
  recall: number;
  /** trueInterjects / interjects; 1 when Sotto interjected not at all. */
  interjectPrecision: number;
  /** deliveriesInPause / deliveries; 1 when there were none. */
  pauseRate: number;
  /** Median delay from the trigger line's end to delivery, over matched moments. */
  medianDelayMs: number | null;
  gates: GateResult[];
  passed: boolean;
}

/** A whole run, scored: one group per chattiness setting it was run at. */
export interface RunScore {
  /** False when `--no-judge` ran: nothing was matched, so nothing is gated. */
  judged: boolean;
  groups: ChattinessScore[];
  passed: boolean;
}

/** The moments a card was matched to, by card id. Only `matches: true` counts. */
function matchesByCard(matches: readonly JudgeMatchRecord[]): Map<string, JudgeMatchRecord[]> {
  const byCard = new Map<string, JudgeMatchRecord[]>();
  for (const match of matches) {
    if (!match.matches) continue;
    const list = byCard.get(match.cardId);
    if (list === undefined) byCard.set(match.cardId, [match]);
    else list.push(match);
  }
  return byCard;
}

/**
 * The window a moment has to be caught in, on the session clock.
 *
 * The turn ends are the scripted lines as the policy actually heard them; the
 * scripted times stand in for a line the transcription produced no turn for.
 * A deadline that ends up before its trigger (a one-line window, trimmed
 * differently at each end) is widened to the trigger, never inverted.
 */
export function windowFor(moment: MomentRecord): { startMs: number; endMs: number } {
  const startMs = moment.triggerTurnEndMs ?? moment.triggerEndMs;
  const endMs = moment.deadlineTurnEndMs ?? moment.deadlineEndMs;
  return { startMs, endMs: Math.max(startMs, endMs) };
}

/**
 * What one delivery makes of one moment.
 *
 * Lateness is decided before the level: a card that arrived after the group
 * had moved on did not catch the moment, however well it was pitched.
 */
export function outcomeFor(
  moment: MomentRecord,
  delivery: DeliveryRecord,
  window: { startMs: number; endMs: number },
): Exclude<MomentOutcome, "missed"> {
  if (delivery.deliveredAtMs > window.endMs) return "late";
  if (levelRank(delivery.level) < levelRank(moment.expectedLevel)) return "caught_low";
  return "caught";
}

/** One fixture's run, scored against the moments its script planted. */
export function scoreFixture(run: FixtureRunRecord): FixtureScore {
  const byCard = matchesByCard(run.matches);
  const deliveries: DeliveryScore[] = run.deliveries.map((delivery) => {
    const matched = byCard.get(delivery.cardId) ?? [];
    return {
      cardId: delivery.cardId,
      level: delivery.level,
      type: delivery.type,
      headline: delivery.headline,
      deliveredAtMs: delivery.deliveredAtMs,
      inPause: delivery.inPause,
      reason: delivery.reason,
      score: delivery.score,
      matchedMomentIds: matched.map((match) => match.momentId),
      unmatched: matched.length === 0,
    };
  });

  const moments: MomentScore[] = run.moments.map((moment) => {
    const window = windowFor(moment);
    let best: { outcome: Exclude<MomentOutcome, "missed">; delivery: DeliveryRecord } | null = null;
    for (const delivery of run.deliveries) {
      const matched = (byCard.get(delivery.cardId) ?? []).some(
        (match) => match.momentId === moment.id,
      );
      if (!matched) continue;
      const outcome = outcomeFor(moment, delivery, window);
      // Best outcome wins; between two of the same, the earlier card.
      if (
        best === null ||
        outcomeRank(outcome) < outcomeRank(best.outcome) ||
        (outcomeRank(outcome) === outcomeRank(best.outcome) &&
          delivery.deliveredAtMs < best.delivery.deliveredAtMs)
      ) {
        best = { outcome, delivery };
      }
    }
    const reason =
      best === null
        ? null
        : (run.matches.find(
            (match) => match.cardId === best?.delivery.cardId && match.momentId === moment.id,
          )?.reason ?? null);
    return {
      momentId: moment.id,
      type: moment.type,
      expectedLevel: moment.expectedLevel,
      description: moment.description,
      outcome: best?.outcome ?? "missed",
      cardId: best?.delivery.cardId ?? null,
      deliveredLevel: best?.delivery.level ?? null,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      delayMs: best === null ? null : best.delivery.deliveredAtMs - window.startMs,
      judgeReason: reason,
    };
  });

  const count = (outcome: MomentOutcome): number =>
    moments.filter((one) => one.outcome === outcome).length;
  const unmatchedAt = (level: DeliveredLevel): number =>
    deliveries.filter((one) => one.unmatched && one.level === level).length;

  return {
    fixture: run.fixture,
    chattiness: run.chattiness,
    moments,
    deliveries,
    caught: count("caught"),
    caughtLow: count("caught_low"),
    late: count("late"),
    missed: count("missed"),
    falseInterjects: unmatchedAt("interject"),
    falseGlows: unmatchedAt("glow"),
    deliveriesInPause: deliveries.filter((one) => one.inPause).length,
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

function totalsOf(fixtures: readonly FixtureScore[]): ScoreTotals {
  const totals: ScoreTotals = {
    moments: 0,
    caught: 0,
    caughtLow: 0,
    late: 0,
    missed: 0,
    deliveries: 0,
    deliveriesInPause: 0,
    interjects: 0,
    trueInterjects: 0,
    glows: 0,
    falseInterjects: 0,
    falseGlows: 0,
    quietFalseInterjects: 0,
    replayErrors: 0,
  };
  for (const fixture of fixtures) {
    totals.moments += fixture.moments.length;
    totals.caught += fixture.caught;
    totals.caughtLow += fixture.caughtLow;
    totals.late += fixture.late;
    totals.missed += fixture.missed;
    totals.deliveries += fixture.deliveries.length;
    totals.deliveriesInPause += fixture.deliveriesInPause;
    totals.falseInterjects += fixture.falseInterjects;
    totals.falseGlows += fixture.falseGlows;
    if (isQuietFixture(fixture.fixture)) totals.quietFalseInterjects += fixture.falseInterjects;
    if (fixture.error !== undefined) totals.replayErrors += 1;
    for (const delivery of fixture.deliveries) {
      if (delivery.level === "interject") {
        totals.interjects += 1;
        if (!delivery.unmatched) totals.trueInterjects += 1;
      } else {
        totals.glows += 1;
      }
    }
  }
  return totals;
}

/** The middle value, averaging the two middles of an even-length list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * The three gates of US-016, plus the one that is not a judgement: a replay
 * that threw produced no numbers, so the run failed whatever the rest says.
 *
 * Unjudged runs (`--no-judge`) skip the two that need matches. A skipped gate
 * is not a passed one, and the report says so.
 */
function gatesFor(
  totals: ScoreTotals,
  recall: number,
  pauseRate: number,
  judged: boolean,
): GateResult[] {
  const gate = (name: string, ok: boolean, detail: string, needsJudge = true): GateResult => ({
    name,
    status: needsJudge && !judged ? "skipped" : ok ? "pass" : "fail",
    detail: needsJudge && !judged ? "judging skipped" : detail,
  });
  return [
    gate(
      `moment recall >= ${MIN_MOMENT_RECALL}`,
      totals.moments === 0 || recall >= MIN_MOMENT_RECALL,
      totals.moments === 0 ? "no moments in this run" : formatRatio(recall),
    ),
    gate(
      `no false interject on ${QUIET_FIXTURES.join(" or ")}`,
      totals.quietFalseInterjects === 0,
      `${totals.quietFalseInterjects} found`,
    ),
    gate(
      "every delivery in a pause",
      totals.deliveries === totals.deliveriesInPause,
      totals.deliveries === 0
        ? "nothing was delivered"
        : `${totals.deliveriesInPause}/${totals.deliveries} (${formatRatio(pauseRate)})`,
      false,
    ),
    gate(
      "every replay completed",
      totals.replayErrors === 0,
      `${totals.replayErrors} failed`,
      false,
    ),
  ];
}

/** `0.67`, for a gate's detail line. */
function formatRatio(value: number): string {
  return value.toFixed(2);
}

/** One chattiness setting's fixtures, scored and gated together. */
export function scoreChattiness(
  chattiness: Chattiness,
  runs: readonly FixtureRunRecord[],
  judged: boolean,
): ChattinessScore {
  const fixtures = runs.map(scoreFixture);
  const totals = totalsOf(fixtures);
  const recall = totals.moments === 0 ? 1 : (totals.caught + totals.caughtLow) / totals.moments;
  const interjectPrecision =
    totals.interjects === 0 ? 1 : totals.trueInterjects / totals.interjects;
  const pauseRate =
    totals.deliveries === 0 ? 1 : totals.deliveriesInPause / totals.deliveries;
  const delays = fixtures
    .flatMap((fixture) => fixture.moments)
    .map((moment) => moment.delayMs)
    .filter((delay): delay is number => delay !== null);
  const gates = gatesFor(totals, recall, pauseRate, judged);
  return {
    chattiness,
    fixtures,
    totals,
    recall,
    interjectPrecision,
    pauseRate,
    medianDelayMs: median(delays),
    gates,
    passed: gates.every((one) => one.status !== "fail"),
  };
}

/**
 * A whole run record, scored.
 *
 * Each chattiness setting is scored and gated on its own: running three of
 * them is three experiments, and a `quiet` run that interjects nothing should
 * not lend its precision to an `active` one that interjects everywhere.
 */
export function scoreRun(record: EvalRunRecord): RunScore {
  // `--no-judge` leaves no prompt hash, because no judge was built.
  const judged = record.judge.promptHash !== "";
  const settings =
    record.chattiness.length > 0
      ? record.chattiness
      : [...new Set(record.runs.map((run) => run.chattiness))];
  const groups = settings.map((chattiness) =>
    scoreChattiness(
      chattiness,
      record.runs.filter((run) => run.chattiness === chattiness),
      judged,
    ),
  );
  return { judged, groups, passed: groups.every((group) => group.passed) };
}
