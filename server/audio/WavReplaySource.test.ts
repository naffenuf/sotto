import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SimulatedClock } from "../clock.js";
import {
  AUDIO_CHUNK_BYTES,
  AUDIO_CHUNK_MS,
  AUDIO_CHUNK_SAMPLES,
  AUDIO_SAMPLE_RATE,
  type AudioEndReason,
} from "./AudioSource.js";
import { UnsupportedWavFormatError, WavReplaySource } from "./WavReplaySource.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sotto-wav-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface WavOptions {
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
}

/**
 * Writes a WAV whose samples are a ramp, so a chunk's contents identify which
 * part of the file it came from.
 */
function writeWav(name: string, sampleCount: number, options: WavOptions = {}): string {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? AUDIO_SAMPLE_RATE;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const bytesPerFrame = (bitsPerSample / 8) * channels;
  const data = Buffer.alloc(sampleCount * bytesPerFrame);
  if (bitsPerSample === 16) {
    for (let i = 0; i < data.length / 2; i += 1) data.writeInt16LE(((i * 7) % 30_000) - 15_000, i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  header.writeUInt16LE(bytesPerFrame, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);

  const path = join(dir, `${name}.wav`);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

interface Recording {
  chunks: Buffer[];
  /** Real time of each chunk, in ms since `start()`. */
  at: number[];
  end: AudioEndReason | undefined;
}

/** Replays a source to completion on the real clock. */
function replay(source: WavReplaySource): Promise<Recording & { elapsedMs: number }> {
  return new Promise((resolve) => {
    const recording: Recording = { chunks: [], at: [], end: undefined };
    const startedAt = performance.now();
    source.start({
      onChunk(chunk) {
        recording.chunks.push(chunk);
        recording.at.push(performance.now() - startedAt);
      },
      onEnd(reason) {
        recording.end = reason;
        resolve({ ...recording, elapsedMs: performance.now() - startedAt });
      },
    });
  });
}

describe("WavReplaySource format validation", () => {
  it("rejects stereo files", () => {
    const path = writeWav("stereo", 2_400, { channels: 2 });
    expect(() => new WavReplaySource(path)).toThrow(UnsupportedWavFormatError);
    expect(() => new WavReplaySource(path)).toThrow(/2-channel.*mono 16-bit PCM at 24000 Hz/s);
  });

  it("rejects 8-bit files", () => {
    const path = writeWav("eight-bit", 2_400, { bitsPerSample: 8 });
    expect(() => new WavReplaySource(path)).toThrow(/8-bit/);
  });

  it("rejects other sample rates", () => {
    const path = writeWav("forty-four-one", 2_400, { sampleRate: 44_100 });
    expect(() => new WavReplaySource(path)).toThrow(/44100 Hz/);
  });

  it("rejects files that are not WAVs at all", () => {
    const path = join(dir, "not-audio.wav");
    writeFileSync(path, "this is not a RIFF file, not even close");
    expect(() => new WavReplaySource(path)).toThrow(/not a RIFF\/WAVE file/);
  });
});

describe("WavReplaySource pacing", () => {
  it("emits 25 chunks from a 2.0 s WAV over 1.9-2.2 s", async () => {
    const path = writeWav("two-seconds", AUDIO_SAMPLE_RATE * 2);
    const { chunks, end, elapsedMs } = await replay(new WavReplaySource(path));

    expect(chunks).toHaveLength(25);
    expect(end).toBe("complete");
    expect(elapsedMs).toBeGreaterThanOrEqual(1_900);
    expect(elapsedMs).toBeLessThanOrEqual(2_200);
  });

  it("averages an 80 ms chunk interval over a 10 s WAV", async () => {
    const path = writeWav("ten-seconds", AUDIO_SAMPLE_RATE * 10);
    const { chunks, at } = await replay(new WavReplaySource(path));

    expect(chunks).toHaveLength(125);
    const averageInterval = (at[at.length - 1]! - at[0]!) / (at.length - 1);
    expect(averageInterval).toBeGreaterThanOrEqual(AUDIO_CHUNK_MS - 10);
    expect(averageInterval).toBeLessThanOrEqual(AUDIO_CHUNK_MS + 10);
  }, 30_000);

  it("corrects drift rather than accumulating it", async () => {
    const path = writeWav("blocking", AUDIO_SAMPLE_RATE * 2);
    const source = new WavReplaySource(path);
    const recording = await new Promise<{ count: number; elapsedMs: number }>((resolve) => {
      let count = 0;
      const startedAt = performance.now();
      source.start({
        onChunk() {
          count += 1;
          // A sink that blocks for longer than a chunk: the next tick has to
          // catch up instead of letting the stream fall a chunk behind.
          if (count === 1) {
            const until = performance.now() + 250;
            while (performance.now() < until) {
              /* busy-wait */
            }
          }
        },
        onEnd() {
          resolve({ count, elapsedMs: performance.now() - startedAt });
        },
      });
    });

    expect(recording.count).toBe(25);
    expect(recording.elapsedMs).toBeLessThanOrEqual(2_200);
  });
});

describe("WavReplaySource chunks", () => {
  it("emits the file in order, in 3,840-byte chunks", () => {
    const path = writeWav("in-order", AUDIO_SAMPLE_RATE * 2);
    const clock = new SimulatedClock();
    const source = new WavReplaySource(path, clock);
    const chunks: Buffer[] = [];
    source.start({ onChunk: (chunk) => chunks.push(chunk), onEnd: () => {} });
    clock.runAll();

    expect(AUDIO_CHUNK_BYTES).toBe(3_840);
    expect(chunks).toHaveLength(25);
    expect(chunks.every((chunk) => chunk.length === AUDIO_CHUNK_BYTES)).toBe(true);
    expect(Buffer.concat(chunks).subarray(0, 6)).toEqual(
      Buffer.from(Int16Array.of(-15_000, -14_993, -14_986).buffer),
    );
  });

  it("pads a file that does not end on a chunk boundary with silence", () => {
    const path = writeWav("ragged", AUDIO_CHUNK_SAMPLES + 1);
    const clock = new SimulatedClock();
    const source = new WavReplaySource(path, clock);
    const chunks: Buffer[] = [];
    let end: AudioEndReason | undefined;
    source.start({ onChunk: (chunk) => chunks.push(chunk), onEnd: (reason) => (end = reason) });
    clock.runAll();

    expect(source.chunkCount).toBe(2);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.length).toBe(AUDIO_CHUNK_BYTES);
    expect(chunks[1]!.subarray(2)).toEqual(Buffer.alloc(AUDIO_CHUNK_BYTES - 2));
    expect(end).toBe("complete");
  });
});

describe("WavReplaySource lifecycle", () => {
  it("ends with 'stopped' when stopped early", () => {
    const path = writeWav("stop-early", AUDIO_SAMPLE_RATE * 2);
    const clock = new SimulatedClock();
    const source = new WavReplaySource(path, clock);
    const chunks: Buffer[] = [];
    const ends: AudioEndReason[] = [];
    source.start({
      onChunk(chunk) {
        chunks.push(chunk);
        if (chunks.length === 3) source.stop();
      },
      onEnd: (reason) => ends.push(reason),
    });
    clock.runAll();

    expect(chunks).toHaveLength(3);
    expect(ends).toEqual(["stopped"]);
  });

  it("ignores stop() after the stream has finished", () => {
    const path = writeWav("stop-late", AUDIO_SAMPLE_RATE);
    const clock = new SimulatedClock();
    const source = new WavReplaySource(path, clock);
    const ends: AudioEndReason[] = [];
    source.start({ onChunk: () => {}, onEnd: (reason) => ends.push(reason) });
    clock.runAll();
    source.stop();

    expect(ends).toEqual(["complete"]);
  });

  it("refuses to start twice", () => {
    const path = writeWav("twice", AUDIO_SAMPLE_RATE);
    const source = new WavReplaySource(path, new SimulatedClock());
    const sink = { onChunk: () => {}, onEnd: () => {} };
    source.start(sink);
    expect(() => source.start(sink)).toThrow(/already running/);
  });
});

describe("WavReplaySource.forFixture", () => {
  it("replays a rendered fixture from fixtures/audio/", () => {
    const clock = new SimulatedClock();
    const source = WavReplaySource.forFixture("brainstorm", clock);
    let chunks = 0;
    let end: AudioEndReason | undefined;
    source.start({ onChunk: () => (chunks += 1), onEnd: (reason) => (end = reason) });
    clock.runAll();

    expect(chunks).toBe(source.chunkCount);
    expect(end).toBe("complete");
    // brainstorm is roughly two minutes of speech.
    expect((chunks * AUDIO_CHUNK_MS) / 1000).toBeGreaterThan(60);
  });
});
