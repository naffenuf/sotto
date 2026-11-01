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
 *      the room really had — the transcription's gaps corrected for the
 *      endpointer's hangover, which is what {@link inPause} is given.
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
 * The longest silence the room really had in `[fromMs, untilMs]`.
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

/**
 * The margin a speak threshold has to leave (PRD V3-004).
 *
 * The pause a planted open question offers has to clear the threshold by this
 * much, so the number is not sitting on the one conversation it was measured
 * against — the quiet in a window is an upper bound on what the live pipeline
 * will see, since the board's lag, a turn arriving late and the next speaker
 * starting early all eat into it.
 */
export const SPEAK_MARGIN_MS = 500;

/**
 * The planted moment types that are the room wondering something aloud.
 *
 * A `research_hook` is exactly V3-002's `open_question`: a question somebody
 * asks the room that a lookup can settle. An `unanswered_question` is one only
 * the group can answer and a `contradiction` is nobody's question at all, so
 * neither is a moment V3-004 would ever speak into.
 */
export const SPEAK_MOMENT_TYPES = ["research_hook"] as const;

/**
 * Readiness offsets the quiet is also reported at (V3-004).
 *
 * The fast path takes a measured 13–28 s from the question going final to a
 * sourced packet, so the pause the answer can really take is the quiet *after*
 * that, not the quiet in the whole window. It is reported beside the window's
 * own best silence rather than used to pick the threshold, because the PRD's
 * rule is about the window — and because a packet that is ready after the
 * deadline has run out of window at any threshold.
 */
export const SPEAK_READY_OFFSETS_MS = [0, 10_000, 15_000, 20_000] as const;

/** One planted open question, and the quiet it offers an answer (V3-004). */
export interface SpeakReach {
  fixture: string;
  momentId: string;
  /** The window on the session clock, or `null` when its turns never resolved. */
  windowMs: { fromMs: number; untilMs: number } | null;
  /** The longest real quiet anywhere inside that window. */
  bestSilenceMs: number;
  /** The same, counting only from `offsetMs` after the question went final. */
  silenceByReady: { offsetMs: number; bestSilenceMs: number }[];
}

/**
 * Places one planted open question against the silences of its own replay.
 *
 * Unlike {@link momentReach} there is no observer look in it: an open question
 * goes straight from the classifier to a search (V3-002, V3-003) and never
 * waits for a board update, so the whole window is available in principle and
 * {@link SPEAK_READY_OFFSETS_MS} is what says what the search costs.
 */
export function speakReach(
  fixture: string,
  moment: MomentRecord,
  turns: readonly TurnUpdate[],
): SpeakReach {
  const fromMs = moment.triggerTurnEndMs;
  const untilMs = moment.deadlineTurnEndMs;
  const base = { fixture, momentId: moment.id };
  if (fromMs === null || untilMs === null) {
    return { ...base, windowMs: null, bestSilenceMs: 0, silenceByReady: [] };
  }
  const intervals = turnIntervals(turns);
  return {
    ...base,
    windowMs: { fromMs, untilMs },
    bestSilenceMs: longestSilence(intervals, fromMs, untilMs),
    silenceByReady: SPEAK_READY_OFFSETS_MS.map((offsetMs) => ({
      offsetMs,
      bestSilenceMs:
        fromMs + offsetMs >= untilMs
          ? 0
          : longestSilence(intervals, fromMs + offsetMs, untilMs),
    })),
  };
}

/**
 * The largest speak threshold that leaves every one of these questions a pause
 * with `marginMs` to spare, which is the PRD's rule for {@link SPEAK_PAUSE_MS}.
 *
 * `null` when there is nothing to measure. Negative when even the margin
 * cannot be met — reported as such rather than clamped, because a threshold of
 * zero would hide the fact that the rule failed.
 */
export function speakThresholdMs(
  reaches: readonly SpeakReach[],
  marginMs: number = SPEAK_MARGIN_MS,
): number | null {
  if (reaches.length === 0) return null;
  return Math.min(...reaches.map((reach) => reach.bestSilenceMs)) - marginMs;
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
