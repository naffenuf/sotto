/**
 * The session's transcription boundary (V2-006). The raw assembler still
 * owns ASR ordering and pause detection, but only human turns leave here.
 * During the echo window partials wait for the final text: a one-word echo
 * can grow into unrelated side talk, and publishing it first would leak it
 * into the UI. Raw frames wait too, in original order, so events.jsonl cannot
 * preserve speech that transcript.md correctly excluded.
 */
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { PauseState, TurnUpdate } from "../../shared/turns.js";
import { TurnAssembler } from "../asr/turns.js";
import type { Clock } from "../clock.js";
import { isSelfEcho, type SpeechPlayback } from "../voice/selfEcho.js";

interface PendingTurn {
  turn: TurnUpdate;
  /** Once held, wait for final even if playback ends in the meantime. */
  held: boolean;
  /** Side talk cannot become a delayed wake question when playback ends. */
  duringPlayback: boolean;
  /** Latest heard prefix per utterance, retained if ASR finalizes after the tail. */
  speech: Map<string, string>;
  /** Null holds the corresponding raw frames until final text decides. */
  selfEcho: boolean | null;
}

/** The effects are injected so the boundary can be checked without APIs or disk. */
export interface SessionTranscriptionOptions {
  clock: Clock;
  playback: () => SpeechPlayback;
  logger: Pick<Console, "warn">;
  onUpdate: (turn: TurnUpdate, suppressTriggers: boolean) => void;
  onEvent: (record: AsrFrameRecord) => void;
  /** Echo text has exactly one destination: timing.jsonl. */
  onEcho: (turn: TurnUpdate & { selfEcho: true }) => void;
  /** Private V2-007 hook; never releases tentative echo text to public consumers. */
  onHuman?: (turn: TurnUpdate, record: AsrFrameRecord, duringPlayback: boolean) => void;
}

/** Keeps echo out of every consumer, including answer context and raw captures. */
export class SessionTranscription {
  private readonly assembler: TurnAssembler;
  private readonly finals: TurnUpdate[] = [];
  private readonly pending = new Map<string, PendingTurn>();
  /** Shared pending objects allow overlapping turns to resolve independently. */
  private frames: { record: AsrFrameRecord; pending: PendingTurn | null }[] = [];

  constructor(private readonly options: SessionTranscriptionOptions) {
    this.assembler = new TurnAssembler({
      clock: options.clock,
      startedAtMs: 0,
      logger: options.logger,
    });
  }

  /** Applies the same boundary to live transcription and event replay. */
  accept(record: AsrFrameRecord): void {
    const turn = this.assembler.accept(record);
    if (turn === null) {
      this.frames.push({ record, pending: null });
      this.flushFrames();
      return;
    }
    const playback = this.options.playback();
    let pending = this.pending.get(turn.turnId);
    if (pending === undefined) {
      pending = {
        turn,
        held: false,
        duringPlayback: false,
        speech: new Map(),
        selfEcho: null,
      };
      this.pending.set(turn.turnId, pending);
    }
    pending.turn = turn;
    pending.held ||= playback.recent.length > 0;
    pending.duringPlayback ||= playback.playing;
    for (const speech of playback.recent) pending.speech.set(speech.id, speech.text);
    this.frames.push({ record, pending });

    if (!isSelfEcho(turn.text, [...pending.speech.values()])) {
      this.options.onHuman?.(turn, record, pending.duringPlayback);
    }

    if (turn.final) {
      this.resolve(pending);
      this.pending.delete(turn.turnId);
      if (!pending.selfEcho) {
        this.finals.push(turn);
        this.options.onUpdate(turn, pending.duringPlayback);
      }
    } else if (!pending.held) {
      this.options.onUpdate(turn, pending.duringPlayback);
    }
    this.flushFrames();
  }

  /** Answer context must read the filtered transcript, not the raw assembler. */
  finalTurns(): readonly TurnUpdate[] {
    return this.finals;
  }

  /** Playback holds deliveries even when the model has finished generating. */
  pauseState(): PauseState {
    if (this.options.playback().playing) return { speaking: true, silentForMs: 0 };
    return this.assembler.pauseState();
  }

  /** A truncated stream must not strand raw human frames behind an open turn. */
  finish(): void {
    for (const pending of this.pending.values()) this.resolve(pending);
    this.pending.clear();
    this.flushFrames();
  }

  private resolve(pending: PendingTurn): void {
    pending.selfEcho = isSelfEcho(pending.turn.text, [...pending.speech.values()]);
    if (pending.selfEcho) this.options.onEcho({ ...pending.turn, selfEcho: true });
  }

  private flushFrames(): void {
    let count = 0;
    for (const frame of this.frames) {
      if (frame.pending?.selfEcho === null) break;
      if (!frame.pending?.selfEcho) this.options.onEvent(frame.record);
      count += 1;
    }
    if (count > 0) this.frames = this.frames.slice(count);
  }
}
