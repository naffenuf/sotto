/**
 * The realtime client against a local WebSocket server standing in for Meta's.
 * No network: the server listens on 127.0.0.1 on an ephemeral port.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  AUDIO_CHUNK_BYTES,
  type AudioSink,
  type AudioSource,
  AUDIO_SAMPLE_RATE,
} from "../audio/AudioSource.js";
import { systemClock, type Clock } from "../clock.js";
import {
  AUDIO_ENCODING,
  CLOSE_INTERNAL,
  CLOSE_NORMAL,
  CLOSE_POLICY,
  CLOSE_RATE_LIMITED,
  RETRY_BACKOFF_MS,
  MAX_SESSION_DURATION_REASON,
  RealtimeTranscriptionClient,
  RealtimeTranscriptionError,
  TRANSCRIBE_MODEL,
  WAKE_KEYWORDS,
} from "./realtimeClient.js";
import type { AsrFrameRecord } from "../../shared/asr.js";

/** Emits `count` chunks as fast as the client will take them, then ends. */
function stubSource(count: number): AudioSource {
  let stopped = false;
  let sink: AudioSink | undefined;
  return {
    sampleRate: AUDIO_SAMPLE_RATE,
    start(s) {
      sink = s;
      for (let i = 0; i < count && !stopped; i += 1) {
        s.onChunk(Buffer.alloc(AUDIO_CHUNK_BYTES, i + 1));
      }
      if (!stopped) s.onEnd("complete");
    },
    stop() {
      if (stopped) return;
      stopped = true;
      sink = undefined;
    },
  };
}

/** A source the test drives chunk by chunk, so audio can appear mid-backoff. */
function manualSource(): AudioSource & { sink: AudioSink | undefined; push(): void; end(): void } {
  return {
    sampleRate: AUDIO_SAMPLE_RATE,
    sink: undefined as AudioSink | undefined,
    start(s) {
      this.sink = s;
    },
    stop() {
      this.sink = undefined;
    },
    push() {
      this.sink?.onChunk(Buffer.alloc(AUDIO_CHUNK_BYTES, 7));
    },
    end() {
      this.sink?.onEnd("complete");
    },
  };
}

/** Polls `condition` until it holds, so tests don't guess at timing. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Connection {
  handshake: Record<string, unknown>;
  binaryFrames: number;
  textFrames: string[];
}

/**
 * A stand-in for the API. `onConnection` decides how each connection ends, so
 * tests can drive close codes.
 */
class FakeAsr {
  readonly connections: Connection[] = [];
  private readonly server: WebSocketServer;
  private readonly ready: Promise<void>;

