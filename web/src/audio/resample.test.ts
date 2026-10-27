import { describe, expect, it } from "vitest";
import { AUDIO_SAMPLE_RATE } from "../../../shared/audio.js";
import { Resampler, pcm16ToBytes, toPcm16 } from "./resample.js";

/** One second of a sine at `hz`, as the mic would give it: mono Float32. */
function sine(hz: number, rate: number, seconds = 1): Float32Array {
  const samples = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return samples;
}

/**
 * The strongest frequency in `samples`, by a plain DFT of a Hann-windowed
 * 2,048-sample slice: 11.7 Hz per bin at 24 kHz, which is plenty to tell a
 * 1 kHz tone from an aliased one.
 */
function dominantFrequency(samples: Float32Array, rate: number): number {
  const size = 2048;
  const windowed = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    windowed[i] = (samples[i] ?? 0) * hann;
  }

  let best = 0;
  let bestPower = -1;
  for (let bin = 1; bin < size / 2; bin += 1) {
    let real = 0;
    let imaginary = 0;
    for (let i = 0; i < size; i += 1) {
      const angle = (2 * Math.PI * bin * i) / size;
      real += (windowed[i] ?? 0) * Math.cos(angle);
      imaginary -= (windowed[i] ?? 0) * Math.sin(angle);
    }
    const power = real * real + imaginary * imaginary;
    if (power > bestPower) {
      bestPower = power;
      best = bin;
    }
  }
  return (best * rate) / size;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

describe("Resampler", () => {
  it("turns a 48 kHz 1 kHz sine into 24 kHz with the same tone", () => {
    const input = sine(1_000, 48_000);
    const output = new Resampler(48_000).process(input);

    expect(output.length).toBe(24_000);
    expect(Math.abs(dominantFrequency(output, AUDIO_SAMPLE_RATE) - 1_000)).toBeLessThan(15);
    // Averaging pairs of samples barely touches a 1 kHz tone.
    expect(rms(output)).toBeGreaterThan(0.9 * rms(input));
  });

  it("gives the same answer whether the audio arrives in one block or many", () => {
    const input = sine(1_000, 48_000);
    const whole = new Resampler(48_000).process(input);

    // 128 samples is what an AudioWorklet's `process` is handed at a time.
    const streaming = new Resampler(48_000);
    const blocks: Float32Array[] = [];
    for (let at = 0; at < input.length; at += 128) {
      blocks.push(streaming.process(input.subarray(at, at + 128)));
    }
    const joined = new Float32Array(blocks.reduce((total, block) => total + block.length, 0));
    let at = 0;
    for (const block of blocks) {
      joined.set(block, at);
      at += block.length;
    }

    expect(joined.length).toBe(whole.length);
    for (let i = 0; i < joined.length; i += 1) {
      expect(joined[i]).toBeCloseTo(whole[i] ?? 0, 6);
    }
  });

  it("handles a rate that is not a multiple of 24 kHz", () => {
    const resampler = new Resampler(44_100);
    const output = resampler.process(sine(1_000, 44_100));

    // One output sample either way: the last window may not have closed yet.
    expect(output.length).toBeGreaterThanOrEqual(23_999);
    expect(output.length).toBeLessThanOrEqual(24_000);
    expect(Math.abs(dominantFrequency(output, AUDIO_SAMPLE_RATE) - 1_000)).toBeLessThan(15);
  });

  it("damps what would otherwise alias into the speech", () => {
    // 18 kHz has nowhere to go at 24 kHz: decimation alone would fold it down
    // to 6 kHz, right in the middle of the voice.
    const output = new Resampler(48_000).process(sine(18_000, 48_000));
    expect(rms(output)).toBeLessThan(0.5);
  });

  it("rejects a rate it cannot work with", () => {
    expect(() => new Resampler(0)).toThrow(RangeError);
  });
});

describe("toPcm16", () => {
  it("scales to signed 16-bit and clips rather than wrapping", () => {
    const pcm = toPcm16(Float32Array.from([0, 1, -1, 0.5, 2, -2]));
    expect([...pcm]).toEqual([0, 32_767, -32_768, 16_384, 32_767, -32_768]);
  });

  it("writes the bytes little-endian, whatever the platform does", () => {
    const bytes = new Uint8Array(pcm16ToBytes(Int16Array.from([1, -1, 256])));
    expect([...bytes]).toEqual([0x01, 0x00, 0xff, 0xff, 0x00, 0x01]);
  });
});
