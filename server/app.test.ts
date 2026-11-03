import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { TYPED_ASKER } from "../shared/answers.js";
import { ARTIFACT_CSP } from "../shared/artifacts.js";
import { emptyBoard } from "../shared/board.js";
import type { ServerEvent } from "../shared/events.js";
import type { FixtureListResponse } from "../shared/session.js";
import { buildApp } from "./app.js";
import { EventBus } from "./events/bus.js";
import type { ReplaySpeed } from "./asr/EventReplaySource.js";
import { AUDIO_CHUNK_BYTES, type AudioEndReason, type AudioSource } from "./audio/AudioSource.js";
import type {
  ModelClient,
  ProseCall,
  ProseReply,
  StructuredCall,
} from "./model/client.js";
import {
  SessionManager,
  type AsrClient,
  type SessionStoreFactory,
} from "./session/SessionManager.js";
import { SessionStore } from "./session/SessionStore.js";
import { emptyModel } from "./test/emptyModel.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/** Waits for something a request caused on the other side of the server. */
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * An app with its own bus and session manager, so a test can look at the bus
 * and choose the replay speed. Nothing here touches the network: `max` runs a
 * capture through in milliseconds, `1x` leaves it running until it is stopped.
 */
async function buildTestApp(
  options: {
    apiKey?: string;
    speed?: ReplaySpeed;
    model?: ModelClient;
    /** A session folder, for the one route that serves a file out of it. */
    store?: SessionStoreFactory;
  } = {},
): Promise<{
  app: FastifyInstance;
  bus: EventBus;
  audio: FakeAsrClient;
  sessions: SessionManager;
}> {
  const bus = new EventBus(quiet);
  const audio = new FakeAsrClient();
  const sessions = new SessionManager({
    bus,
    apiKey: options.apiKey ?? "test-key",
    logger: quiet,
    // `npm test` writes no session folders; US-008 has its own tests for those.
    createStore: options.store ?? ((): null => null),
    replaySpeed: options.speed ?? "max",
    // A live source (`mic`, `wav`) must not reach the real API from here.
    createAsrClient: () => audio,
    createModel: () => options.model ?? (options.apiKey === "" ? null : emptyModel),
    // V2-010: `npm test` does not dial the local Glimmer server either, so
    // judgment falls back to the (fake) cloud client above.
    createGlimmer: () => null,
  });
  app = await buildApp({ bus, sessions });
  return { app, bus, audio, sessions };
}

/** Drains an audio source and counts its chunks, in place of the real client. */
class FakeAsrClient implements AsrClient {
  readonly chunks: Buffer[] = [];
  endReason: AudioEndReason | undefined;
  private source: AudioSource | undefined;

  run(source: AudioSource): Promise<void> {
    this.source = source;
    return new Promise<void>((resolve) => {
      source.start({
        onChunk: (chunk) => this.chunks.push(Buffer.from(chunk)),
        onEnd: (reason) => {
          this.endReason = reason;
          resolve();
        },
      });
    });
  }

  stop(): void {
    this.source?.stop();
  }
}

describe("GET /api/health", () => {
  it("returns { ok: true }", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});

describe("listen", () => {
  it("binds to 127.0.0.1 only", async () => {
    app = await buildApp();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("GET /api/fixtures", () => {
  it("lists the fixtures that have audio and the ones that have captures", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/fixtures" });
    expect(response.statusCode).toBe(200);
    const body = response.json<FixtureListResponse>();
    expect(body.wav).toContain("brainstorm");
    expect(body.events).toContain("brainstorm");
    expect(body.wav).toEqual([...body.wav].sort());
  });
});

describe("POST /api/session/start", () => {
  it("starts an events replay", async () => {
    const { app: server } = await buildTestApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "brainstorm" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      session: {
        id: "events-brainstorm-1",
        source: { kind: "events", fixture: "brainstorm" },
        startedAtMs: 0,
      },
    });
  });

  it("rejects a body that is not a source", async () => {
    const { app: server } = await buildTestApp();
    for (const payload of [
      {},
      { source: { kind: "tape", fixture: "brainstorm" } },
      { source: { kind: "events" } },
      { source: { kind: "events", fixture: "../secrets" } },
    ]) {
      const response = await server.inject({ method: "POST", url: "/api/session/start", payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<{ error: string }>().error).toBeTruthy();
    }
  });

  it("answers 409 while a session is running", async () => {
    // At 1x the replay is still going when the second request arrives; at max
    // the whole capture would be through before it.
    const { app: server } = await buildTestApp({ speed: "1x" });
    const start = {
      method: "POST" as const,
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "brainstorm" } },
    };
    await server.inject(start);
    const second = await server.inject(start);
    expect(second.statusCode).toBe(409);
  });

  it("starts a microphone session", async () => {
    const { app: server } = await buildTestApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "mic" } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ session: { source: { kind: "mic" } } });
  });

  it("answers 503 for a microphone with no API key configured", async () => {
    const { app: server } = await buildTestApp({ apiKey: "" });
    const response = await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "mic" } },
    });
    expect(response.statusCode).toBe(503);
  });
});

