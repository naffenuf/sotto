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
 * turns rather than over frames — somebody is talking while a turn has
 * started and not ended, and silence is counted from the last turn to end,
 * less the endpointer's hangover ({@link ENDPOINTER_HANGOVER_MS}).
 */
import type { PauseState, TurnUpdate } from "../../shared/turns.js";
import { ENDPOINTER_HANGOVER_MS } from "../asr/turns.js";

/** One turn as an interval. `endMs` is `null` for a turn that never closed. */
export interface TurnInterval {
  turnId: string;
  startMs: number;
  endMs: number | null;
}

/**
 * The intervals a replay's turn snapshots describe, one per `turnId`.
 *
 * A turn arrives many times — once per partial, then final — so the last
 * snapshot of each is the one that knows where it ended. Order is the order
 * turns opened in.
 */
export function turnIntervals(turns: readonly TurnUpdate[]): TurnInterval[] {
  const byId = new Map<string, TurnInterval>();
  for (const turn of turns) {
    const existing = byId.get(turn.turnId);
    if (existing === undefined) {
      byId.set(turn.turnId, { turnId: turn.turnId, startMs: turn.startMs, endMs: turn.endMs });
      continue;
    }
    existing.startMs = turn.startMs;
    // A later snapshot can give a turn its end; nothing ever takes it away.
    if (turn.endMs !== null) existing.endMs = turn.endMs;
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
    // Open at `atMs`: either still unclosed, or closing after it.
    if (interval.endMs === null || interval.endMs > atMs) return { speaking: true, silentForMs: 0 };
    // A turn's end is where the endpointer decided, not where the talking
    // stopped; the assembler undoes the same hangover.
    const quietFrom = interval.endMs - ENDPOINTER_HANGOVER_MS;
    if (quietFrom > quietSinceMs) quietSinceMs = quietFrom;
  }
  return { speaking: false, silentForMs: Math.max(0, atMs - quietSinceMs) };
}
