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
  ResearchDeliveryRecord,
  ResearchRunRecord,
  ScoredLevel,
} from "../../shared/eval.js";
import type { ExpectedLevel } from "../../shared/fixtures.js";
import { DEFAULT_GATE_MODE, type GateMode } from "../../shared/candidates.js";
import {
  DEFAULT_FREQUENCY,
  policySettingsLabel,
  type Boldness,
  type DeliveredLevel,
  type PolicySettings,
} from "../../shared/policy.js";

/** The gate: below this, `npm run eval` exits non-zero. */
export const MIN_MOMENT_RECALL = 0.7;

/**
 * The same gate for the research moments (V2-019), which are scored apart.
 *
 * Lower on purpose, and the v2 PRD sets it there: catching a `research_hook`
 * takes a gate verdict, a web search and a pause to show the card in, so a
 * window that an interjection can reach comfortably is tight for a packet.
 */
export const MIN_RESEARCH_RECALL = 0.5;

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

/**
 * `glow` < `interject` < `research` < `speak`: "the expected level or higher"
 * in one number.
 *
 * `research` is a level a policy delivery can never have and a research-ready
 * card always has (V2-014). Since V2-019 the two halves of the stage are
 * judged against the two kinds of moment they can catch and no further, so in
 * practice a research moment's outcome is `caught`, `late` or `missed`: the
 * rank is still here because the comparison is what *says* so.
 *
 * `speak` is a level no *card* has (V3-013): a moment that expected Sotto to
 * say something and got a card instead is `caught_low`, which is the truthful
 * answer until V3-010 scores spoken contributions in their own right.
 */
