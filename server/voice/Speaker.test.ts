/**
 * The Speaker against a local WebSocket server standing in for ElevenLabs'.
 * No network: it listens on 127.0.0.1 on an ephemeral port, and every frame
 * the real API would send is scripted here from
 * https://elevenlabs.io/docs/api-reference/websocket.
 */
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { AUDIO_SAMPLE_RATE } from "../../shared/audio.js";
import { DEFAULT_TTS_MODEL, ELEVENLABS_OUTPUT_FORMAT } from "./elevenlabs.js";
import {
  CHUNK_LENGTH_SCHEDULE,
  DEFAULT_SOTTO_VOICE_ID,
  readAlignment,
  Speaker,
  SpeakerError,
} from "./Speaker.js";

/** Silent PCM16 of a given length, so byte counts map to durations. */
function pcm(ms: number): Buffer {
  return Buffer.alloc(Math.round((AUDIO_SAMPLE_RATE * ms) / 1000) * 2);
}

/** An alignment frame: every character the same width, starting at `startMs`. */
function alignmentFor(text: string, startMs: number, perCharMs: number) {
  const chars = [...text];
  return {
    chars,
    charStartTimesMs: chars.map((_, i) => startMs + i * perCharMs),
    charDurationsMs: chars.map(() => perCharMs),
  };
}

interface Connection {
  socket: ServerSocket;
  /** Query string of the upgrade request. */
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  /** Every JSON frame the client sent, parsed, in order. */
  frames: Array<Record<string, unknown>>;
}

/** A stand-in for the API. `behave` decides what each client frame provokes. */
class FakeElevenLabs {
  readonly connections: Connection[] = [];
  private readonly server: WebSocketServer;
  private readonly ready: Promise<void>;

  constructor(behave: (connection: Connection, frame: Record<string, unknown>) => void) {
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.ready = new Promise((resolve) => this.server.once("listening", resolve));
    this.server.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "/", "ws://127.0.0.1");
      const connection: Connection = {
        socket,
        query: url.searchParams,
        headers: request.headers,
        frames: [],
      };
      this.connections.push(connection);
      socket.on("message", (data: Buffer) => {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        connection.frames.push(frame);
        behave(connection, frame);
      });
    });
  }

  /** The path is appended by the Speaker, so this is just the origin. */
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

