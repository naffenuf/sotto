/**
 * Turns the raw transcription stream into speaker-labeled turns.
 *
 * Pure: it consumes {@link AsrFrameRecord}s — whether they came from the live
 * socket or from a `fixtures/events/*.jsonl` capture — and emits
 * {@link TurnUpdate} snapshots. No I/O, no network, no `Date.now()`.
 *
 * The frame order it relies on is the one measured in all 198 captured turns
 * (`fixtures/events/NOTES.md`):
 *
 *     speechStart(turnId) -> transcript × n -> speaker -> speechEnd -> speechComplete
 *
 * `transcript` and `speaker` frames carry no `turnId`, so they are applied to
 * the most recent `speechStart` that has no `speechEnd` yet. That is also why
 * a partial has no speaker label: the `speaker` frame lands just before the
 * turn closes.
 *
 * One assembler spans a whole conversation, including the reconnects the
 * 60-minute session limit forces (US-005). A new session restarts both the
 * turn numbering — hence `turnKey` — and the diarization labels, so labels
 * from a later session are mapped onto the speakers already known, by order
 * of first appearance, and every turn from that session is flagged
 * `speakerMappingUncertain`.
 */
import { asAsrEvent, type AsrEvent, type AsrFrameRecord } from "../../shared/asr.js";
import type { PauseState, TurnUpdate } from "../../shared/turns.js";
import { systemClock, type Clock } from "../clock.js";
import { normalizeWakeSpelling } from "../wake.js";

type Logger = Pick<Console, "warn">;

/**
 * How long an open turn may go without a new word before the room counts as
 * quiet anyway.
 *
 * Silence is counted from the last frame that changed a turn's words, never
 * from the endpointer's `speechEnd`. `speechEnd` is a *decision*, made a
 * median 647 ms after the talking stopped (p90 1,155, over all 198 captured
 * turns), and it can be withheld far longer than that: in
 * `sessions/2026-11-03_2109-mic` one turn stayed open for **55 s** on room
 * noise after "Um, So, go ahead", and for those 55 s nothing Sotto had to say
 * could be said, because "somebody is speaking" was read straight off the
 * open turn. The transcript stopping is the evidence that the talking did;
 * the last partial of a turn lands a median 882 ms before `speechEnd`, so
 * reading silence off it is also the earlier of the two.
 *
 * An open turn still means somebody is mid-sentence for as long as its words
 * keep coming — mid-speech partials arrive a median 310 ms apart, p90 641 —
 * so `speaking` holds while the newest word is younger than this. Past it the
 * turn has stalled: the endpointer closes a turn at every breath, so an open
 * turn two seconds past its last word is one it is holding on something that
 * is not speech. Two seconds is well clear of the partial spacing and well
 * short of anything a room would call a pause being missed.
 */
export const OPEN_TURN_STALL_MS = 2_000;

/**
 * A partial that lands this close ahead of the turn's `speechEnd` is the
 * endpointer flushing what it already had, not somebody still talking.
 *
 * Every one of the 380 captured turns has a `transcript` frame arriving at
 * the same instant as its `speechEnd`; 377 of them only add a trailing
 * space, and the other three add the last word or two of a sentence that
 * had been spoken well before the endpointer made up its mind. Counting that
 * frame as new words would put the room's silence at zero at the very
 * moment the service says the turn is over, which is backwards: on a
 * `speechEnd` the turn's words are taken to have stopped at the last partial
 * that arrived *before* this window.
 */
export const END_FLUSH_WINDOW_MS = 50;

/** Whitespace is not a word: the frame that only adds a trailing space changes nothing. */
function words(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}


export interface TurnAssemblerOptions {
  /**
   * Supplies `pauseState()`'s default "now" and the stall timer. Arrival
   * times come from the frames.
   */
  clock?: Clock;
  /** Called with every snapshot, in order, including partials. */
  onUpdate?: (turn: TurnUpdate) => void;
  /**
   * An open turn has gone {@link OPEN_TURN_STALL_MS} without a new word, so
   * the room has just become quiet with no frame arriving to say so. Called
   * with the turn's unchanged snapshot, once per stall, so whatever re-decides
   * on turn updates (the policy, the speaking queue, the research cards) gets
   * its look.
   */
  onStall?: (turn: TurnUpdate) => void;
  /** Where the silence before the first turn starts. Defaults to `clock.now()`. */
  startedAtMs?: number;
  logger?: Logger;
}

