/**
 * V2-007's private turn watcher: cancellation runs on partials without waiting
 * for a model, while final commands stay behind the session's echo boundary.
 * ASR exposes audio positions per partial, not per word; latency explicitly
 * uses the first matching partial's position as the wake-word-end estimate.
 */
import type { AsrFrameRecord } from "../../shared/asr.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import type { Clock } from "../clock.js";
import { detectsAddress } from "../wake.js";
import type { AskedQuestion } from "./AnswerAgent.js";

/**
 * The shape of a turn that is steering Sotto rather than asking it something
 * (V3-006).
 *
 * A pre-filter, not the decision: the classifier decides between `stop`,
 * `quieter` and `louder`, and this only decides whether an addressed final
 * turn goes to it at all when nothing is playing. It exists because the
 * fifteen-second window after an unprompted contribution would otherwise send
 * *every* addressed turn through a classifier that has no `mention` kind —
 * somebody saying "that's the thing Sotto picked up" would be read as a
 * request. The words come from the PRD's examples and the obvious neighbours;
 * a bare "stop" is already covered by the control words beside it.
 */
export const STEER_SHAPE =
  /\b(not now|not just now|too much|too chatty|talking too much|enough|be quiet|quiet down|pipe down|butt out|back off|stay out|hold off|let us|leave us|we're fine|we are fine|jump in more|speak up more|chime in|more often|don't be shy|do not be shy|less often|stop jumping)\b/i;

/** Effects stay injectable so partial-to-silence timing can be tested without a microphone. */
export interface BargeInOptions {
  clock: Clock;
  speaking: () => boolean;
  /** V2-008: stop still applies in the silent gap between acknowledgment and answer. */
  answering?: () => boolean;
  interrupt: () => Promise<number | null>;
  command: (asked: AskedQuestion) => void;
  onTiming: (record: Record<string, unknown>) => void;
  onListening: (listening: boolean) => void;
  /**
   * V3-006: whether Sotto has just contributed something nobody asked for.
   *
   * Inside that window an addressed turn that is {@link STEER_SHAPE} belongs
   * to the command classifier even though nothing is playing — "Sotto, not
   * now" arrives seconds *after* the line it is about, which is exactly when
   * no playback is going on.
   */
  unprompted?: () => boolean;
}

/** Owns only turns addressed to Sotto, leaving unrelated side talk to the ordinary pipeline. */
export class BargeIn {
  private readonly interrupted = new Set<string>();
  private readonly commands = new Set<string>();
  private hasInterrupted = false;

  constructor(private readonly options: BargeInOptions) {}

  /** True when the ordinary wake watcher must not issue a duplicate question. */
  owns(turnId: string): boolean {
    return this.interrupted.has(turnId) || this.commands.has(turnId);
  }

  /** Receives non-echo snapshots privately, before any public transcript update. */
  accept(turn: TurnUpdate, record: AsrFrameRecord, duringPlayback: boolean): void {
    // Sotto cannot interrupt itself: its own line (V2-008a) is not a voice in
    // the room, and taking it for one would cancel the answer being spoken.
    if (isSottoTurn(turn) || this.commands.has(turn.turnId)) return;
    const addressed = detectsAddress(turn.text);
    if (addressed && this.options.speaking() && !this.interrupted.has(turn.turnId)) {
      this.interrupted.add(turn.turnId);
      this.hasInterrupted = true;
      this.options.onListening(true);
      const flushed = this.options.interrupt();
      const position = record.frame.audioProcessedMs;
      const audioMs = typeof position === "number" ? position : null;
      void flushed.then((flushMs) => {
        this.options.onTiming({
          stage: "barge_in", atMs: this.options.clock.now(), turnId: turn.turnId,
          wakeEndAudioMs: audioMs, detectedAtStreamMs: record.atMs,
          wakeEndEstimate: "first_matching_partial_audio_position",
          flushMs, flushConfirmed: flushMs !== null,
          wakeToSilenceMs: audioMs === null || flushMs === null
            ? null : Math.max(0, record.atMs - audioMs) + flushMs,
        });
      });
    }
    if (!turn.final) return;
    if (this.interrupted.has(turn.turnId)) this.options.onListening(false);
    if (!addressed) return;
    const control = /\b(stop|thanks|go on|continue|resume|carry on)\b/i.test(turn.text);
    // Outside playback, only an existing answer can receive a control command.
    // Ordinary requests (including "thanks Soto ... can you ...") belong to
    // V2-008's address classifier, even after an earlier interruption.
    const followUpControl = control && (this.hasInterrupted || this.options.answering?.() === true);
    // V3-006: and the same courtesy for a turn steering how much Sotto says,
    // which lands in the quiet *after* the contribution it is about.
    const steer =
      this.options.unprompted?.() === true && (control || STEER_SHAPE.test(turn.text));
    if (!duringPlayback && !this.owns(turn.turnId) && !followUpControl && !steer) return;
    this.commands.add(turn.turnId);
    this.options.command({ question: turn.text, askedBy: turn.speaker, turnId: turn.turnId });
  }
}
