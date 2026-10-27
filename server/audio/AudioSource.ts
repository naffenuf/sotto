/**
 * The one shape of audio that reaches the transcription client: PCM16 mono
 * 24 kHz, in 80 ms chunks. The mic and WAV replay both produce it, so
 * everything downstream is written once. The numbers themselves are in
 * `shared/audio.ts`, because the browser's mic capture frames its messages by
 * them too.
 */
import type { AUDIO_SAMPLE_RATE } from "../../shared/audio.js";

export {
  AUDIO_CHUNK_BYTES,
  AUDIO_CHUNK_MS,
  AUDIO_CHUNK_SAMPLES,
  AUDIO_SAMPLE_RATE,
} from "../../shared/audio.js";

/** Why a source stopped producing chunks. */
export type AudioEndReason = "complete" | "stopped";

/** Receives audio from an {@link AudioSource}. */
export interface AudioSink {
  /**
   * One chunk of exactly {@link AUDIO_CHUNK_BYTES} bytes. A source that runs
   * out of audio mid-chunk pads the last one with silence, so this never
   * receives a short chunk.
   */
  onChunk(chunk: Buffer): void;
  /** Called exactly once, after the last chunk. No chunks arrive afterwards. */
  onEnd(reason: AudioEndReason): void;
}

/** A stream of PCM16 mono 24 kHz audio, in 80 ms chunks. */
export interface AudioSource {
  readonly sampleRate: typeof AUDIO_SAMPLE_RATE;
  /** Begins delivering chunks to `sink`. Throws if the source is already running. */
  start(sink: AudioSink): void;
  /** Stops early. Idempotent; ends the sink with `"stopped"` if it was running. */
  stop(): void;
}