interface OpenTurn {
  turnId: string;
  /** The ASR session the turn's `speechStart` arrived in. */
  session: number;
  speaker: string | null;
  text: string;
  startMs: number;
  endMs: number | null;
  /** Arrival time of the last frame that changed `text` (or opened the turn). */
  lastWordsMs: number;
  /** The one before it, to fall back to when the last was the endpointer's flush. */
  prevWordsMs: number;
  /** Cancels the stall timer armed by that frame. */
  cancelStall: () => void;
  speakerMappingUncertain: boolean;
}

/** Builds the key that identifies a turn across reconnects. */
export function turnKey(session: number, apiTurnId: number): string {
  return `${session}:${apiTurnId}`;
}

export class TurnAssembler {
  private readonly clock: Clock;
  private readonly onUpdate: ((turn: TurnUpdate) => void) | undefined;
  private readonly onStall: ((turn: TurnUpdate) => void) | undefined;
  private readonly logger: Logger;

  /** Turns that have had a `speechStart`, by key, in the order they opened. */
  private readonly live = new Map<string, OpenTurn>();
  /** Keys of turns still waiting for a `speechEnd`, oldest first. */
  private readonly unclosed: string[] = [];
  private readonly finals: TurnUpdate[] = [];

  /** Speakers as first met, in order; a later session's labels map onto these. */
  private readonly speakerOrder: string[] = [];
  /** Per session, that session's labels resolved to a {@link speakerOrder} entry. */
  private readonly labelMaps = new Map<number, Map<string, string>>();
  /** The session whose labels are taken at face value: the first one seen. */
  private firstSession: number | undefined;

  /** Arrival time of the last new word in any turn now closed, or the session's start. */
  private closedWordsMs: number;
  private malformed = 0;
  /** Turns the endpointer opened and closed without a word in them. */
  private empty = 0;

  constructor(options: TurnAssemblerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.onUpdate = options.onUpdate;
    this.onStall = options.onStall;
    this.logger = options.logger ?? console;
    this.closedWordsMs = options.startedAtMs ?? this.clock.now();
  }

  /**
   * Applies one frame and returns the snapshot it produced, or `null` for the
   * frames that say nothing about turns (`audioProgress`, the handshake
   * acknowledgement, the post-`endStream` flush marker).
   */
  accept(record: AsrFrameRecord): TurnUpdate | null {
    const narrowed = asAsrEvent(record.frame);
    if (narrowed === null) return null;
    if ("error" in narrowed) {
      // A known frame type that doesn't match its documented shape means the
      // API moved; drop the frame but make the drift visible.
      this.malformed += 1;
      this.logger.warn(
        `[turns] ignoring malformed ${String(record.frame["type"])} frame: ${narrowed.error}`,
      );
      return null;
    }
    return this.apply(narrowed.event, record.session, record.atMs);
  }

  /** Every turn that has gone final, in the order it finalised. */
  finalTurns(): readonly TurnUpdate[] {
    return this.finals;
  }

  /** Snapshots of the turns that have not gone final yet, oldest first. */
  openTurns(): TurnUpdate[] {
    return [...this.live.values()].map((turn) => snapshot(turn, false));
  }

  /** How many frames were dropped because they didn't match their shape. */
  malformedFrames(): number {
    return this.malformed;
  }

  /**
   * Turns the endpointer opened and closed with no word in them, which are
   * dropped rather than published (see {@link TurnAssembler.finalise}).
   *
   * Not a malformed frame — every frame was the right shape — so it has a
   * counter of its own, for a capture check that wants to know.
   */
  emptyTurns(): number {
    return this.empty;
  }

  /**
   * Whether anybody is talking, and for how long nobody has been.
   *
   * Both are read off the words. `speaking` is true while some turn is open
   * *and* its words grew within {@link OPEN_TURN_STALL_MS}; an open turn
   * older than that has stalled and counts as quiet. `silentForMs` counts
   * from the last frame that changed any turn's words (or from the
   * assembler's start, before the first turn), never from `speechEnd`.
   */
  pauseState(nowMs: number = this.clock.now()): PauseState {
    let lastWordsMs = this.closedWordsMs;
    for (const turnId of this.unclosed) {
      const turn = this.live.get(turnId);
      if (turn === undefined) continue;
      if (nowMs - turn.lastWordsMs < OPEN_TURN_STALL_MS) return { speaking: true, silentForMs: 0 };
      if (turn.lastWordsMs > lastWordsMs) lastWordsMs = turn.lastWordsMs;
    }
    return { speaking: false, silentForMs: Math.max(0, nowMs - lastWordsMs) };
  }

