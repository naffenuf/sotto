/**
 * Placing what Sotto said out loud in the conversation it said it in (PRD
 * V3-010).
 *
 * The interjection eval measures cards: when one went up, whether the room
 * was quiet, and whether a judge thinks it raised a planted moment. V3 gave
 * Sotto a voice it uses unasked, so the same three questions have to be asked
 * of a sentence — and two more that only speech can fail: did it wait for the
 * kind of pause its own rule asks for, and did it carry on over somebody who
 * started talking.
 *
 * One rule makes this module serve both harnesses. Everything is placed on
 * the **transcription stream's** timeline, read off Sotto's own transcript row
 * (V2-008a) rather than off the record's `atMs`: a replay's session clock is
 * the stream clock, but a live session's counts from the start of the process,
 * so `atMs` cannot be subtracted from a turn's `startMs` there. The row exists
 * only when something reported *playing* the utterance, which is also the only
 * definition of "the room heard it" the project has.
 *
 * Pure, so `npm test` covers the judgement and the APIs are only paid for the
 * evidence — the same split `server/e2e/checks.ts` follows.
 */
import type { SpokenRecord } from "../../shared/eval.js";
import {
  estimateSpokenMs,
  isUnpromptedKind,
  spokenTurnId,
  type SpokenContributionKind,
  type SpokenContributionRecord,
} from "../../shared/spoken.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { PAUSE_MS, SPEAK_PAUSE_MS, inPause } from "../interject/policy.js";
import { pauseAt, turnIntervals, type TurnInterval } from "./pause.js";

/**
 * How quiet the room has to have been for one kind of line, in milliseconds.
 *
 * Each kind is measured against the threshold it really waits for
 * (`server/question/Reservations.ts`): a claim and its closing line take the
 * policy's own gap, an answer, a correction, a read-back and an offer take
 * V3-004's shorter one, and the two the room asked for — a card it called for
 * (V3-017) and the ideas it said yes to (V3-007) — wait for no silence at all,
 * since they stopped talking to ask, so all that is asked of those is that
 * nobody was mid-sentence.
 */
export function pauseThresholdFor(kind: SpokenContributionKind): number {
  if (kind === "called_on" || kind === "ideas" || kind === "held_offer") return 0;
  if (kind === "reserve" || kind === "no_answer") return PAUSE_MS;
  return SPEAK_PAUSE_MS;
}

/** Everything the placing needs: the log, the room's turns, and Sotto's. */
export interface SpokenInput {
  /** The `spoken_contribution` lines of `timing.jsonl`, in log order. */
  records: readonly SpokenContributionRecord[];
  /** The room's turn snapshots — Sotto's own are not among them (V2-008a). */
  turns: readonly TurnUpdate[];
  /** Sotto's own transcript rows, which are what place a line on the stream. */
  sottoTurns: readonly TurnUpdate[];
  /**
   * Whether this run spent real seconds saying things (default true).
   *
   * `npm run eval` passes false. In a `max` replay the whole utterance happens
   * inside one `clock.track`ed call, so simulated time does not move: a claim
   * and the answer behind it both land at the instant the question did, and
   * the room's next scripted turn always looks as though it started
   * mid-sentence. Reporting that as Sotto talking over somebody would be an
   * artifact of the clock, so the replay reports it as unmeasured instead and
   * `npm run e2e` is where the rule is really checked.
   */
  speechTakesTime?: boolean;
}

/** Every spoken line, placed. Ids are `spoken-<n>` in the log's own order. */
export function spokenRecords(input: SpokenInput): SpokenRecord[] {
  const intervals = turnIntervals(input.turns);
  const rows = new Map<string, TurnUpdate>();
  for (const turn of input.sottoTurns) rows.set(turn.turnId, turn);
  const measured = input.speechTakesTime !== false;
  return input.records.map((record, index) =>
    placeSpoken(record, `spoken-${index}`, rows.get(spokenTurnId(record)), intervals, measured),
  );
}

/** One line, against the conversation around it. */
export function placeSpoken(
  record: SpokenContributionRecord,
  id: string,
  row: TurnUpdate | undefined,
  intervals: readonly TurnInterval[],
  overrunMeasured = true,
): SpokenRecord {
  // No row means nothing was heard — a line that never found a gap, or one
  // cut off before the page reported a playback position — so there is no
  // instant in the conversation to measure anything against.
  if (row === undefined) {
    return {
      id,
      record,
      atStreamMs: null,
      endsAtStreamMs: null,
      inPause: null,
      pause: null,
      overTurnId: null,
      overrunMeasured: false,
    };
  }
  const atStreamMs = row.startMs;
  const endsAtStreamMs = atStreamMs + estimateSpokenMs(row.text === "" ? record.text : row.text);
  const pause = pauseAt(intervals, atStreamMs);
  return {
    id,
    record,
    atStreamMs,
    endsAtStreamMs,
    inPause: inPause(pause, pauseThresholdFor(record.kind)),
    pause,
    overTurnId: overrunMeasured
      ? overrunTurnId(record, intervals, atStreamMs, endsAtStreamMs)
      : null,
    overrunMeasured,
  };
}

/**
 * The room turn Sotto talked over, or `null`.
 *
 * "Overlapping a human line that started after it, with no yield logged" is
 * the PRD's wording and this is it literally: a turn that opened while Sotto
 * was still mid-sentence, on a line nothing cancelled. A line that *did* yield
 * is the rule working, so it is not an overrun however much it overlapped.
 */
function overrunTurnId(
  record: SpokenContributionRecord,
  intervals: readonly TurnInterval[],
  fromMs: number,
  untilMs: number,
): string | null {
  if (record.yielded === true) return null;
  const over = intervals.find(
    (interval) => interval.startMs > fromMs && interval.startMs < untilMs,
  );
  return over?.turnId ?? null;
}

/** Whether this line is Sotto choosing to speak, and the room heard it. */
export function isUnpromptedSpeech(one: SpokenRecord): boolean {
  return one.record.spoken && isUnpromptedKind(one.record.kind);
}
