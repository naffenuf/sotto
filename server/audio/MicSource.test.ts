import { describe, expect, it } from "vitest";
import { AUDIO_CHUNK_BYTES, type AudioEndReason, type AudioSink } from "./AudioSource.js";
import { MIC_BUFFER_LIMIT_BYTES, MicSource } from "./MicSource.js";

/** Collects what a source produces, as the transcription client would. */
function collector(): AudioSink & { chunks: Buffer[]; ended: AudioEndReason | undefined } {
  const sink = {
    chunks: [] as Buffer[],
    ended: undefined as AudioEndReason | undefined,
    onChunk(chunk: Buffer) {
      sink.chunks.push(Buffer.from(chunk));
    },
    onEnd(reason: AudioEndReason) {
      sink.ended = reason;
    },
  };
  return sink;
}

/** `bytes` bytes of recognisable audio: a counter, one byte at a time. */
function audio(bytes: number, from = 0): Buffer {
  return Buffer.from(Array.from({ length: bytes }, (_, i) => (from + i) % 256));
}

describe("MicSource", () => {
  it("reframes whatever the socket delivers into whole 80 ms chunks", () => {
    const mic = new MicSource();
    const sink = collector();
    mic.start(sink);
    mic.attach();

    // Three messages that do not line up with the chunk boundary at all.
    mic.write(audio(1_000));
    expect(sink.chunks).toHaveLength(0);
    mic.write(audio(3_000, 1_000));
    expect(sink.chunks).toHaveLength(1);
    mic.write(audio(AUDIO_CHUNK_BYTES * 2, 4_000));
    expect(sink.chunks).toHaveLength(3);

    expect(sink.chunks.every((chunk) => chunk.length === AUDIO_CHUNK_BYTES)).toBe(true);
    // The samples come out in the order they went in, boundaries and all.
    expect(Buffer.concat(sink.chunks)).toEqual(audio(AUDIO_CHUNK_BYTES * 3));
    expect(mic.chunksSent).toBe(3);
  });

  it("buffers audio that arrives before the transcription socket is ready", () => {
    const mic = new MicSource();
    mic.attach();
    mic.write(audio(AUDIO_CHUNK_BYTES));

    const sink = collector();
    mic.start(sink);
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]).toEqual(audio(AUDIO_CHUNK_BYTES));
  });

  it("drops audio rather than growing without a sink forever", () => {
    const mic = new MicSource();
    mic.attach();
    for (let sent = 0; sent < MIC_BUFFER_LIMIT_BYTES * 2; sent += AUDIO_CHUNK_BYTES) {
      mic.write(audio(AUDIO_CHUNK_BYTES));
    }
    expect(mic.droppedBytes).toBeGreaterThan(0);

    const sink = collector();
    mic.start(sink);
    expect(sink.chunks.length * AUDIO_CHUNK_BYTES).toBeLessThanOrEqual(MIC_BUFFER_LIMIT_BYTES);
  });

  it("pads the tail and completes when the browser's socket closes", () => {
    const mic = new MicSource();
    const sink = collector();
    mic.start(sink);
    mic.attach();
    mic.write(audio(AUDIO_CHUNK_BYTES + 10));

    mic.endInput();
    expect(sink.chunks).toHaveLength(2);
    expect(sink.chunks[1]).toHaveLength(AUDIO_CHUNK_BYTES);
    expect(sink.chunks[1]?.subarray(10).every((byte) => byte === 0)).toBe(true);
    expect(sink.ended).toBe("complete");

    // Nothing after the end, however late it arrives.
    mic.write(audio(AUDIO_CHUNK_BYTES));
    expect(sink.chunks).toHaveLength(2);
  });

  it("ends with `stopped` when the session is stopped instead", () => {
    const mic = new MicSource();
    const sink = collector();
    mic.start(sink);
    mic.stop();
    expect(sink.ended).toBe("stopped");
    mic.stop();
    expect(sink.ended).toBe("stopped");
  });

  it("lets one socket in at a time", () => {
    const mic = new MicSource();
    expect(mic.connected).toBe(false);
    expect(mic.attach()).toBe(true);
    expect(mic.connected).toBe(true);
    expect(mic.attach()).toBe(false);

    mic.endInput();
    expect(mic.connected).toBe(false);
    // The input has ended; a late reconnection does not restart it.
    expect(mic.attach()).toBe(false);
  });

  it("refuses a second sink", () => {
    const mic = new MicSource();
    mic.start(collector());
    expect(() => mic.start(collector())).toThrow(/already running/);
  });
});
