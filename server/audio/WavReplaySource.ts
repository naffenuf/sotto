/**
 * Replays a fixture WAV as if it were a live microphone, so the whole pipeline
 * can be exercised without speaking into one.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock, type Clock } from "../clock.js";
import { readWavFile } from "./wav.js";
import {
  AUDIO_CHUNK_BYTES,
  AUDIO_CHUNK_MS,
  AUDIO_SAMPLE_RATE,
  type AudioSink,
  type AudioSource,
} from "./AudioSource.js";

/** Where `npm run fixture:render` writes its rendered conversations. */
export const FIXTURE_AUDIO_DIR = fileURLToPath(new URL("../../fixtures/audio/", import.meta.url));

/** Path to a fixture's WAV, by fixture name (e.g. `"brainstorm"`). */
export function fixtureAudioPath(name: string): string {
  return join(FIXTURE_AUDIO_DIR, `${name}.wav`);
}

export class UnsupportedWavFormatError extends Error {
  constructor(path: string, problem: string) {
    super(
      `${path} is ${problem}. WAV replay needs mono 16-bit PCM at ${AUDIO_SAMPLE_RATE} Hz — regenerate it with \`npm run fixture:render\`.`,
    );
    this.name = "UnsupportedWavFormatError";
  }
}

export class WavReplaySource implements AudioSource {
  readonly sampleRate = AUDIO_SAMPLE_RATE;
  /** Number of chunks this file will produce, including a zero-padded last one. */
  readonly chunkCount: number;

  private readonly samples: Buffer;
  private readonly clock: Clock;
  private sink: AudioSink | undefined;
  private cancelTimer: (() => void) | undefined;
  private startedAt = 0;
  private sent = 0;

  /**
   * Reads and validates the WAV up front, so a bad file fails before a session
   * starts rather than part-way through one.
   *
   * @throws {UnsupportedWavFormatError} unless the file is mono 16-bit 24 kHz.
   */
  constructor(path: string, clock: Clock = systemClock) {
    const wav = readWavFile(path);
    if (wav.channels !== 1) throw new UnsupportedWavFormatError(path, `${wav.channels}-channel`);
    if (wav.bitsPerSample !== 16) {
      throw new UnsupportedWavFormatError(path, `${wav.bitsPerSample}-bit`);
    }
    if (wav.sampleRate !== AUDIO_SAMPLE_RATE) {
      throw new UnsupportedWavFormatError(path, `${wav.sampleRate} Hz`);
    }
    this.samples = wav.data;
    this.chunkCount = Math.ceil(wav.data.length / AUDIO_CHUNK_BYTES);
    this.clock = clock;
  }

  /** Replays `fixtures/audio/<name>.wav`. */
  static forFixture(name: string, clock: Clock = systemClock): WavReplaySource {
    return new WavReplaySource(fixtureAudioPath(name), clock);
  }

  start(sink: AudioSink): void {
    if (this.sink) throw new Error("WavReplaySource is already running");
    this.sink = sink;
    this.startedAt = this.clock.now();
    this.sent = 0;
    this.scheduleNext();
  }

  stop(): void {
    this.finish("stopped");
  }

  /**
   * Chunk `i` is due at `(i + 1) * 80 ms` — its audio has to be "recorded"
   * before it can be sent. Every delay is measured from {@link startedAt}
   * rather than from the previous tick, so a late timer doesn't push the whole
   * stream back; if one slept through several chunks, {@link flushDue} catches
   * up on the next tick.
   */
  private scheduleNext(): void {
    if (this.sent >= this.chunkCount) {
      this.finish("complete");
      return;
    }
    const delay = Math.max(0, (this.sent + 1) * AUDIO_CHUNK_MS - this.elapsed());
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = undefined;
      this.flushDue();
    }, delay);
  }

  private flushDue(): void {
    if (!this.sink) return;
    // 1 ms of slack: timers that fire a hair early shouldn't cost a whole round trip.
    const due = this.elapsed() + 1;
    while (this.sent < this.chunkCount && (this.sent + 1) * AUDIO_CHUNK_MS <= due) {
      const start = this.sent * AUDIO_CHUNK_BYTES;
      const slice = this.samples.subarray(start, start + AUDIO_CHUNK_BYTES);
      this.sent += 1;
      // The file rarely ends on a chunk boundary; pad the tail with silence so
      // every chunk is the size the interface promises.
      const chunk =
        slice.length === AUDIO_CHUNK_BYTES
          ? Buffer.from(slice)
          : Buffer.concat([slice, Buffer.alloc(AUDIO_CHUNK_BYTES - slice.length)]);
      this.sink.onChunk(chunk);
      if (!this.sink) return; // the sink called stop()
    }
    this.scheduleNext();
  }

  private finish(reason: "complete" | "stopped"): void {
    const sink = this.sink;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.sink = undefined;
    sink?.onEnd(reason);
  }

  private elapsed(): number {
    return this.clock.now() - this.startedAt;
  }
}
