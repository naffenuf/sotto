/**
 * V2-007's private turn watcher: cancellation runs on partials without waiting
 * for a model, while final commands stay behind the session's echo boundary.
 * ASR exposes audio positions per partial, not per word; latency explicitly
 * uses the first matching partial's position as the wake-word-end estimate.
 */
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { TurnUpdate } from "../../shared/turns.js";
import type { Clock } from "../clock.js";
import { detect, detectsAddress } from "../wake.js";
import type { AskedQuestion } from "./AnswerAgent.js";

/** Effects stay injectable so partial-to-silence timing can be tested without a microphone. */
export interface BargeInOptions {
  clock: Clock;
  speaking: () => boolean;
  interrupt: () => Promise<number | null>;
  command: (asked: AskedQuestion) => void;
  onTiming: (record: Record<string, unknown>) => void;
  onListening: (listening: boolean) => void;
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
    if (this.commands.has(turn.turnId)) return;
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
    if (!duringPlayback && !this.hasInterrupted && !control) return;
    if (!duringPlayback && !this.owns(turn.turnId) && !control && !detect(turn.text).triggered) return;
    this.commands.add(turn.turnId);
    this.options.command({ question: turn.text, askedBy: turn.speaker, turnId: turn.turnId });
  }
}