describe("POST /api/session/stop", () => {
  it("stops a running session and reports when there was none", async () => {
    const { app: server } = await buildTestApp({ speed: "1x" });
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "brainstorm" } },
    });

    const stopped = await server.inject({ method: "POST", url: "/api/session/stop" });
    expect(stopped.json()).toEqual({ stopped: true });

    const again = await server.inject({ method: "POST", url: "/api/session/stop" });
    expect(again.json()).toEqual({ stopped: false });
  });
});

describe("POST /api/session/speaker", () => {
  const rename = (payload: Record<string, unknown>) => ({
    method: "POST" as const,
    url: "/api/session/speaker",
    payload,
  });

  it("names a label for the running session and pushes it to the bus", async () => {
    const { app: server, bus } = await buildTestApp({ speed: "1x" });
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "brainstorm" } },
    });

    const named = await server.inject(rename({ label: "A", name: " Craig " }));
    expect(named.statusCode).toBe(200);
    expect(named.json()).toEqual({ renamed: true, speakers: { A: "Craig" } });
    expect(bus.speakerNames()).toEqual({ A: "Craig" });

    // `null` is how the UI goes back to the bare label.
    const cleared = await server.inject(rename({ label: "A", name: null }));
    expect(cleared.json()).toEqual({ renamed: true, speakers: {} });
  });

  it("answers 409 when no session is running", async () => {
    const { app: server } = await buildTestApp();
    const response = await server.inject(rename({ label: "A", name: "Craig" }));
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(/no session is running/);
  });

  it("rejects a body that is not a name for a label", async () => {
    const { app: server } = await buildTestApp({ speed: "1x" });
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "brainstorm" } },
    });
    for (const payload of [{}, { label: "" }, { label: "A" }, { label: "A", name: "x".repeat(41) }]) {
      const response = await server.inject(rename(payload));
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("POST /api/session/settings", () => {
  const change = (payload: Record<string, unknown>) => ({
    method: "POST" as const,
    url: "/api/session/settings",
    payload,
  });

  it("sets the two contribution settings and remembers them on the bus", async () => {
    const { app: server, bus } = await buildTestApp();

    const response = await server.inject(
      change({ frequency: "rare", boldness: "cautious", voiceMuted: false }),
    );
    const settings = { frequency: "rare", boldness: "cautious", voiceMuted: false };
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ settings });
    expect(bus.settingsState()).toEqual(settings);
    // So a browser that attaches afterwards is caught up with it.
    expect(bus.snapshot()).toContainEqual({ type: "settings", settings });
  });

  it("takes one of the two on its own, which is what each selector sends", async () => {
    const { app: server } = await buildTestApp();
    const first = await server.inject(change({ boldness: "bold" }));
    expect(first.json()).toEqual({
      settings: { frequency: "normal", boldness: "bold", voiceMuted: false },
    });
    const second = await server.inject(change({ frequency: "often" }));
    expect(second.json()).toEqual({
      settings: { frequency: "often", boldness: "bold", voiceMuted: false },
    });
  });

  it("rejects anything that is not one of the levels, chattiness included", async () => {
    const { app: server } = await buildTestApp();
    const bad = [
      {},
      { frequency: "" },
      { frequency: "constant" },
      { boldness: "loud" },
      { boldness: 2 },
      // The setting V2-017 replaced is not a settings change any more.
      { chattiness: "quiet" },
    ];
    for (const payload of bad) {
      const response = await server.inject(change(payload));
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("POST /api/feedback", () => {
  /**
   * A model that notices one serious contradiction per board update, each
   * about something else, so the policy (US-014) puts cards on the stage
   * instead of holding everything.
   */
  class LoudModel implements ModelClient {
    /** One per look, so no two candidates read as the same thing. */
    private static readonly subjects = [
      "the hosting bill",
      "the launch date",
      "the pilot headcount",
      "the support rota",
      "the data licence",
      "the vendor quote",
      "the studio timeline",
      "the API pricing",
      "the hardware stock",
      "the discount floor",
    ];

    private items = 0;

    async grounded(): Promise<never> {
      throw new Error("a contradiction is never checked against the web");
    }

    async prose(): Promise<never> {
      throw new Error("nobody asks Sotto anything here");
    }

    async structured(call: StructuredCall): Promise<unknown> {
      if (call.label === "board") {
        this.items += 1;
        return {
          operations: [
            { op: "add_point", text: `point ${this.items}`, sourceTurnIds: ["0:0"] },
          ],
        };
      }
      return {
        candidates: [
          {
            type: "contradiction",
            headline: `${LoudModel.subjects[(this.items - 1) % LoudModel.subjects.length]} cannot hold with what was just agreed`,
            detail: "The number they just agreed is under the floor they set.",
            whyNow: "the price is about to be written down",
            evidenceTurnIds: ["0:0"],
            relatedBoardItemIds: [`p${this.items}`],
            scores: { relevance: 1, novelty: 1, importance: 1, confidence: 1 },
          },
        ],
      };
    }
  }

  const file = (payload: Record<string, unknown>) => ({
    method: "POST" as const,
    url: "/api/feedback",
    payload,
  });

  /** Replays a fixture to the end, so its cards are on the stage to judge. */
  async function withCards(): Promise<{ app: FastifyInstance; cardId: string }> {
    const { app: server, bus } = await buildTestApp({ model: new LoudModel() });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "moment-contradiction" } },
    });
    await ended;
    const card = bus.cardState()[0];
    if (card === undefined) throw new Error("the replay put nothing on the stage");
    return { app: server, cardId: card.id };
  }

  it("files a verdict on a card that was shown", async () => {
    const { app: server, cardId } = await withCards();

    const response = await server.inject(file({ cardId, verdict: "wrong_moment" }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ recorded: true, verdict: "wrong_moment" });
  });

  it("will not take a verdict on a card nobody was shown", async () => {
    const { app: server } = await withCards();

    const response = await server.inject(file({ cardId: "card-cand-999", verdict: "useful" }));
    expect(response.statusCode).toBe(404);
  });

  it("answers 409 while Sotto has said nothing at all", async () => {
    const { app: server } = await buildTestApp();

    const response = await server.inject(file({ cardId: "card-cand-1", verdict: "useful" }));
    expect(response.statusCode).toBe(409);
  });

  it("rejects anything that is not one of the three verdicts", async () => {
    const { app: server } = await buildTestApp();
    for (const payload of [
      {},
      { cardId: "card-cand-1" },
      { cardId: "", verdict: "useful" },
      { cardId: "card-cand-1", verdict: "meh" },
      { cardId: 7, verdict: "useful" },
    ]) {
      const response = await server.inject(file(payload));
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("POST /api/ask", () => {
  /** A model that answers anything, and remembers what it was asked. */
  class AnsweringModel implements ModelClient {
    readonly questions: string[] = [];

    async structured(call: StructuredCall): Promise<unknown> {
      return call.label === "board" ? { operations: [] } : { candidates: [] };
    }

    async grounded(): Promise<never> {
      throw new Error("an answer is prose, not JSON");
    }

    async prose(call: { user: string }): Promise<{
      text: string;
      citations: never[];
      searchedUrls: never[];
      searched: boolean;
      functionCalls: number;
    }> {
      this.questions.push(call.user);
      return {
        text: "Two weeks, at the rate they are going\n\nThe board has four open questions.",
        citations: [],
        searchedUrls: [],
        searched: false,
        functionCalls: 0,
      };
    }
  }

  const ask = (payload: Record<string, unknown>) => ({
    method: "POST" as const,
    url: "/api/ask",
    payload,
  });

  /** A replay run to the end, so there is a finished session to ask about. */
  async function afterASession(
    model: ModelClient,
  ): Promise<{ app: FastifyInstance; bus: EventBus }> {
    const { app: server, bus } = await buildTestApp({ model });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "no-wake" } },
    });
    await ended;
    return { app: server, bus };
  }

  it("answers a question typed while a session is running", async () => {
    const model = new AnsweringModel();
    // `1x`, so the replay is still going when the question is typed.
    const { app: server, bus } = await buildTestApp({ model, speed: "1x" });
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "no-wake" } },
    });

    const response = await server.inject(ask({ question: "  how long is left?  " }));
    expect(response.statusCode).toBe(200);
    // The question comes back trimmed, as the server took it.
    expect(response.json()).toEqual({ asked: true, question: "how long is left?" });

    await waitFor(() => bus.cardState().length > 0, "the answer card");
    const card = bus.cardState()[0];
    expect(card?.variant).toBe("answer");
    expect(card?.question).toBe("how long is left?");
    expect(card?.askedBy).toBe(TYPED_ASKER);
    expect(model.questions[0]).toContain("how long is left?");

    await server.inject({ method: "POST", url: "/api/session/stop" });
  });

  it("answers one typed after Stop, against the session that just ended", async () => {
    const model = new AnsweringModel();
    const { app: server, bus } = await afterASession(model);
    expect(bus.currentSession()).toBeNull();

    const response = await server.inject(ask({ question: "what did we decide?" }));
    expect(response.statusCode).toBe(200);

    await waitFor(() => bus.cardState().length > 0, "the answer card");
    const card = bus.cardState()[0];
    expect(card?.variant).toBe("answer");
    expect(card?.state).toBe("ready");
    expect(card?.headline).toBe("Two weeks, at the rate they are going");
    // It was answered with that conversation, not with nothing.
    expect(model.questions[0]).toContain("What they have been saying");
    expect(model.questions[0]).not.toContain("nothing has been transcribed yet");
  });

  it("has no conversation to answer in until something has run", async () => {
    const { app: server } = await buildTestApp();
    const response = await server.inject(ask({ question: "what did we decide?" }));
    expect(response.statusCode).toBe(409);
  });

  it("says so when the server has no model client", async () => {
    const { app: server } = await buildTestApp({ apiKey: "" });
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "no-wake" } },
    });
    const response = await server.inject(ask({ question: "what did we decide?" }));
    expect(response.statusCode).toBe(503);
  });

  it("rejects anything that is not a question", async () => {
    const { app: server } = await buildTestApp();
    for (const payload of [{}, { question: "" }, { question: "   " }, { question: 7 }, { question: "x".repeat(501) }]) {
      const response = await server.inject(ask(payload));
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("/ws/audio", () => {
  it("feeds the running microphone session", async () => {
    const { app: server, audio } = await buildTestApp();
    await server.ready();
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "mic" } },
    });

    const socket = await server.injectWS("/ws/audio");
    socket.send(Buffer.alloc(AUDIO_CHUNK_BYTES, 7));
    await waitFor(() => audio.chunks.length === 1, "the chunk to reach the transcription client");
    expect(audio.chunks[0]).toEqual(Buffer.alloc(AUDIO_CHUNK_BYTES, 7));
    socket.close();
  });

  it("ends the session when the browser's socket closes", async () => {
    // A real socket, because an injected one never completes the closing
    // handshake and the server would never hear about it.
    const { app: server, audio } = await buildTestApp();
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "mic" } },
    });

    const client = new WebSocket(`${address.replace("http", "ws")}/ws/audio`);
    await new Promise((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });
    client.send(Buffer.alloc(AUDIO_CHUNK_BYTES, 3));
    // A clean close is the page saying it is done (`MicCapture.stop()`).
    client.close(1000, "capture stopped");

    await waitFor(() => audio.endReason !== undefined, "the input to end");
    expect(audio.endReason).toBe("complete");
    expect(audio.chunks).toHaveLength(1);
  });

  it("holds the session open when the browser's socket drops, and takes the next one", async () => {
    const { app: server, audio, sessions } = await buildTestApp();
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "mic" } },
    });
    const dial = async (): Promise<WebSocket> => {
      const client = new WebSocket(`${address.replace("http", "ws")}/ws/audio`);
      await new Promise((resolve, reject) => {
        client.on("open", resolve);
        client.on("error", reject);
      });
      return client;
    };

    const first = await dial();
    first.send(Buffer.alloc(AUDIO_CHUNK_BYTES, 1));
    await waitFor(() => audio.chunks.length === 1, "the first chunk to arrive");
    // A refresh: the socket goes without a clean close.
    first.terminate();
    await waitFor(() => sessions.micInput()?.waiting === true, "the grace period to open");
    expect(audio.endReason).toBeUndefined();

    const second = await dial();
    second.send(Buffer.alloc(AUDIO_CHUNK_BYTES, 2));
    await waitFor(() => audio.chunks.length === 2, "the second socket's chunk to arrive");
    expect(sessions.micInput()?.waiting).toBe(false);
    expect(audio.endReason).toBeUndefined();
    second.close(1000, "capture stopped");
    await waitFor(() => audio.endReason !== undefined, "the input to end");
  });

  it("turns a socket away when no microphone session is running", async () => {
    const { app: server } = await buildTestApp();
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const client = new WebSocket(`${address.replace("http", "ws")}/ws/audio`);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      client.on("close", (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString("utf8") }),
      );
    });
    expect(closed.code).toBe(1008);
    expect(closed.reason).toMatch(/start a microphone session first/);
  });
});

