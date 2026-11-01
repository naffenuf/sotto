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
  /**
   * True when this turn came from a session after the first one, so its
   * `speaker` is a *guess*: the API renumbers diarization labels from scratch
   * in every session (`fixtures/events/NOTES.md`), and the assembler maps the
   * new labels onto the speakers it already knows by order of first
   * appearance. That ordering is usually right and occasionally not, so the
   * UI should show these labels with less confidence rather than silently
   * merging two people.
   */
  speakerMappingUncertain: boolean;
  /**
   * True when this is **Sotto's own speech** rather than something the
   * microphone heard (V2-008a): its text is what Sotto was given to say, and
   * its `startMs` is where playback started on this same stream timeline.
   *
   * Everything that listens to the room has to skip these — the wake and
   * address classifiers, barge-in, the self-echo matcher's human side,
   * speaker introductions and the eval's turn matching — because Sotto
   * answering its own name would be a loop. The board does read them, labeled
   * {@link SOTTO_SPEAKER}, so a fact Sotto established can reach the notes.
   */
  sotto?: true;
  /**
   * True when a {@link sotto} entry was cut off mid-sentence, so its `text` is
   * only what the room actually heard (`spokenSoFar`) and not everything Sotto
   * was writing.
   */
  interrupted?: true;
}

/** The speaker label Sotto's own lines carry, in every view of a transcript. */
export const SOTTO_SPEAKER = "Sotto";

/** Whether this turn is Sotto talking rather than a person. */
export function isSottoTurn(turn: TurnUpdate): boolean {
  return turn.sotto === true;
}

/** The turn id one of Sotto's utterances takes; derived, never counted. */
export function sottoTurnId(utteranceId: string): string {
  return `sotto:${utteranceId}`;
}

/**
 * One line of Sotto's own speech, as a final turn on the conversation's
 * timeline (V2-008a).
 *
 * `startMs` is the stream clock — the one `TurnUpdate.startMs` always means —
 * read at the moment playback started, never the server's uptime; `endMs` is
 * the same instant, because the entry is written when the utterance opened
 * and nothing later moves it.
 */
export function sottoTurn(options: {
  /** The utterance this was, e.g. an answer id. */
  utteranceId: string;
  /** What Sotto said: its own source text, or `spokenSoFar` if cut off. */
  text: string;
  /** Stream time when playback started. */
  startMs: number;
  interrupted: boolean;
}): TurnUpdate {
  return {
    turnId: sottoTurnId(options.utteranceId),
    speaker: SOTTO_SPEAKER,
    text: options.text.replace(/\s+/g, " ").trim(),
    final: true,
    startMs: options.startMs,
    endMs: options.startMs,
    speakerMappingUncertain: false,
    sotto: true,
    ...(options.interrupted ? { interrupted: true as const } : {}),
  };
}

/** Whether anybody is talking, and for how long nobody has been. */
export interface PauseState {
  /** True while some turn has had a `speechStart` and no `speechEnd` yet. */
  speaking: boolean;
  /** Milliseconds since the last `speechEnd`; `0` while `speaking`. */
  silentForMs: number;
}