  /** The speakers met so far, in order of first appearance. */
  speakers(): readonly string[] {
    return this.speakerOrder;
  }

  private apply(event: AsrEvent, session: number, atMs: number): TurnUpdate | null {
    // The first session carrying turns is the one whose labels are trusted.
    this.firstSession ??= session;
    switch (event.type) {
      case "speechStart":
        return this.openTurn(turnKey(session, event.turnId), session, atMs);
      case "transcript":
        // The only `final: true` transcript is the empty marker the server
        // sends after `endStream`; it belongs to no turn.
        return event.final ? null : this.setText(event.transcript, atMs);
      case "speaker":
        return this.setSpeaker(event.label);
      case "speechEnd":
        return this.closeTurn(turnKey(session, event.turnId), atMs);
      case "speechComplete":
        return this.finalise(turnKey(session, event.turnId), event.transcript, atMs);
    }
  }

  private openTurn(turnId: string, session: number, atMs: number): TurnUpdate | null {
    if (this.live.has(turnId)) {
      this.logger.warn(`[turns] ignoring repeated speechStart for ${turnId}`);
      return null;
    }
    const turn: OpenTurn = {
      turnId,
      session,
      speaker: null,
      text: "",
      startMs: atMs,
      endMs: null,
      lastWordsMs: atMs,
      prevWordsMs: atMs,
      cancelStall: () => {},
      speakerMappingUncertain: session !== this.firstSession,
    };
    this.live.set(turnId, turn);
    this.unclosed.push(turnId);
    this.heardWords(turn, atMs);
    return this.emit(turn, false);
  }

  /**
   * A frame changed this turn's words (or opened it): silence counts from
   * here, and the stall timer is re-armed so that an open turn going quiet
   * is noticed with nothing arriving to say so.
   */
  private heardWords(turn: OpenTurn, atMs: number): void {
    turn.prevWordsMs = turn.lastWordsMs;
    turn.lastWordsMs = atMs;
    turn.cancelStall();
    turn.cancelStall = this.clock.setTimeout(() => {
      turn.cancelStall = () => {};
      // Closed, or spoken into, since the timer was armed: nothing stalled.
      if (turn.endMs !== null || turn.lastWordsMs !== atMs) return;
      this.onStall?.(snapshot(turn, false));
    }, OPEN_TURN_STALL_MS);
  }

  /** The turn an untagged `transcript` or `speaker` frame belongs to. */
  private currentTurn(what: string): OpenTurn | null {
    const turnId = this.unclosed.at(-1);
    const turn = turnId === undefined ? undefined : this.live.get(turnId);
    if (turn === undefined) {
      this.logger.warn(`[turns] ignoring ${what} frame with no open turn`);
      return null;
    }
    return turn;
  }

  private setText(text: string, atMs: number): TurnUpdate | null {
    const turn = this.currentTurn("transcript");
    if (turn === null) return null;
    // Partials are cumulative: each one is the whole turn so far. One that
    // repeats the last one word for word is not somebody talking.
    const next = normalizeWakeSpelling(text);
    const grew = words(next) !== words(turn.text);
    turn.text = next;
    if (grew) this.heardWords(turn, atMs);
    return this.emit(turn, false);
  }

  private setSpeaker(label: string): TurnUpdate | null {
    const turn = this.currentTurn("speaker");
    if (turn === null) return null;
    turn.speaker = this.resolveSpeaker(label, turn.session);
    return this.emit(turn, false);
  }