  constructor(behave: (socket: ServerSocket, connection: Connection, index: number) => void) {
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.ready = new Promise((resolve) => this.server.once("listening", resolve));
    this.server.on("connection", (socket) => {
      const connection: Connection = { handshake: {}, binaryFrames: 0, textFrames: [] };
      const index = this.connections.push(connection) - 1;
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          connection.binaryFrames += 1;
          return;
        }
        const text = data.toString("utf8");
        connection.textFrames.push(text);
        if (connection.textFrames.length === 1) {
          connection.handshake = JSON.parse(text) as Record<string, unknown>;
          socket.send(JSON.stringify({ sessionId: `fake/session/${index}` }));
        }
      });
      behave(socket, connection, index);
    });
  }

  async url(): Promise<string> {
    await this.ready;
    const { port } = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}`;
  }

  close(): Promise<void> {
    for (const client of this.server.clients) client.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** Holds the retry backoff open so a test can act while the client has no socket. */
function heldRetryClock(pending: Array<{ ms: number; fire: () => void }>): Clock {
  return {
    now: () => systemClock.now(),
    setTimeout: (fn, ms) => {
      if (!RETRY_BACKOFF_MS.includes(ms)) return systemClock.setTimeout(fn, ms);
      pending.push({ ms, fire: fn });
      return () => {};
    },
  };
}

/** Collapses the retry backoff so the schedule can be asserted without waiting 7 s. */
function fastRetryClock(delays: number[]): Clock {
  return {
    now: () => systemClock.now(),
    setTimeout: (fn, ms) => {
      delays.push(ms);
      return systemClock.setTimeout(fn, RETRY_BACKOFF_MS.includes(ms) ? 1 : ms);
    },
  };
}

let asr: FakeAsr | undefined;
afterEach(async () => {
  await asr?.close();
  asr = undefined;
});

describe("RealtimeTranscriptionClient", () => {
  it("sends the documented handshake, streams chunks, then endStream", async () => {
    asr = new FakeAsr((socket, connection) => {
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary || data.toString("utf8") !== JSON.stringify({ type: "endStream" })) return;
        socket.send(
          JSON.stringify({ type: "speechComplete", turnId: 0, transcript: " Hello. ", audioProcessedMs: 240 }),
        );
        socket.close(CLOSE_NORMAL, "done");
        void connection;
      });
    });

    const frames: AsrFrameRecord[] = [];
    const client = new RealtimeTranscriptionClient({
      apiKey: "test-key",
      url: await asr.url(),
      onFrame: (record) => frames.push(record),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await client.run(stubSource(3));

    const connection = asr.connections[0];
    expect(connection?.handshake).toEqual({
      authorization: { accessToken: "Bearer test-key" },
      audioEncoding: AUDIO_ENCODING,
      model: TRANSCRIBE_MODEL,
      mode: "DIARIZATION",
      keywords: WAKE_KEYWORDS,
    });
    expect(connection?.binaryFrames).toBe(3);
    expect(connection?.textFrames.at(-1)).toBe(JSON.stringify({ type: "endStream" }));

    expect(result.sessionIds).toEqual(["fake/session/0"]);
    expect(result.sessionCount).toBe(1);
    expect(frames.map((f) => f.frame["type"])).toEqual([undefined, "speechComplete"]);
    expect(frames.every((f) => f.session === 0 && f.atMs >= 0)).toBe(true);
    expect(result.frameCount).toBe(2);
  });

  it("treats 1008 as fatal and does not retry", async () => {
    asr = new FakeAsr((socket) => {
      socket.on("message", () => socket.close(CLOSE_POLICY, "audio pacing too slow"));
    });
    const errors: string[] = [];
    const client = new RealtimeTranscriptionClient({
      apiKey: "test-key",
      url: await asr.url(),
      logger: { log: () => {}, warn: () => {}, error: (message) => errors.push(String(message)) },
    });

    await expect(client.run(stubSource(2))).rejects.toThrow(RealtimeTranscriptionError);
    expect(asr.connections).toHaveLength(1);
    expect(errors.join("\n")).toContain("1008");
  });

  it("retries 1011 and 1013 with 1 s, 2 s, 4 s backoff, then gives up", async () => {
    asr = new FakeAsr((socket, _connection, index) => {
      socket.on("message", () =>
        socket.close(index % 2 === 0 ? CLOSE_INTERNAL : CLOSE_RATE_LIMITED, "try again"),
      );
    });
    const delays: number[] = [];
    const client = new RealtimeTranscriptionClient({
      apiKey: "test-key",
      url: await asr.url(),
      clock: fastRetryClock(delays),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    await expect(client.run(stubSource(1))).rejects.toMatchObject({ code: CLOSE_RATE_LIMITED });
    // One initial attempt plus three retries.
    expect(asr.connections).toHaveLength(4);
    expect(delays.filter((ms) => RETRY_BACKOFF_MS.includes(ms))).toEqual([1_000, 2_000, 4_000]);
  });

  it("holds audio produced during backoff and sends it on the new session", async () => {
    asr = new FakeAsr((socket, _connection, index) => {
      if (index === 0) {
        // Drop the first session the moment the handshake lands.
        socket.on("message", () => socket.close(CLOSE_INTERNAL, MAX_SESSION_DURATION_REASON));
        return;
      }
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString("utf8") === JSON.stringify({ type: "endStream" })) {
          socket.close(CLOSE_NORMAL, "done");
        }
      });
    });

    const source = manualSource();
    const backoff: Array<{ ms: number; fire: () => void }> = [];
    const client = new RealtimeTranscriptionClient({
      apiKey: "test-key",
      url: await asr.url(),
      clock: heldRetryClock(backoff),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const run = client.run(source);

    // Once the client is waiting out the backoff it has no socket, so these
    // chunks can only reach the API if they are held until the next session.
    await waitFor(() => backoff.length === 1);
    expect(backoff[0]?.ms).toBe(RETRY_BACKOFF_MS[0]);
    for (let i = 0; i < 5; i += 1) source.push();
    backoff[0]?.fire();

    await waitFor(() => (asr?.connections[1]?.binaryFrames ?? 0) === 5);
    source.end();
    const result = await run;

    expect(result.sessionCount).toBe(2);
    expect(asr.connections[0]?.binaryFrames).toBe(0);
    expect(asr.connections[1]?.binaryFrames).toBe(5);
    expect(asr.connections[1]?.textFrames.at(-1)).toBe(JSON.stringify({ type: "endStream" }));
  });
});
