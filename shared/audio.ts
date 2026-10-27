/**
 * The one shape audio takes between the browser and the server: PCM16 mono
 * 24 kHz in 80 ms chunks.
 *
 * Both ends need these numbers — the mic capture in `web/src/audio/` resamples
 * to them and frames `/ws/audio` messages by them, and every server
 * `AudioSource` promises them — so they live here rather than in either one.
 */

/** Meta's realtime transcription takes `PCM_24KHZ`; every source resamples to this. */
export const AUDIO_SAMPLE_RATE = 24_000;
/** Chunk length. Short enough to keep latency low, long enough to be cheap. */
export const AUDIO_CHUNK_MS = 80;
/** 80 ms at 24 kHz. */
export const AUDIO_CHUNK_SAMPLES = (AUDIO_SAMPLE_RATE * AUDIO_CHUNK_MS) / 1000;
/** 1,920 little-endian 16-bit samples. */
export const AUDIO_CHUNK_BYTES = AUDIO_CHUNK_SAMPLES * 2;