describe("/ws/events", () => {
  /**
   * Opens a socket and starts reading before the server can speak. The
   * snapshot goes out the moment the route handler runs, so a listener
   * attached after `injectWS` resolves would miss it.
   */
  async function open(
    server: FastifyInstance,
    done: (events: ServerEvent[]) => boolean,
  ): Promise<{
    socket: Awaited<ReturnType<FastifyInstance["injectWS"]>>;
    events: Promise<ServerEvent[]>;
  }> {
    const seen: ServerEvent[] = [];
    let settle: (events: ServerEvent[]) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const events = new Promise<ServerEvent[]>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // `injectWS` routes through the router, so the app has to be ready first.
    await server.ready();
    const socket = await server.injectWS("/ws/events", undefined, {
      onInit: (ws) => {
        ws.on("message", (data: unknown) => {
          seen.push(JSON.parse(String(data)) as ServerEvent);
          if (done(seen)) settle(seen);
        });
        ws.on("error", fail);
      },
    });
    return { socket, events };
  }

  it("catches a new socket up with the statuses and the session", async () => {
    const { app: server, bus } = await buildTestApp();
    bus.setStatus("transcription", "active", "replaying brainstorm events at max");

    const { socket, events } = await open(server, (seen) => seen.length === 11);
    const snapshot = await events;
    socket.close();

    expect(snapshot).toEqual([
      { type: "status", status: { channel: "server", state: "active" } },
      {
        type: "status",
        status: {
          channel: "transcription",
          state: "active",
          detail: "replaying brainstorm events at max",
        },
      },
      // The model dot only claims to be ready while a session is running.
      { type: "status", status: { channel: "model", state: "idle" } },
      // And nothing is judged until one is (V2-010).
      { type: "status", status: { channel: "judgment", state: "idle" } },
      { type: "session", session: null },
      { type: "speakers", speakers: {} },
      // Nothing has been said, so the board is empty rather than absent.
      { type: "board", board: emptyBoard(), changedIds: [], updatedAtMs: 0 },
      // And Sotto is as talkative as it comes (US-014).
      {
        type: "settings",
        settings: { frequency: "normal", boldness: "normal", voiceMuted: false },
      },
      // Nobody has said its name (US-017).
      { type: "wake", listening: false, inConversation: false },
      { type: "voice", voice: { speaking: false, playing: false, utteranceId: null, text: "" } },
      // Nothing is written and waiting for a gap: the stage's Now zone is listening.
      { type: "waiting", lines: [] },
      // And it has held nothing back, because nothing has been noticed (V3-016).
      { type: "suppressed", suppressed: [] },
    ]);
  });

  it("pushes turns and status changes while a session runs", async () => {
    const { app: server } = await buildTestApp();
    // The eleven snapshot events, then the session's own, ending back at null.
    const { socket, events } = await open(server, (seen) => {
      const last = seen.at(-1);
      return seen.length > 11 && last?.type === "session" && last.session === null;
    });

    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "moment-fact" } },
    });
    const seen = await events;
    socket.close();

    expect(seen.filter((event) => event.type === "turn").length).toBeGreaterThan(10);
    expect(
      seen.filter((event) => event.type === "session").map((event) => event.session !== null),
    ).toEqual([false, true, false]);
    const dots = seen
      .filter((event) => event.type === "status")
      .map((event) => `${event.status.channel}:${event.status.state}`);
    expect(dots).toContain("transcription:active");
    // V2-010: with no Glimmer the judgment dot settles on the cloud, and
    // every dot but the server's is idle again once the session has gone.
    expect(dots).toContain("judgment:active");
    expect(dots.slice(-2)).toEqual(["model:idle", "judgment:idle"]);
  });

  it("drops its subscription when the socket closes", async () => {
    // A real socket on a real local port: an injected one does not complete
    // the closing handshake, so the server would never hear about it.
    const { app: server, bus } = await buildTestApp();
    const baselineListeners = bus.listenerCount;
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const client = new WebSocket(`${address.replace("http", "ws")}/ws/events`);
    await new Promise((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });
    expect(bus.listenerCount).toBe(baselineListeners + 1);

    await new Promise<void>((resolve) => {
      client.on("close", () => resolve());
      client.close();
    });
    // The close has to reach the server before the subscription goes.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bus.listenerCount).toBe(baselineListeners);
  });
});

