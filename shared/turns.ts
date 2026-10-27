/**
 * Speaker-labeled turns, as the turn assembler (`server/asr/turns.ts`) builds
 * them out of the raw transcription stream. The UI renders these; the board,
 * observer and eval harness all read conversations as a list of them.
 */

/**
 * One snapshot of a turn. The assembler emits a new one every time the turn
 * changes, so a turn shows up several times: once per partial, then once more
 * as `final`. Snapshots are frozen — hold on to them freely.
 */
export interface TurnUpdate {
  /**
   * Stable key for the turn, `"<session>:<apiTurnId>"`. The API numbers turns
   * from 0 *within a session*, so the session is part of the key: after a
   * reconnect the numbering starts over (see `fixtures/events/NOTES.md`).
   */
  turnId: string;
  /**
   * Diarization label (`"A"`, `"B"`, …), or `null` while the turn is still a
   * partial. The API sends a turn's `speaker` frame just before it closes the
   * turn, so a label is always present by the time `final` is true.
   */
  speaker: string | null;
  /** Everything said in this turn so far. Partials replace it, never append. */
  text: string;
  /** True once `speechComplete` has given the turn its final text. */
  final: boolean;
  /** Arrival time of the turn's `speechStart`, on the assembler's timeline. */
  startMs: number;
  /** Arrival time of its `speechEnd`, or `null` while the speaker is talking. */
  endMs: number | null;
}

/** Whether anybody is talking, and for how long nobody has been. */
export interface PauseState {
  /** True while some turn has had a `speechStart` and no `speechEnd` yet. */
  speaking: boolean;
  /** Milliseconds since the last `speechEnd`; `0` while `speaking`. */
  silentForMs: number;
}
