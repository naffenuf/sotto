/**
 * The microphone end of US-012, running on the audio thread.
 *
 * It does as little as possible: the browser hands it 128 mono samples at a
 * time at the AudioContext's own rate, and it batches them into ~80 ms frames
 * and transfers them to the page, which resamples to 24 kHz PCM16 and sends
 * them over `/ws/audio` (`web/src/audio/micCapture.ts`). Keeping the
 * conversion off this thread means a slow resample can glitch the socket but
 * never the capture.
 *
 * This file is served verbatim from `web/public/`, because `addModule` takes
 * a URL rather than a bundled import — so it is plain JavaScript with no
 * imports of its own.
 */

/** Batch length, matching the 80 ms chunks the server's AudioSource takes. */
const BATCH_MS = 80;

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in the worklet scope: the context's rate.
    this.batchSize = Math.round((sampleRate * BATCH_MS) / 1000);
    this.batch = new Float32Array(this.batchSize);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input yet (or the track ended): stay alive and wait for one.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      this.batch[this.filled] = channel[i];
      this.filled += 1;
      if (this.filled === this.batchSize) {
        // Transferred, not copied; a fresh buffer takes its place.
        this.port.postMessage(this.batch, [this.batch.buffer]);
        this.batch = new Float32Array(this.batchSize);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCaptureProcessor);
