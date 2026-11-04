/**
 * Was anybody talking when Sotto spoke? (PRD US-016)
 *
 * The policy only ever delivers in a pause, so asking the policy whether it
 * did would be asking it to mark its own homework. This reconstructs the
 * answer from the conversation instead: the turns a replay produced are
 * intervals on the session clock, and a delivery time either falls inside one
 * or does not.
 *
 * It is the same rule {@link TurnAssembler.pauseState} applies, stated over
 * turns rather than over frames — somebody is talking while a turn is open
 * and its words are younger than {@link OPEN_TURN_STALL_MS}, and silence is
 * counted from the last word to arrive in any turn (`TurnUpdate.lastWordsMs`),
 * never from a `speechEnd`.
 */
import type { PauseState, TurnUpdate } from "../../shared/turns.js";
import { OPEN_TURN_STALL_MS } from "../asr/turns.js";

/** One turn as an interval. `endMs` is `null` for a turn that never closed. */
export interface TurnInterval {
  turnId: string;
  startMs: number;
  endMs: number | null;
  /**
   * When its words last changed. A record from before the field existed
   * falls back to the turn's end (or its start, while open), which is what
   * silence used to be counted from.
   */
  lastWordsMs: number;
}

/** Where a snapshot says this turn's words last changed. */
function wordsOf(turn: TurnUpdate): number {
  return turn.lastWordsMs ?? turn.endMs ?? turn.startMs;
}

/**
 * The intervals a replay's turn snapshots describe, one per `turnId`.
 *
 * A turn arrives many times — once per partial, then final — so the last
 * snapshot of each is the one that knows where it ended and where its words
 * stopped. Order is the order turns opened in.
 */
export function turnIntervals(turns: readonly TurnUpdate[]): TurnInterval[] {
  const byId = new Map<string, TurnInterval>();
  for (const turn of turns) {
    const existing = byId.get(turn.turnId);
    if (existing === undefined) {
      byId.set(turn.turnId, {
        turnId: turn.turnId,
        startMs: turn.startMs,
        endMs: turn.endMs,
        lastWordsMs: wordsOf(turn),
      });
      continue;
    }
    existing.startMs = turn.startMs;
    // A later snapshot can give a turn its end; nothing ever takes it away.
    if (turn.endMs !== null) existing.endMs = turn.endMs;
    // The latest snapshot knows best: a turn's words move forward with each
    // partial and, once, back — when the frame that arrived with the
    // `speechEnd` turns out to have been the endpointer's flush.
    existing.lastWordsMs = wordsOf(turn);
  }
  return [...byId.values()];
}

/**
 * Whether anybody was talking at `atMs`, and for how long nobody had been.
 *
 * `startedAtMs` is where the session's silence starts — 0 for a replay, whose
 * timeline begins with the stream.
 */
export function pauseAt(
  intervals: readonly TurnInterval[],
  atMs: number,
  startedAtMs = 0,
): PauseState {
  let quietSinceMs = startedAtMs;
  for (const interval of intervals) {
    if (interval.startMs > atMs) continue;
    // Words that had arrived by `atMs` are where silence counts from; a
    // turn's end is the endpointer's decision and moves nothing.
    const heardBy = Math.min(interval.lastWordsMs, atMs);
    if (heardBy > quietSinceMs) quietSinceMs = heardBy;
    // Open at `atMs` — still unclosed, or closing after it — and still being
    // spoken into: that is somebody talking. Open but stalled is quiet.
    const open = interval.endMs === null || interval.endMs > atMs;
    if (open && atMs - heardBy < OPEN_TURN_STALL_MS) return { speaking: true, silentForMs: 0 };
  }
  return { speaking: false, silentForMs: Math.max(0, atMs - quietSinceMs) };
}
