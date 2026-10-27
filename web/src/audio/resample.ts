/**
 * Turning what the browser hands us into what the pipeline takes.
 *
 * `getUserMedia` gives mono Float32 samples at whatever rate the AudioContext
 * runs at — 48 kHz on most Macs, 44.1 kHz on some — and the transcription API
 * takes PCM16 at {@link AUDIO_SAMPLE_RATE}. These two functions are the whole
 * conversion, and they are pure so `npm test` can check them without a browser.
 */
import { AUDIO_SAMPLE_RATE } from "../../../shared/audio.js";

/**
 * Resamples mono audio down to 24 kHz by averaging each output sample's slice
 * of the input: a box filter that is both the anti-alias filter and the
 * interpolation. Plain decimation would fold everything above 12 kHz back
 * into the speech; averaging the samples that an output sample spans costs
 * one multiply each and takes most of it out.
 *
 * It is a class rather than a function because the mic arrives in small
 * blocks: the fraction of an input sample left over at the end of one block
 * is carried into the next, so block boundaries add neither a click nor a
 * drifting sample count.
 */
export class Resampler {
  /** Input samples per output sample. 2 for the usual 48 kHz microphone. */
  readonly ratio: number;

  /** Input samples the last call did not finish with. */
  private leftover = new Float32Array(0);
  /** Where in {@link leftover} the next output sample's window starts. */
  private offset = 0;

  constructor(inputRate: number, outputRate: number = AUDIO_SAMPLE_RATE) {
    if (!(inputRate > 0) || !(outputRate > 0)) {
      throw new RangeError(`cannot resample ${inputRate} Hz to ${outputRate} Hz`);
    }
    this.ratio = inputRate / outputRate;
  }

  /** Resamples one block. Only whole output samples come back. */
  process(input: Float32Array): Float32Array {
    const buffer = this.leftover.length === 0 ? input : concat(this.leftover, input);
    const count = Math.max(0, Math.floor((buffer.length - this.offset) / this.ratio));
    const output = new Float32Array(count);

    let start = this.offset;
    for (let i = 0; i < count; i += 1) {
      const end = start + this.ratio;
      output[i] = mean(buffer, start, end);
      start = end;
    }

    // Keep the tail the next block's first window starts inside, and rebase
    // the offset onto it so neither number grows with the session.
    const consumed = Math.floor(start);
    this.leftover = buffer.slice(consumed);
    this.offset = start - consumed;
    return output;
  }
}

/** The mean of `buffer` over `[start, end)`, counting partial samples by area. */
function mean(buffer: Float32Array, start: number, end: number): number {
  let sum = 0;
  let index = Math.floor(start);
  let at = start;
  while (at < end) {
    const next = Math.min(index + 1, end);
    sum += (buffer[index] ?? 0) * (next - at);
    at = next;
    index += 1;
  }
  return sum / (end - start);
}

function concat(first: Float32Array, second: Float32Array): Float32Array {
  const joined = new Float32Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  return joined;
}

/**
 * Signed 16-bit samples as the bytes the wire takes: little-endian, which is
 * what `PCM_24KHZ` means and what the server reads back, written out
 * explicitly rather than trusting the platform's own byte order.
 */
export function pcm16ToBytes(samples: Int16Array): ArrayBuffer {
  const bytes = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i += 1) bytes.setInt16(i * 2, samples[i] ?? 0, true);
  return bytes.buffer;
}

/** Float samples in [-1, 1] as signed 16-bit, clipped rather than wrapped. */
export function toPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
  }
  return pcm;
}
