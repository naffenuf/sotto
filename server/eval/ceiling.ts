/**
 * How much recall the conversations can give at all (PRD US-016, US-023).
 *
 * `npm run eval` measures what Sotto actually caught. This measures the most
 * it could have caught, and it does so without a single model call, because
 * nothing about the limit depends on the model: a planted moment can only be
 * delivered inside its window, deliveries only happen in a pause, and the
 * policy only ever sees a candidate once the observer has looked.
 *
 * So the ceiling is three facts laid over each other, all of them already in
 * the captures:
 *
 *   1. **The window.** The trigger line's turn ends, the deadline line's turn
 *      ends ({@link resolveMoments}).
 *   2. **The look.** The observer runs after a board update (PRD US-012), and
 *      the board update loop waits for {@link NEW_TURNS_PER_UPDATE} new final
 *      turns or {@link UPDATE_INTERVAL_MS} (PRD US-009). Until then nobody has
 *      a candidate to decide about.
 *   3. **The pause.** Between the look and the deadline, the longest silence
 *      the transcription reported — which is what {@link inPause} is given.
 *
 * A moment is *reachable* at a pause threshold when that longest silence
 * clears it. Reachable is an upper bound, not a prediction: the observer still
 * has to notice the moment and the score still has to clear a threshold, and a
 * live board update lands a few hundred milliseconds after the turn end used
 * here. If a moment is unreachable, no prompt and no weight can catch it.
 */
import { NEW_TURNS_PER_UPDATE, UPDATE_INTERVAL_MS } from "../board/BoardUpdater.js";
import type { MomentRecord } from "../../shared/eval.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { pauseAt, turnIntervals, type TurnInterval } from "./pause.js";

/**
 * When the observer looks, on the session clock.
 *
 * The board loop's own rule, over final turns rather than over frames: an
 * update whenever `everyTurns` have gone final, or whenever `idleMs` has
 * passed since the first turn still waiting. A turn's end is used as the
 * moment it arrived, which is early by the API's processing lag — so the
 * looks come out slightly sooner than they really do, in the ceiling's favour.
 */
export function lookTimes(
  finals: readonly TurnUpdate[],
  everyTurns: number = NEW_TURNS_PER_UPDATE,
  idleMs: number = UPDATE_INTERVAL_MS,
): number[] {
  const times: number[] = [];
  let pending = 0;
  let oldestPendingAtMs = 0;
  for (const turn of finals) {
    const atMs = turn.endMs ?? turn.startMs;
    if (pending === 0) oldestPendingAtMs = atMs;
    pending += 1;
    if (pending >= everyTurns || atMs - oldestPendingAtMs >= idleMs) {
      times.push(atMs);
      pending = 0;
    }
  }
  return times;
}

/**
 * The longest silence the transcription reported in `[fromMs, untilMs]`.
 *
 * Exact rather than sampled, because silence only ever grows: under
 * {@link pauseAt} it is longest either at the very end of the range or in the
 * millisecond before somebody starts talking, so those are the only instants
 * worth asking about. A gap of exactly 500 ms therefore measures 499: at the
 * instant speech resumes somebody is talking, and that is the same answer the
 * policy's own timer would have got by waking up there.
 */
export function longestSilence(
  intervals: readonly TurnInterval[],
  fromMs: number,
  untilMs: number,
): number {
  const instants = [fromMs, untilMs];
  for (const interval of intervals) {
    const justBefore = interval.startMs - 1;
    if (justBefore > fromMs && justBefore < untilMs) instants.push(justBefore);
  }
  let longest = 0;
  for (const atMs of instants) {
    if (atMs > untilMs) continue;
    const state = pauseAt(intervals, atMs);
    if (!state.speaking && state.silentForMs > longest) longest = state.silentForMs;
  }
  return longest;
}

/** One planted moment, and the best Sotto could have done with it. */
export interface MomentReach {
  fixture: string;
  momentId: string;
  /** The window on the session clock, or `null` when its turns never resolved. */
  windowMs: { fromMs: number; untilMs: number } | null;
  /** The first look at or after the trigger turn ended, or `null` if there is none. */
  lookAtMs: number | null;
  /** How long after the trigger turn that look was. */
  lookDelayMs: number | null;
  /** The longest reported silence between that look and the deadline. */
  bestSilenceMs: number;
}

/** Places one moment against the looks and the silences of its own replay. */
export function momentReach(
  fixture: string,
  moment: MomentRecord,
  turns: readonly TurnUpdate[],
  everyTurns?: number,
): MomentReach {
  const fromMs = moment.triggerTurnEndMs;
  const untilMs = moment.deadlineTurnEndMs;
  const base = { fixture, momentId: moment.id };
  if (fromMs === null || untilMs === null) {
    return { ...base, windowMs: null, lookAtMs: null, lookDelayMs: null, bestSilenceMs: 0 };
  }
  const finals = turns.filter((turn) => turn.final);
  const lookAtMs = lookTimes(finals, everyTurns).find((atMs) => atMs >= fromMs) ?? null;
  return {
    ...base,
    windowMs: { fromMs, untilMs },
    lookAtMs,
    lookDelayMs: lookAtMs === null ? null : lookAtMs - fromMs,
    bestSilenceMs:
      lookAtMs === null ? 0 : longestSilence(turnIntervals(turns), lookAtMs, untilMs),
  };
}

/** Whether a moment could have been delivered at all at `pauseMs`. */
export function isReachable(reach: MomentReach, pauseMs: number): boolean {
  return reach.lookAtMs !== null && reach.bestSilenceMs >= pauseMs;
}

/** The pause thresholds the ceiling is reported at, lowest first. */
export const CEILING_THRESHOLDS_MS: readonly number[] = [
  100, 150, 200, 250, 300, 400, 500, 1_000, 1_500,
];

/** How many moments one threshold leaves reachable. */
export interface CeilingRow {
  pauseMs: number;
  reachable: number;
  total: number;
  /** `reachable / total`, or 0 when there are no moments. */
  recallCeiling: number;
}

/** The ceiling at each threshold, over every moment of every fixture. */
export function ceilingTable(
  reaches: readonly MomentReach[],
  thresholds: readonly number[] = CEILING_THRESHOLDS_MS,
): CeilingRow[] {
  return thresholds.map((pauseMs) => {
    const reachable = reaches.filter((reach) => isReachable(reach, pauseMs)).length;
    return {
      pauseMs,
      reachable,
      total: reaches.length,
      recallCeiling: reaches.length === 0 ? 0 : reachable / reaches.length,
    };
  });
}
