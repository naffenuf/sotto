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
 */
import { asAsrEvent, type AsrEvent, type AsrFrameRecord } from "../../shared/asr.js";
import type { PauseState, TurnUpdate } from "../../shared/turns.js";
import { systemClock, type Clock } from "../clock.js";

type Logger = Pick<Console, "warn">;

export interface TurnAssemblerOptions {
  /** Supplies `pauseState()`'s default "now". Arrival times come from the frames. */
  clock?: Clock;
  /** Called with every snapshot, in order, including partials. */
  onUpdate?: (turn: TurnUpdate) => void;
  /** Where the silence before the first turn starts. Defaults to `clock.now()`. */
  startedAtMs?: number;
  logger?: Logger;
}

interface OpenTurn {
  turnId: string;
  speaker: string | null;
  text: string;
  startMs: number;
  endMs: number | null;
}

/** Builds the key that identifies a turn across reconnects. */
export function turnKey(session: number, apiTurnId: number): string {
  return `${session}:${apiTurnId}`;
}

export class TurnAssembler {
  private readonly clock: Clock;
  private readonly onUpdate: ((turn: TurnUpdate) => void) | undefined;
  private readonly logger: Logger;

  /** Turns that have had a `speechStart`, by key, in the order they opened. */
  private readonly live = new Map<string, OpenTurn>();
  /** Keys of turns still waiting for a `speechEnd`, oldest first. */
  private readonly unclosed: string[] = [];
  private readonly finals: TurnUpdate[] = [];

  private silenceSinceMs: number;
  private malformed = 0;

  constructor(options: TurnAssemblerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.onUpdate = options.onUpdate;
    this.logger = options.logger ?? console;
    this.silenceSinceMs = options.startedAtMs ?? this.clock.now();
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
   * Whether anybody is talking, and for how long nobody has been.
   *
   * `speaking` is true while any turn has a `speechStart` and no `speechEnd`.
   * While speaking, `silentForMs` is 0; otherwise it counts from the most
   * recent `speechEnd` (or from the assembler's start, before the first turn).
   */
  pauseState(nowMs: number = this.clock.now()): PauseState {
    if (this.unclosed.length > 0) return { speaking: true, silentForMs: 0 };
    return { speaking: false, silentForMs: Math.max(0, nowMs - this.silenceSinceMs) };
  }

  private apply(event: AsrEvent, session: number, atMs: number): TurnUpdate | null {
    switch (event.type) {
      case "speechStart":
        return this.openTurn(turnKey(session, event.turnId), atMs);
      case "transcript":
        // The only `final: true` transcript is the empty marker the server
        // sends after `endStream`; it belongs to no turn.
        return event.final ? null : this.setText(event.transcript);
      case "speaker":
        return this.setSpeaker(event.label);
      case "speechEnd":
        return this.closeTurn(turnKey(session, event.turnId), atMs);
      case "speechComplete":
        return this.finalise(turnKey(session, event.turnId), event.transcript, atMs);
    }
  }

  private openTurn(turnId: string, atMs: number): TurnUpdate | null {
    if (this.live.has(turnId)) {
      this.logger.warn(`[turns] ignoring repeated speechStart for ${turnId}`);
      return null;
    }
    const turn: OpenTurn = { turnId, speaker: null, text: "", startMs: atMs, endMs: null };
    this.live.set(turnId, turn);
    this.unclosed.push(turnId);
    return this.emit(turn, false);
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

  private setText(text: string): TurnUpdate | null {
    const turn = this.currentTurn("transcript");
    if (turn === null) return null;
    // Partials are cumulative: each one is the whole turn so far.
    turn.text = text;
    return this.emit(turn, false);
  }

  private setSpeaker(label: string): TurnUpdate | null {
    const turn = this.currentTurn("speaker");
    if (turn === null) return null;
    turn.speaker = label;
    return this.emit(turn, false);
  }

  private closeTurn(turnId: string, atMs: number): TurnUpdate | null {
    const turn = this.live.get(turnId);
    if (turn === undefined) {
      this.logger.warn(`[turns] ignoring speechEnd for unknown turn ${turnId}`);
      return null;
    }
    turn.endMs = atMs;
    this.forget(turnId);
    // Silence only starts once nobody is left talking.
    if (this.unclosed.length === 0) this.silenceSinceMs = atMs;
    return this.emit(turn, false);
  }

  private finalise(turnId: string, text: string, atMs: number): TurnUpdate | null {
    const turn = this.live.get(turnId);
    if (turn === undefined) {
      this.logger.warn(`[turns] ignoring speechComplete for unknown turn ${turnId}`);
      return null;
    }
    // `speechComplete` is the only text frame tied to a turnId, so it wins.
    turn.text = text;
    if (turn.endMs === null) {
      turn.endMs = atMs;
      this.forget(turnId);
      if (this.unclosed.length === 0) this.silenceSinceMs = atMs;
    }
    this.live.delete(turnId);
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
  });
}
