import { describe, expect, it } from "vitest";
import { SimulatedClock } from "../clock.js";
import { AUDIO_CHUNK_BYTES, recordedSource, type AudioEndReason, type AudioSink } from "./AudioSource.js";
import {
  MIC_BUFFER_LIMIT_BYTES,
  MIC_GRACE_MS,
  MIC_STALE_MS,
  MicSource,
  type MicHandle,
} from "./MicSource.js";

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

/** Attaches, which every test wants to succeed. */
function attach(mic: MicSource, onReplaced?: () => void): MicHandle {
  const handle = mic.attach(onReplaced);
  if (handle === null) throw new Error("attach refused");
  return handle;
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
    const handle = attach(mic);

    // Three messages that do not line up with the chunk boundary at all.
    handle.write(audio(1_000));
    expect(sink.chunks).toHaveLength(0);
    handle.write(audio(3_000, 1_000));
    expect(sink.chunks).toHaveLength(1);
    handle.write(audio(AUDIO_CHUNK_BYTES * 2, 4_000));
    expect(sink.chunks).toHaveLength(3);

    expect(sink.chunks.every((chunk) => chunk.length === AUDIO_CHUNK_BYTES)).toBe(true);
    // The samples come out in the order they went in, boundaries and all.
    expect(Buffer.concat(sink.chunks)).toEqual(audio(AUDIO_CHUNK_BYTES * 3));
    expect(mic.chunksSent).toBe(3);
  });

  it("buffers audio that arrives before the transcription socket is ready", () => {
    const mic = new MicSource();
    attach(mic).write(audio(AUDIO_CHUNK_BYTES));

    const sink = collector();
    mic.start(sink);
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]).toEqual(audio(AUDIO_CHUNK_BYTES));
  });

  it("drops audio rather than growing without a sink forever", () => {
    const mic = new MicSource();
    const handle = attach(mic);
    for (let sent = 0; sent < MIC_BUFFER_LIMIT_BYTES * 2; sent += AUDIO_CHUNK_BYTES) {
      handle.write(audio(AUDIO_CHUNK_BYTES));
    }
    expect(mic.droppedBytes).toBeGreaterThan(0);

    const sink = collector();
    mic.start(sink);
    expect(sink.chunks.length * AUDIO_CHUNK_BYTES).toBeLessThanOrEqual(MIC_BUFFER_LIMIT_BYTES);
  });

  it("pads the tail and completes when the browser says it is done", () => {
    const mic = new MicSource();
    const sink = collector();
    mic.start(sink);
    const handle = attach(mic);
    handle.write(audio(AUDIO_CHUNK_BYTES + 10));

    handle.end();
    expect(sink.chunks).toHaveLength(2);
    expect(sink.chunks[1]).toHaveLength(AUDIO_CHUNK_BYTES);
    expect(sink.chunks[1]?.subarray(10).every((byte) => byte === 0)).toBe(true);
    expect(sink.ended).toBe("complete");
    expect(handle.active).toBe(false);

    // Nothing after the end, however late it arrives.
    handle.write(audio(AUDIO_CHUNK_BYTES));
    expect(sink.chunks).toHaveLength(2);
    expect(mic.attach()).toBeNull();
  });

  it("holds the session open through a dropped socket and takes the page back", () => {
    const clock = new SimulatedClock(0);
    const mic = new MicSource({ clock });
    const sink = collector();
    const connection: boolean[] = [];
    mic.onConnection = (connected) => connection.push(connected);
    mic.start(sink);
    const first = attach(mic);
    first.write(audio(AUDIO_CHUNK_BYTES, 1));

    // A refresh: the socket drops, the page did not say it was done.
    first.detach();
    expect(mic.connected).toBe(false);
    expect(mic.waiting).toBe(true);
    expect(first.active).toBe(false);
    expect(sink.ended).toBeUndefined();
    expect(connection).toEqual([false]);

    clock.advanceBy(MIC_GRACE_MS - 1);
    expect(sink.ended).toBeUndefined();

    // The reloaded page dials again, and the stream carries on.
    const second = attach(mic);
    expect(mic.waiting).toBe(false);
    expect(connection).toEqual([false, true]);
    second.write(audio(AUDIO_CHUNK_BYTES, 2));
    expect(sink.chunks).toHaveLength(2);
    expect(sink.chunks[1]?.[0]).toBe(2);

    // The grace timer was cancelled: a minute later nothing has ended.
    clock.advanceBy(MIC_GRACE_MS * 2);
    expect(sink.ended).toBeUndefined();

    // A late close from the first socket is about a socket that no longer holds anything.
    first.detach();
    first.end();
    expect(mic.connected).toBe(true);
    expect(sink.ended).toBeUndefined();
  });

  it("ends the input when the page never comes back", () => {
    const clock = new SimulatedClock(0);
    const mic = new MicSource({ clock });
    const sink = collector();
    mic.start(sink);
    const handle = attach(mic);
    handle.write(audio(10));
    handle.detach();

    clock.advanceBy(MIC_GRACE_MS);
    expect(sink.ended).toBe("complete");
    // The partial chunk went out padded, as on a clean end.
    expect(sink.chunks).toHaveLength(1);
    expect(mic.attach()).toBeNull();
  });

  it("stopping the session cancels the grace timer", () => {
    const clock = new SimulatedClock(0);
    const mic = new MicSource({ clock });
    const sink = collector();
    mic.start(sink);
    attach(mic).detach();
    mic.stop();
    expect(sink.ended).toBe("stopped");
    expect(clock.nextDueAt()).toBeUndefined();
  });

  it("lets a newcomer replace a holder that has gone quiet", () => {
    const clock = new SimulatedClock(0);
    const mic = new MicSource({ clock });
    const sink = collector();
    mic.start(sink);
    let replaced = 0;
    const first = attach(mic, () => { replaced += 1; });
    first.write(audio(AUDIO_CHUNK_BYTES, 1));

    // Still streaming: a second socket is turned away.
    clock.advanceBy(MIC_STALE_MS - 1);
    expect(mic.attach()).toBeNull();
    expect(replaced).toBe(0);

    // A laptop that slept: the server will not hear this socket close for
    // minutes, but it has sent nothing for two seconds, so the woken page's
    // new socket takes over and the old one is told.
    clock.advanceBy(1);
    const second = attach(mic);
    expect(replaced).toBe(1);
    expect(first.active).toBe(false);
    expect(second.active).toBe(true);
    first.write(audio(AUDIO_CHUNK_BYTES, 9));
    second.write(audio(AUDIO_CHUNK_BYTES, 2));
    expect(sink.chunks).toHaveLength(2);
    expect(sink.chunks[1]?.[0]).toBe(2);
    // The old socket's eventual close must not end the session either way.
    first.detach();
    expect(mic.waiting).toBe(false);
    first.end();
    expect(sink.ended).toBeUndefined();
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
    const handle = attach(mic);
    expect(mic.connected).toBe(true);
    expect(mic.attach()).toBeNull();

    handle.end();
    expect(mic.connected).toBe(false);
    // The input has ended; a late reconnection does not restart it.
    expect(mic.attach()).toBeNull();
  });

  it("refuses a second sink", () => {
    const mic = new MicSource();
    mic.start(collector());
    expect(() => mic.start(collector())).toThrow(/already running/);
  });
});

describe("recordedSource", () => {
  it("hands every chunk to the recorder and the sink alike, padding included", () => {
    const mic = new MicSource();
    const recorded: Buffer[] = [];
    const source = recordedSource(mic, (chunk) => recorded.push(Buffer.from(chunk)));
    const sink = collector();
    source.start(sink);
    const handle = attach(mic);
    handle.write(audio(AUDIO_CHUNK_BYTES + 100));
    handle.end();
    expect(sink.chunks.length).toBe(2);
    expect(recorded.length).toBe(2);
    expect(Buffer.concat(recorded).equals(Buffer.concat(sink.chunks))).toBe(true);
    expect(recorded[1]?.length).toBe(AUDIO_CHUNK_BYTES);
    expect(sink.ended).toBe("complete");
  });

  it("stops the source it wraps", () => {
    const mic = new MicSource();
    const source = recordedSource(mic, () => undefined);
    const sink = collector();
    source.start(sink);
    source.stop();
    expect(sink.ended).toBe("stopped");
  });
});