  /**
   * Resolves one session's diarization label to a speaker that spans the whole
   * conversation.
   *
   * The first session's labels *are* the speakers. A reconnected session
   * starts labelling over from `"A"`, and the API gives nothing to tie the two
   * numberings together, so the n-th label a later session introduces is taken
   * to be the n-th speaker met so far: order of first appearance. A session
   * that introduces more voices than the conversation has heard gets a new
   * speaker instead of being folded into an existing one.
   */
  private resolveSpeaker(label: string, session: number): string {
    let labels = this.labelMaps.get(session);
    if (labels === undefined) {
      labels = new Map<string, string>();
      this.labelMaps.set(session, labels);
    }
    const mapped = labels.get(label);
    if (mapped !== undefined) return mapped;

    const speaker = this.speakerOrder[labels.size] ?? this.addSpeaker(label);
    labels.set(label, speaker);
    return speaker;
  }

  /** Adds a voice nobody has heard yet, keeping its label when that is free. */
  private addSpeaker(label: string): string {
    const name = this.speakerOrder.includes(label) ? this.unusedLabel() : label;
    this.speakerOrder.push(name);
    return name;
  }

  /** First unused single letter, so an extra voice still reads like a label. */
  private unusedLabel(): string {
    for (let i = 0; i < 26; i += 1) {
      const candidate = String.fromCharCode(65 + i);
      if (!this.speakerOrder.includes(candidate)) return candidate;
    }
    return `S${this.speakerOrder.length + 1}`;
  }

  private closeTurn(turnId: string, atMs: number): TurnUpdate | null {
    const turn = this.live.get(turnId);
    if (turn === undefined) {
      this.logger.warn(`[turns] ignoring speechEnd for unknown turn ${turnId}`);
      return null;
    }
    // Silence was already counting from the turn's last word: the endpointer
    // closing it adds nothing (see OPEN_TURN_STALL_MS), and a partial that
    // arrived with it was its flush, not speech (END_FLUSH_WINDOW_MS).
    this.close(turn, atMs);
    return this.emit(turn, false);
  }

  /** The turn's words have stopped, wherever the endpointer put its marker. */
  private close(turn: OpenTurn, atMs: number): void {
    turn.endMs = atMs;
    turn.cancelStall();
    if (atMs - turn.lastWordsMs < END_FLUSH_WINDOW_MS) turn.lastWordsMs = turn.prevWordsMs;
    if (turn.lastWordsMs > this.closedWordsMs) this.closedWordsMs = turn.lastWordsMs;
    this.forget(turn.turnId);
  }

  private finalise(turnId: string, text: string, atMs: number): TurnUpdate | null {
    const turn = this.live.get(turnId);
    if (turn === undefined) {
      this.logger.warn(`[turns] ignoring speechComplete for unknown turn ${turnId}`);
      return null;
    }
    // `speechComplete` is the only text frame tied to a turnId, so it wins —
    // but it is a revision of words already heard, not new ones, so it does
    // not move `lastWordsMs`.
    const hadWords = turn.text.trim() !== "";
    turn.text = normalizeWakeSpelling(text);
    if (turn.endMs === null) this.close(turn, atMs);
    this.live.delete(turnId);
    // A turn with no words in it is not a turn. The endpointer occasionally
    // opens and closes a segment of 80 ms with no `transcript` and no
    // `speaker` frame between them (measured once in the `stalled-naming`
    // capture, at 28.1 s), and publishing that as a final turn would put an
    // empty row in the transcript, count towards the board's four-turn
    // cadence and reach every classifier. Only a turn that never carried a
    // word is dropped: a `speechComplete` that arrives empty *after* real
    // partials keeps the empty text, which is the behaviour every other
    // capture has been read with.
    if (!hadWords && turn.text.trim() === "") {
      this.empty += 1;
      this.logger.warn(`[turns] dropping ${turnId}: it never carried a word`);
      return null;
    }
    const final = snapshot(turn, true);
    this.finals.push(final);
    this.onUpdate?.(final);
    return final;
  }

  private forget(turnId: string): void {
    const index = this.unclosed.indexOf(turnId);
    if (index >= 0) this.unclosed.splice(index, 1);
  }

  private emit(turn: OpenTurn, final: boolean): TurnUpdate {
    const update = snapshot(turn, final);
    this.onUpdate?.(update);
    return update;
  }
}

function snapshot(turn: OpenTurn, final: boolean): TurnUpdate {
  return Object.freeze({
    turnId: turn.turnId,
    speaker: turn.speaker,
    text: turn.text,
    final,
    startMs: turn.startMs,
    endMs: turn.endMs,
    lastWordsMs: turn.lastWordsMs,
    speakerMappingUncertain: turn.speakerMappingUncertain,
  });
}