describe("GET /api/sessions/:id/artifacts/:file", () => {
  const HTML = "<!DOCTYPE html><html><body><svg width='10' height='10'/></body></html>";

  /** A model that draws once, then answers. */
  class DrawingModel implements ModelClient {
    async structured(call: StructuredCall): Promise<unknown> {
      return call.label === "board" ? { operations: [] } : { candidates: [] };
    }

    async grounded(): Promise<never> {
      throw new Error("an answer is prose, not JSON");
    }

    async prose(call: ProseCall): Promise<ProseReply> {
      const tool = (call.functions ?? []).find((one) => one.name === "show_html");
      if (tool === undefined) throw new Error("show_html was not offered");
      await tool.run({ title: "User flow", html: HTML });
      return {
        text: "Four screens, end to end\n\nThe loops are at the bottom.",
        citations: [],
        searchedUrls: [],
        searched: false,
        functionCalls: 1,
      };
    }
  }

  /** A finished session with one artifact on its stage. */
  async function withAnArtifact(): Promise<{
    app: FastifyInstance;
    bus: EventBus;
    root: string;
    url: string;
  }> {
    const root = mkdtempSync(join(tmpdir(), "sotto-artifact-"));
    const { app: server, bus } = await buildTestApp({
      model: new DrawingModel(),
      store: (info) => SessionStore.create(info, { root, logger: quiet }),
    });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "no-wake" } },
    });
    await ended;
    await server.inject({ method: "POST", url: "/api/ask", payload: { question: "sketch it" } });
    await waitFor(
      () => (bus.cardState()[0]?.artifacts ?? []).length > 0,
      "the artifact on the card",
    );
    const url = bus.cardState()[0]?.artifacts?.[0]?.url as string;
    return { app: server, bus, root, url };
  }

  it("serves the HTML with the headers that make the frame a sandbox", async () => {
    const { app: server, root, url } = await withAnArtifact();
    try {
      expect(url).toBe("/api/sessions/events-no-wake-1/artifacts/01-user-flow.html");
      const response = await server.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(HTML);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["content-security-policy"]).toBe(ARTIFACT_CSP);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds nothing outside the artifacts it wrote", async () => {
    const { app: server, root } = await withAnArtifact();
    try {
      for (const path of [
        "/api/sessions/events-no-wake-1/artifacts/02-user-flow.html",
        "/api/sessions/events-no-wake-1/artifacts/session.json",
        "/api/sessions/events-no-wake-1/artifacts/..%2Fsession.json",
        "/api/sessions/events-no-wake-1/artifacts/..%2F..%2F.env",
        "/api/sessions/events-brainstorm-1/artifacts/01-user-flow.html",
      ]) {
        const response = await server.inject({ method: "GET", url: path });
        expect(response.statusCode, path).toBe(404);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
