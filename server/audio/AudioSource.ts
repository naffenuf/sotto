/**
 * The one shape of audio that reaches the transcription client: PCM16 mono
 * 24 kHz, in 80 ms chunks. The mic (US-012) and WAV replay both produce it,
 * so everything downstream is written once.
 */

/** Meta's realtime transcription takes `PCM_24KHZ`; every source resamples to this. */
export const AUDIO_SAMPLE_RATE = 24_000;
/** Chunk length. Short enough to keep latency low, long enough to be cheap. */
export const AUDIO_CHUNK_MS = 80;
/** 80 ms at 24 kHz. */
export const AUDIO_CHUNK_SAMPLES = (AUDIO_SAMPLE_RATE * AUDIO_CHUNK_MS) / 1000;
/** 1,920 little-endian 16-bit samples. */
export const AUDIO_CHUNK_BYTES = AUDIO_CHUNK_SAMPLES * 2;

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
