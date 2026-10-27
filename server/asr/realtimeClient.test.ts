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
import { SimulatedClock } from "../clock.js";
import { TurnAssembler } from "./turns.js";

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

  /**
   * @param behave decides how each connection ends.
   * @param admit optionally holds the n-th upgrade open until it resolves, so a
   * test can make audio pile up while the client has no socket.
   */
  constructor(
    behave: (socket: ServerSocket, connection: Connection, index: number) => void,
    admit?: (index: number) => Promise<void>,
  ) {
    let upgrades = 0;
    this.server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      ...(admit
        ? {
            verifyClient: (_info: unknown, cb: (ok: boolean) => void) => {
              void admit(upgrades++).then(() => cb(true));
            },
          }
        : {}),
    });
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
        socket.on("message", () => socket.close(CLOSE_INTERNAL, "backend went away"));
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

/**
 * The 60-minute session limit, end to end: the client reconnects and the
 * assembler carries the conversation across the seam.
 *
 * The limit arrives as a 1011 like a backend failure does, but it is expected,
 * so it reconnects straight away rather than waiting out the retry backoff —
 * audio is still arriving while the client has no socket.
 */
describe("reconnecting across the 60-minute session limit", () => {
  /** One complete turn, framed the way `fixtures/events/NOTES.md` records it. */
  function turnFrames(
    turnId: number,
    label: string,
    text: string,
    atMs: number,
  ): Record<string, unknown>[] {
    return [
      { type: "speechStart", turnId, audioProcessedMs: atMs },
      { type: "transcript", transcript: text.slice(0, 6), final: false, audioProcessedMs: atMs + 100 },
      { type: "transcript", transcript: text, final: false, audioProcessedMs: atMs + 200 },
      { type: "speaker", label, audioProcessedMs: atMs + 250 },
      { type: "speechEnd", turnId, audioProcessedMs: atMs + 300 },
      { type: "speechComplete", turnId, transcript: text, audioProcessedMs: atMs + 300 },
    ];
  }

  it("opens a new session, keeps the queued audio, and maps the new speaker labels", async () => {
    const endStream = JSON.stringify({ type: "endStream" });
    let secondUpgradeStarted = false;
    let admitSecond = () => {};
    const heldUpgrade = new Promise<void>((resolve) => {
      admitSecond = resolve;
    });

    asr = new FakeAsr(
      (socket, connection, index) => {
        socket.on("message", (data: Buffer, isBinary: boolean) => {
          if (isBinary) return;
          const text = data.toString("utf8");
          if (text === endStream) {
            socket.close(CLOSE_NORMAL, "done");
            return;
          }
          // React to the handshake only: two turns, then the limit.
          if (connection.textFrames.length !== 1) return;
          const frames =
            index === 0
              ? [...turnFrames(0, "A", " First speaker. ", 0), ...turnFrames(1, "B", " Second speaker. ", 1_000)]
              : // A fresh session labels the room from scratch, and here it
                // hears the second speaker first.
                [...turnFrames(0, "B", " Still here. ", 0), ...turnFrames(1, "A", " So am I. ", 1_000)];
          for (const frame of frames) socket.send(JSON.stringify(frame));
          if (index === 0) socket.close(CLOSE_INTERNAL, MAX_SESSION_DURATION_REASON);
        });
      },
      (index) => {
        if (index === 0) return Promise.resolve();
        secondUpgradeStarted = true;
        return heldUpgrade;
      },
    );

    const assembler = new TurnAssembler({ clock: new SimulatedClock(), startedAtMs: 0 });
    const delays: number[] = [];
    const source = manualSource();
    const client = new RealtimeTranscriptionClient({
      apiKey: "test-key",
      url: await asr.url(),
      clock: fastRetryClock(delays),
      onFrame: (record) => void assembler.accept(record),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const run = client.run(source);

    // The second session's upgrade is held open, so the client has no socket:
    // these chunks only reach the API if they were queued, not dropped.
    await waitFor(() => secondUpgradeStarted);
    expect(asr.connections).toHaveLength(1);
    for (let i = 0; i < 4; i += 1) source.push();
    admitSecond();

    await waitFor(() => (asr?.connections[1]?.binaryFrames ?? 0) === 4);
    source.end();
    const result = await run;

    expect(result.sessionCount).toBe(2);
    expect(result.sessionIds).toEqual(["fake/session/0", "fake/session/1"]);
    expect(asr.connections[0]?.binaryFrames).toBe(0);
    expect(asr.connections[1]?.binaryFrames).toBe(4);
    // The limit is not a failure, so none of the retry budget was spent.
    expect(delays.filter((ms) => RETRY_BACKOFF_MS.includes(ms))).toEqual([]);

    const turns = assembler.finalTurns();
    expect(turns.map((turn) => turn.turnId)).toEqual(["0:0", "0:1", "1:0", "1:1"]);
    expect(turns.map((turn) => turn.text)).toEqual([
      " First speaker. ",
      " Second speaker. ",
      " Still here. ",
      " So am I. ",
    ]);
    // Session 1's "B" is session 0's "A": same order of first appearance.
    expect(turns.map((turn) => turn.speaker)).toEqual(["A", "B", "A", "B"]);
    expect(turns.map((turn) => turn.speakerMappingUncertain)).toEqual([false, false, true, true]);
    expect(assembler.malformedFrames()).toBe(0);
  });

  it("does not spend the retry budget on repeated session limits", async () => {
    const endStream = JSON.stringify({ type: "endStream" });
    // Five sessions in a row hit the limit — more than the three-retry budget.
    asr = new FakeAsr((socket, connection, index) => {
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const text = data.toString("utf8");
        if (text === endStream) {
          socket.close(CLOSE_NORMAL, "done");
          return;
        }
        if (connection.textFrames.length !== 1) return;
        if (index < 5) socket.close(CLOSE_INTERNAL, `${MAX_SESSION_DURATION_REASON}.`);
      });
    });

    const source = manualSource();
    const client = new RealtimeTranscriptionClient({
      apiKey: "test-key",
      url: await asr.url(),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const run = client.run(source);

    await waitFor(() => asr?.connections.length === 6);
    source.end();
    const result = await run;

    expect(result.sessionCount).toBe(6);
  });
});