function send(socket: ServerSocket, frame: Record<string, unknown>): void {
  socket.send(JSON.stringify(frame));
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

let fake: FakeElevenLabs | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("Speaker", () => {
  it("opens the documented endpoint, authenticates in the header and sends the handshake", async () => {
    fake = new FakeElevenLabs(() => {});
    const speaker = new Speaker({ apiKey: "test-key", url: await fake.url(), logger: quiet });
    await speaker.start();
    await waitFor(() => (fake?.connections[0]?.frames.length ?? 0) >= 1);

    const connection = fake.connections[0];
    expect(connection).toBeDefined();
    expect(connection?.headers["xi-api-key"]).toBe("test-key");
    expect(connection?.query.get("model_id")).toBe(DEFAULT_TTS_MODEL);
    expect(DEFAULT_TTS_MODEL).toBe("eleven_flash_v2_5");
    expect(connection?.query.get("output_format")).toBe(ELEVENLABS_OUTPUT_FORMAT);
    expect(ELEVENLABS_OUTPUT_FORMAT).toBe("pcm_24000");
    expect(connection?.query.get("sync_alignment")).toBe("true");
    expect(speaker.voice).toBe(DEFAULT_SOTTO_VOICE_ID);

    // The first frame is the handshake: a space, never the empty string.
    expect(connection?.frames[0]?.["text"]).toBe(" ");
    expect(connection?.frames[0]?.["generation_config"]).toEqual({
      chunk_length_schedule: CHUNK_LENGTH_SCHEDULE,
    });
    // The key belongs in the upgrade header, so it is not in any message.
    expect(JSON.stringify(connection?.frames)).not.toContain("test-key");
    speaker.cancel();
  });

  it("uses ELEVENLABS_VOICE_ID's voice when one is given", async () => {
    fake = new FakeElevenLabs(() => {});
    const speaker = new Speaker({
      apiKey: "k",
      voiceId: "my-voice",
      url: await fake.url(),
      logger: quiet,
    });
    await speaker.start();
    expect(speaker.voice).toBe("my-voice");
    speaker.cancel();
  });

  it("accepts text a sentence at a time and speaks the first one before the rest exists", async () => {
    const chunks: Buffer[] = [];
    fake = new FakeElevenLabs((connection, frame) => {
      // The server only generates on a flush, as the real one does below its
      // first chunk_length_schedule threshold.
      if (frame["flush"] === true) {
        send(connection.socket, {
          audio: pcm(100).toString("base64"),
          alignment: alignmentFor("Hello.", 0, 10),
        });
      }
      if (frame["text"] === "") send(connection.socket, { isFinal: true });
    });

    const speaker = new Speaker({
      apiKey: "k",
      url: await fake.url(),
      logger: quiet,
      onAudio: (chunk) => chunks.push(chunk),
    });
    await speaker.start();

    // The first append flushes by default, so audio arrives for sentence one
    // while the second sentence has not been written yet.
    speaker.append("Hello.");
    await waitFor(() => chunks.length === 1);
    expect(speaker.firstAudioMs).not.toBeNull();

    speaker.append("Here is the rest of it.");
    await waitFor(() => (fake?.connections[0]?.frames.length ?? 0) >= 3);
    const sent = fake.connections[0]?.frames ?? [];
    expect(sent[1]).toEqual({ text: "Hello. ", flush: true });
    expect(sent[2]).toEqual({ text: "Here is the rest of it. ", flush: false });

    const result = await speaker.finish();
    expect(sent[3]).toEqual({ text: "" });
    expect(result.reason).toBe("complete");
    expect(result.text).toBe("Hello. Here is the rest of it.");
    expect(result.audioBytes).toBe(pcm(100).length);
    expect(Math.round(result.audioMs)).toBe(100);
  });

  it("tracks the text spoken so far from alignment and reported playback", async () => {
    fake = new FakeElevenLabs((connection, frame) => {
      if (frame["text"] === "One two. ") {
        // Cumulative timings, as /stream-input sends them: 100 ms of audio
        // covering "One two." at 12.5 ms a character.
        send(connection.socket, {
          audio: pcm(100).toString("base64"),
          alignment: alignmentFor("One two.", 0, 12.5),
        });
        // A second frame continuing the same timeline.
        send(connection.socket, {
          audio: pcm(100).toString("base64"),
          alignment: alignmentFor("Three.", 100, 16),
        });
      }
      if (frame["text"] === "") send(connection.socket, { isFinal: true });
    });

    const speaker = new Speaker({ apiKey: "k", url: await fake.url(), logger: quiet });
    await speaker.start();
    speaker.append("One two.");
    await waitFor(() => speaker.alignedText() === "One two.Three.");

    // Nothing is claimed as spoken before the browser says it played anything.
    expect(speaker.spokenSoFar()).toBe("");

    // 50 ms in: four characters of "One two." have finished sounding.
    speaker.notePlayedMs(50);
    expect(speaker.spokenSoFar()).toBe("One");

    speaker.notePlayedMs(100);
    expect(speaker.spokenSoFar()).toBe("One two.");

    // A late, lower report cannot un-speak anything.
    speaker.notePlayedMs(10);
    expect(speaker.spokenSoFar()).toBe("One two.");

    speaker.notePlayedAll();
    expect(speaker.spokenSoFar()).toBe("One two.Three.");

    const result = await speaker.finish();
    expect(result.spokenSoFar).toBe("One two.Three.");
  });

  it("offsets alignment that restarts at zero on every frame", async () => {
    fake = new FakeElevenLabs((connection, frame) => {
      if (frame["flush"] === true) {
        send(connection.socket, {
          audio: pcm(100).toString("base64"),
          alignment: alignmentFor("Hi.", 0, 20),
        });
        // Chunk-relative: starts back at 0 even though 100 ms has been sent.
        send(connection.socket, {
          audio: pcm(100).toString("base64"),
          alignment: alignmentFor("Bye.", 0, 20),
        });
      }
    });

    const speaker = new Speaker({ apiKey: "k", url: await fake.url(), logger: quiet });
    await speaker.start();
    speaker.append("Hi.");
    await waitFor(() => speaker.alignedText() === "Hi.Bye.");

    // "Hi." ends at 60 ms; "Bye." must land after the 100 ms already sent, not
    // on top of it.
    speaker.notePlayedMs(99);
    expect(speaker.spokenSoFar()).toBe("Hi.");
    speaker.notePlayedMs(180);
    expect(speaker.spokenSoFar()).toBe("Hi.Bye.");
    speaker.cancel();
  });

  it("cancels mid-stream: audio stops at once and what was heard is kept", async () => {
    const chunks: Buffer[] = [];
    let serverSocket: ServerSocket | undefined;
    fake = new FakeElevenLabs((connection, frame) => {
      serverSocket = connection.socket;
      if (frame["flush"] === true) {
        send(connection.socket, {
          audio: pcm(200).toString("base64"),
          alignment: alignmentFor("Stop me here.", 0, 15),
        });
      }
    });

    const speaker = new Speaker({
      apiKey: "k",
      url: await fake.url(),
      logger: quiet,
      onAudio: (chunk) => chunks.push(chunk),
    });
    await speaker.start();
    speaker.append("Stop me here.");
    await waitFor(() => chunks.length === 1);

    const finished = speaker.finish();
    speaker.notePlayedMs(60);
    speaker.cancel();

    // Frames the server had already queued are discarded, not played.
    send(serverSocket as ServerSocket, {
      audio: pcm(200).toString("base64"),
      alignment: alignmentFor(" And more.", 200, 15),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(chunks).toHaveLength(1);

    const result = await finished;
    expect(result.reason).toBe("cancelled");
    expect(result.spokenSoFar).toBe("Stop");
    expect(result.text).toBe("Stop me here.");
    expect(speaker.finished).toBe(true);

    // Text pushed into a cancelled Speaker goes nowhere.
    speaker.append("ignored");
    expect(speaker.text).toBe("Stop me here. ");
  });

  it("rejects finish() when the stream closes before it is done", async () => {
    fake = new FakeElevenLabs((connection, frame) => {
      if (frame["flush"] === true) connection.socket.close(1011, "backend blew up");
    });
    const speaker = new Speaker({ apiKey: "k", url: await fake.url(), logger: quiet });
    await speaker.start();
    speaker.append("Hello.");
    await expect(speaker.finish()).rejects.toThrow(SpeakerError);
  });

  it("fails start() when the handshake is refused", async () => {
    const speaker = new Speaker({
      apiKey: "k",
      // Nothing is listening here, so the upgrade can never complete.
      url: "ws://127.0.0.1:1",
      logger: quiet,
    });
    await expect(speaker.start()).rejects.toThrow(SpeakerError);
  });

  it("is single-use", async () => {
    fake = new FakeElevenLabs(() => {});
    const speaker = new Speaker({ apiKey: "k", url: await fake.url(), logger: quiet });
    await speaker.start();
    await expect(speaker.start()).rejects.toThrow(/single-use/);
    speaker.cancel();
  });
});

describe("readAlignment", () => {
  it("prefers the characters as sent over the normalized reading", () => {
    const alignment = readAlignment({
      alignment: alignmentFor("2010", 0, 10),
      normalizedAlignment: alignmentFor("twenty ten", 0, 4),
    });
    expect(alignment?.chars.join("")).toBe("2010");
  });

  it("accepts either spelling of the durations array", () => {
    const chars = ["a", "b"];
    const alignment = readAlignment({
      alignment: { chars, charStartTimesMs: [0, 10], charsDurationsMs: [10, 10] },
    });
    expect(alignment?.durationMs).toEqual([10, 10]);
  });

  it("falls back to the normalized alignment and ignores a malformed one", () => {
    expect(
      readAlignment({
        alignment: { chars: ["a"], charStartTimesMs: [0] },
        normalizedAlignment: alignmentFor("ab", 0, 10),
      })?.chars,
    ).toEqual(["a", "b"]);
    expect(readAlignment({ audio: "..." })).toBeUndefined();
  });
});