function levelRank(level: ScoredLevel | ExpectedLevel): number {
  return level === "speak" ? 3 : level === "research" ? 2 : level === "interject" ? 1 : 0;
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
  deliveredLevel: ScoredLevel | null;
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

/**
 * One research-ready card, scored (V2-019).
 *
 * Not a {@link DeliveryScore}, and that is the whole point: a research card
 * is not a decision to take the floor, so it is outside the precision gate
 * and outside the pause gate — the two gates about interrupting people. It
 * is still *measured* on both, because a card appearing mid-sentence is worth
 * knowing about even when nothing fails over it.
 */
export interface ResearchCardScore {
  cardId: string;
  packetId: string;
  title: string;
  deliveredAtMs: number;
  inPause: boolean;
  /** It went up in the drain, after the conversation had ended (V2-014). */
  atSessionEnd: boolean;
  /** The research moments the judge matched it to. */
  matchedMomentIds: string[];
  /** A card about nothing anybody planted. Counted, never gated. */
  unmatched: boolean;
}

/**
 * One fixture at one setting, scored.
 *
 * The moment counts are over the **non-research** moments, which is what the
 * recall gate is about; a `research_hook` is counted separately under
 * `research*`, because the two are caught by different halves of the stage
 * and have different targets (v2 PRD V2-019).
 */
export interface FixtureScore {
  fixture: string;
  settings: PolicySettings;
  moments: MomentScore[];
  deliveries: DeliveryScore[];
  /** The research-ready cards this replay showed (V2-019). */
  researchCards: ResearchCardScore[];
  /** What the research pipeline did, or `null` for a run recorded before V2-019. */
  research: ResearchRunRecord | null;
  caught: number;
  caughtLow: number;
  late: number;
  missed: number;
  /** Research moments caught inside their window. */
  researchCaught: number;
  researchLate: number;
  researchMissed: number;
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
  /** Planted moments the policy is meant to catch: everything but a hook. */
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
  /** Planted `research_hook` moments, which a research card catches (V2-019). */
  researchMoments: number;
  researchCaught: number;
  researchLate: number;
  researchMissed: number;
  /** Research-ready cards shown, and how many of them in a pause. */
  researchCards: number;
  researchCardsInPause: number;
  /** Cards the drain put up after the conversation ended, pause or not. */
  researchCardsAtSessionEnd: number;
  /** Research cards matching no planted hook. Counted, never gated. */
  unmatchedResearchCards: number;
  /** Ideas thought of, and what the gate did with them (V2-012). */
  researchIdeas: number;
  researchQueued: number;
  researchRejected: number;
  /** Gate verdicts that ran on the local model, which costs nothing. */
  localResearchGateCalls: number;
  /** Sourced packets, and the two ways a search produced none (V2-013). */
  researchPackets: number;
  unsourcedPackets: number;
  failedPackets: number;
  replayErrors: number;
}

export type GateStatus = "pass" | "fail" | "skipped";

/** One thing the run has to be true for `npm run eval` to exit zero. */
export interface GateResult {
  name: string;
  status: GateStatus;
  detail: string;
}

/**
 * What one judgment path's gate calls cost, over a group of fixtures.
 *
 * V3-001 split the two paths — Spark gates interjections, Glimmer gates
 * research — so latency is reported per path, since that is the whole basis
 * of the split: 16–21 s inside a 16–21 s search is affordable and 24–34 s
 * inside a 12–29 s interjection window is not.
 */
export interface PathGateScore {
  /** How many gate calls came back. Zero under `--gate spark`, which makes none. */
  calls: number;
  /** Of those, how many ran on Muse Glimmer rather than falling back to Spark. */
  local: number;
  /** Calls that came back with no verdict. */
  failed: number;
  /** Median real milliseconds a call took, or `null` when none were made. */
  medianLatencyMs: number | null;
  /** The slowest call: what the worst-case moment paid. */
  maxLatencyMs: number | null;
}

/** What the interjection gate did and cost, over one group of fixtures (V2-016). */
export interface GateScore extends PathGateScore {
  /** Who scored the candidates: the local gate, or the observer itself. */
  mode: GateMode;
}

/** Everything one pair of settings scored. */
export interface SettingsScore {
  settings: PolicySettings;
  fixtures: FixtureScore[];
  totals: ScoreTotals;
  /** (caught + caught_low) / moments. A `late` catch does not count. */
  recall: number;
  /** researchCaught / researchMoments; 1 when none were planted (V2-019). */
  researchRecall: number;
  /** trueInterjects / interjects; 1 when Sotto interjected not at all. */
  interjectPrecision: number;
  /** deliveriesInPause / deliveries; 1 when there were none. */
  pauseRate: number;
  /** Median delay from the trigger line's end to delivery, over matched moments. */
  medianDelayMs: number | null;
  /** What the interjection gate did and cost in this group (V2-016). */
  gate: GateScore;
  /** What the research gate did and cost in this group (V2-012, reported V3-001). */
  researchGate: PathGateScore;
  gates: GateResult[];
  passed: boolean;
}

/** A whole run, scored: one group per pair of settings it was run at. */
export interface RunScore {
  /** False when `--no-judge` ran: nothing was matched, so nothing is gated. */
  judged: boolean;
  groups: SettingsScore[];
  passed: boolean;
}

/**
 * What one fixture run was run at.
 *
 * A record written before V2-017 carries the one `chattiness` setting
 * instead, which mapped to exactly these thresholds — `quiet` to `cautious`,
 * `normal` to `normal`, `active` to `bold` — while the cooldown and the
 * budget were constants equal to `normal` frequency's. So an old report still
 * renders, under the names the numbers it was measured with have now.
 */
export function settingsOf(run: Pick<FixtureRunRecord, "settings" | "chattiness">): PolicySettings {
  if (run.settings !== undefined) return run.settings;
  return { frequency: DEFAULT_FREQUENCY, boldness: boldnessFromChattiness(run.chattiness) };
}

/** The boldness one pre-V2-017 chattiness setting is the same thresholds as. */
export function boldnessFromChattiness(chattiness: string | undefined): Boldness {
  if (chattiness === "quiet") return "cautious";
  if (chattiness === "active") return "bold";
  return "normal";
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
  moment: Pick<MomentRecord, "expectedLevel">,
  delivery: { level: ScoredLevel; deliveredAtMs: number },
  window: { startMs: number; endMs: number },
): Exclude<MomentOutcome, "missed"> {
  if (delivery.deliveredAtMs > window.endMs) return "late";
  if (levelRank(delivery.level) < levelRank(moment.expectedLevel)) return "caught_low";
  return "caught";
}

/**
 * A card as the moment scoring compares it: when it went out, and at what
 * level. Both halves of the stage reduce to this.
 */
interface ScoredCard {
  cardId: string;
  level: ScoredLevel;
  deliveredAtMs: number;
}

/** A research moment expects a research card; everything else expects the policy. */
function expectsResearch(moment: Pick<MomentRecord, "expectedLevel">): boolean {
  return moment.expectedLevel === "research";
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
  const research = run.research ?? null;
  const researchCards: ResearchCardScore[] = (research?.cards ?? []).map((card) => {
    const matched = byCard.get(card.cardId) ?? [];
    return {
      cardId: card.cardId,
      packetId: card.packetId,
      title: card.title,
      deliveredAtMs: card.deliveredAtMs,
      inPause: card.inPause,
      atSessionEnd: card.atSessionEnd,
      matchedMomentIds: matched.map((match) => match.momentId),
      unmatched: matched.length === 0,
    };
  });

  // The pool a moment can be caught by: a research hook by a research card
  // (V2-014), everything else by the policy. The judge is only asked about
  // these pairs either, so nothing is lost by not looking at the other.
  const policyPool: ScoredCard[] = run.deliveries.map((delivery) => ({
    cardId: delivery.cardId,
    level: delivery.level,
    deliveredAtMs: delivery.deliveredAtMs,
  }));
  const researchPool: ScoredCard[] = (research?.cards ?? []).map((card) => ({
    cardId: card.cardId,
    level: "research",
    deliveredAtMs: card.deliveredAtMs,
  }));

  const moments: MomentScore[] = run.moments.map((moment) => {
    const window = windowFor(moment);
    let best: { outcome: Exclude<MomentOutcome, "missed">; card: ScoredCard } | null = null;
    for (const card of expectsResearch(moment) ? researchPool : policyPool) {
      const matched = (byCard.get(card.cardId) ?? []).some(
        (match) => match.momentId === moment.id,
      );
      if (!matched) continue;
      const outcome = outcomeFor(moment, card, window);
      // Best outcome wins; between two of the same, the earlier card.
      if (
        best === null ||
        outcomeRank(outcome) < outcomeRank(best.outcome) ||
        (outcomeRank(outcome) === outcomeRank(best.outcome) &&
          card.deliveredAtMs < best.card.deliveredAtMs)
      ) {
        best = { outcome, card };
      }
    }
    const reason =
      best === null
        ? null
        : (run.matches.find(
            (match) => match.cardId === best?.card.cardId && match.momentId === moment.id,
          )?.reason ?? null);
    return {
      momentId: moment.id,
      type: moment.type,
      expectedLevel: moment.expectedLevel,
      description: moment.description,
      outcome: best?.outcome ?? "missed",
      cardId: best?.card.cardId ?? null,
      deliveredLevel: best?.card.level ?? null,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      delayMs: best === null ? null : best.card.deliveredAtMs - window.startMs,
      judgeReason: reason,
    };
  });

  const count = (outcome: MomentOutcome, research: boolean): number =>
    moments.filter((one) => expectsResearch(one) === research && one.outcome === outcome).length;
  const unmatchedAt = (level: DeliveredLevel): number =>
    deliveries.filter((one) => one.unmatched && one.level === level).length;

  return {
    fixture: run.fixture,
    settings: settingsOf(run),
    moments,
    deliveries,
    researchCards,
    research,
    caught: count("caught", false),
    caughtLow: count("caught_low", false),
    late: count("late", false),
    missed: count("missed", false),
    // A research moment can only be caught at the level it expects, so
    // `caught_low` is counted with the catches rather than losing one.
    researchCaught: count("caught", true) + count("caught_low", true),
    researchLate: count("late", true),
    researchMissed: count("missed", true),
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
    researchMoments: 0,
    researchCaught: 0,
    researchLate: 0,
    researchMissed: 0,
    researchCards: 0,
    researchCardsInPause: 0,
    researchCardsAtSessionEnd: 0,
    unmatchedResearchCards: 0,
    researchIdeas: 0,
    researchQueued: 0,
    researchRejected: 0,
    localResearchGateCalls: 0,
    researchPackets: 0,
    unsourcedPackets: 0,
    failedPackets: 0,
    replayErrors: 0,
  };
  for (const fixture of fixtures) {
    totals.moments += fixture.caught + fixture.caughtLow + fixture.late + fixture.missed;
    totals.caught += fixture.caught;
    totals.caughtLow += fixture.caughtLow;
    totals.late += fixture.late;
    totals.missed += fixture.missed;
    totals.researchMoments +=
      fixture.researchCaught + fixture.researchLate + fixture.researchMissed;
    totals.researchCaught += fixture.researchCaught;
    totals.researchLate += fixture.researchLate;
    totals.researchMissed += fixture.researchMissed;
    totals.deliveries += fixture.deliveries.length;
    totals.deliveriesInPause += fixture.deliveriesInPause;
    totals.falseInterjects += fixture.falseInterjects;
    totals.falseGlows += fixture.falseGlows;
    totals.researchCards += fixture.researchCards.length;
    totals.researchCardsInPause += fixture.researchCards.filter((one) => one.inPause).length;
    totals.researchCardsAtSessionEnd += fixture.researchCards.filter(
      (one) => one.atSessionEnd,
    ).length;
    totals.unmatchedResearchCards += fixture.researchCards.filter((one) => one.unmatched).length;
    if (fixture.research !== null) {
      totals.researchIdeas += fixture.research.ideas;
      totals.researchQueued += fixture.research.queued;
      totals.researchRejected += fixture.research.rejected;
      totals.localResearchGateCalls += fixture.research.localGateCalls;
      totals.researchPackets += fixture.research.packets;
      totals.unsourcedPackets += fixture.research.unsourced;
      totals.failedPackets += fixture.research.failed;
    }
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
 * The three gates of US-016, V2-019's research recall beside them, plus the
 * one that is not a judgement: a replay that threw produced no numbers, so
 * the run failed whatever the rest says.
 *
 * Research cards are deliberately outside the two gates about interrupting
 * people — the precision gate and the pause gate. A research card is not a
 * decision to take the floor, and the one it would break is by design: a
 * packet still waiting when the conversation ends goes up anyway (V2-014).
 *
 * Unjudged runs (`--no-judge`) skip the two that need matches. A skipped gate
 * is not a passed one, and the report says so.
 */
function gatesFor(
  totals: ScoreTotals,
  recall: number,
  researchRecall: number,
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
      `research recall >= ${MIN_RESEARCH_RECALL}`,
      totals.researchMoments === 0 || researchRecall >= MIN_RESEARCH_RECALL,
      totals.researchMoments === 0
        ? "no research moments in this run"
        : `${formatRatio(researchRecall)} (${totals.researchCaught}/${totals.researchMoments})`,
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

/** One pair of settings' fixtures, scored and gated together. */
export function scoreSettings(
  settings: PolicySettings,
  runs: readonly FixtureRunRecord[],
  judged: boolean,
  gateMode: GateMode = DEFAULT_GATE_MODE,
): SettingsScore {
  const fixtures = runs.map(scoreFixture);
  const totals = totalsOf(fixtures);
  const recall = totals.moments === 0 ? 1 : (totals.caught + totals.caughtLow) / totals.moments;
  const interjectPrecision =
    totals.interjects === 0 ? 1 : totals.trueInterjects / totals.interjects;
  const researchRecall =
    totals.researchMoments === 0 ? 1 : totals.researchCaught / totals.researchMoments;
  const pauseRate =
    totals.deliveries === 0 ? 1 : totals.deliveriesInPause / totals.deliveries;
  const delays = fixtures
    .flatMap((fixture) => fixture.moments)
    .map((moment) => moment.delayMs)
    .filter((delay): delay is number => delay !== null);
  const gates = gatesFor(totals, recall, researchRecall, pauseRate, judged);
  return {
    settings,
    fixtures,
    totals,
    recall,
    researchRecall,
    interjectPrecision,
    pauseRate,
    medianDelayMs: median(delays),
    gate: scoreGate(gateMode, runs),
    researchGate: scoreResearchGate(runs),
    gates,
    passed: gates.every((one) => one.status !== "fail"),
  };
}

/**
 * The gate's own numbers (V2-016): who answered, and how long they took.
 *
 * Latency is a wall-clock measurement a replay can still make honestly — the
 * session clock stands still during a call, but a local model takes the time
 * it takes — and it is the number that decides whether the gate can live
 * inside a planted moment's window at all.
 */
export function scoreGate(mode: GateMode, runs: readonly FixtureRunRecord[]): GateScore {
  const calls = runs.flatMap((run) => run.gateCalls ?? []);
  const latencies = calls.map((call) => call.latencyMs);
  return {
    mode,
    calls: calls.length,
    local: calls.filter((call) => call.gate === "glimmer").length,
    failed: calls.filter((call) => call.error !== undefined).length,
    medianLatencyMs: median(latencies),
    maxLatencyMs: latencies.length === 0 ? null : Math.max(...latencies),
  };
}

/**
 * The research gate's own numbers (V2-012), reported per path by V3-001.
 *
 * Read off each run's `research.gateLatencyMs`, which comes straight from
 * `research.jsonl` — a record written before V3-001 has none, and then the
 * call count is all the report can say.
 */
export function scoreResearchGate(runs: readonly FixtureRunRecord[]): PathGateScore {
  const latencies = runs.flatMap((run) => run.research?.gateLatencyMs ?? []);
  let calls = 0;
  let local = 0;
  let failed = 0;
  for (const run of runs) {
    const research = run.research;
    if (research === undefined) continue;
    calls += research.queued + research.rejected + research.gateFailed;
    local += research.localGateCalls;
    failed += research.gateFailed;
  }
  return {
    calls,
    local,
    failed,
    medianLatencyMs: median(latencies),
    maxLatencyMs: latencies.length === 0 ? null : Math.max(...latencies),
  };
}

/**
 * A whole run record, scored.
 *
 * Each pair of settings is scored and gated on its own: running three
 * boldnesses is three experiments, and a `cautious` run that interjects
 * nothing should not lend its precision to a `bold` one that interjects
 * everywhere.
 */
export function scoreRun(record: EvalRunRecord): RunScore {
  // `--no-judge` leaves no prompt hash, because no judge was built.
  const judged = record.judge.promptHash !== "";
  // A run recorded before V2-016 has no gate: the observer's own scores were
  // all there was, which is what `spark` means.
  const gateMode = record.gate ?? "spark";
  const groups = settingsAsked(record).map((settings) =>
    scoreSettings(
      settings,
      record.runs.filter((run) => policySettingsLabel(settingsOf(run)) === policySettingsLabel(settings)),
      judged,
      gateMode,
    ),
  );
  return { judged, groups, passed: groups.every((group) => group.passed) };
}

/**
 * The settings a run was asked for, in order — off the record's own list when
 * it has one (a pre-V2-017 record's `chattiness` list counts, mapped), and
 * otherwise off the runs themselves.
 */
export function settingsAsked(record: EvalRunRecord): PolicySettings[] {
  const asked =
    record.settings ??
    record.chattiness?.map((chattiness) => ({
      frequency: DEFAULT_FREQUENCY,
      boldness: boldnessFromChattiness(chattiness),
    }));
  const list = asked !== undefined && asked.length > 0 ? asked : record.runs.map(settingsOf);
  const seen = new Map<string, PolicySettings>();
  for (const one of list) seen.set(policySettingsLabel(one), one);
  return [...seen.values()];
}
