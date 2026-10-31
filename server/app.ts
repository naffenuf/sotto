import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { ApiError, HealthResponse } from "../shared/types.js";
import { AskRequestSchema, type AskResponse } from "../shared/answers.js";
import { ARTIFACT_CSP } from "../shared/artifacts.js";
import type { ServerEvent } from "../shared/events.js";
import { FeedbackRequestSchema, type FeedbackResponse } from "../shared/feedback.js";
import {
  SessionSettingsRequestSchema,
  SessionStartRequestSchema,
  SpeakerRenameRequestSchema,
  type FixtureListResponse,
  type SessionSettingsResponse,
  type SessionStartResponse,
  type SessionStopResponse,
  type SpeakerRenameResponse,
} from "../shared/session.js";
import { EventBus } from "./events/bus.js";
import { listFixtures } from "./fixtures.js";
import { SessionManager, SessionStartError } from "./session/SessionManager.js";
import { listHistory, readHistory } from "./session/history.js";
import { VoiceTestRequestSchema } from "../shared/voice.js";
import { loadElevenLabsApiKey, loadSottoVoiceId } from "./config.js";
import { Speaker } from "./voice/Speaker.js";
import { VoiceHub } from "./voice/VoiceHub.js";

/** Close code for a socket that asked for something it may not have. */
const WS_POLICY_VIOLATION = 1008;

export interface AppOptions {
  /** Fastify logger setting; off by default so tests stay quiet. */
  logger?: boolean;
  /** Meta Model API key. Live transcription and the model calls need it. */
  apiKey?: string | undefined;
  /** Supply these to inspect them from a test; otherwise they are built here. */
  bus?: EventBus;
  sessions?: SessionManager;
}

/**
 * Builds the Fastify instance. Kept separate from `server/index.ts` so tests
 * can use `app.inject()` and `app.injectWS()` without opening a socket.
 */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const bus = options.bus ?? new EventBus();
  // The pipeline logs to the console with its own `[session]`/`[asr]` prefixes,
  // as the rest of the server does, rather than through Fastify's logger.
  const sessions = options.sessions ?? new SessionManager({ bus, apiKey: options.apiKey });
  const voice = new VoiceHub(bus, (onAudio) => new Speaker({ apiKey: loadElevenLabsApiKey(), voiceId: loadSottoVoiceId(), onAudio }));

  await app.register(websocket);

  app.get("/api/health", async (): Promise<HealthResponse> => ({ ok: true }));

  app.get("/api/fixtures", async (): Promise<FixtureListResponse> => listFixtures());

  app.get("/api/history", async () => listHistory());
  app.get<{ Params: { folder: string } }>("/api/history/:folder", async (request, reply) => {
    const history = await readHistory(request.params.folder);
    return history ?? reply.code(404).send({ error: "Discussion not found" });
  });

  app.post("/api/session/start", async (request, reply) => {
    const parsed = SessionStartRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: `not a session source: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      } satisfies ApiError);
    }
    try {
      return { session: sessions.start(parsed.data.source) } satisfies SessionStartResponse;
    } catch (error) {
      if (error instanceof SessionStartError) {
        return reply.code(error.status).send({ error: error.message } satisfies ApiError);
      }
      throw error;
    }
  });

  app.post("/api/session/stop", async (): Promise<SessionStopResponse> => {
    voice.stop();
    return { stopped: await sessions.stop() };
  });

  // Naming a diarization label (US-007). The name is a property of the running
  // session, so it goes to the bus (every attached browser) and to the session
  // folder, which rewrites `transcript.md` with it.
  app.post("/api/session/speaker", async (request, reply) => {
    const parsed = SpeakerRenameRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: `not a speaker name: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      } satisfies ApiError);
    }
    if (!sessions.renameSpeaker(parsed.data.label, parsed.data.name)) {
      return reply.code(409).send({
        error: "no session is running; speakers can only be named while Sotto is listening",
      } satisfies ApiError);
    }
    return { renamed: true, speakers: bus.speakerNames() } satisfies SpeakerRenameResponse;
  });

  // How talkative Sotto is (US-014). The setting belongs to the server rather
  // than to one tab — the policy reads it and `session.json` records it — so
  // this answers with the settings as they now stand and the header shows
  // what came back. It works with nothing running: the next session inherits.
  app.post("/api/session/settings", async (request, reply) => {
    const parsed = SessionSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: `not a settings change: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      } satisfies ApiError);
    }
    if (parsed.data.chattiness !== undefined) sessions.setChattiness(parsed.data.chattiness);
    if (parsed.data.voiceMuted !== undefined) {
      sessions.setVoiceMuted(parsed.data.voiceMuted);
      if (parsed.data.voiceMuted) voice.stop();
    }
    return { settings: sessions.settings() } satisfies SessionSettingsResponse;
  });

  app.post("/api/voice/stop", async () => { voice.stop(); return { utteranceId: null, speaking: false }; });
  if (process.env.SOTTO_DEV === "1") {
    app.post("/api/voice/test", async (request, reply) => {
      const parsed = VoiceTestRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Invalid test utterance" });
      try {
        const utteranceId = await voice.speak(parsed.data.text ?? "Hello, I'm Sotto. I'm here to help your conversation.");
        return { utteranceId, speaking: bus.voiceState().speaking };
      } catch (error) {
        return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  // The group's verdict on a card Sotto put up (US-015). The browser sends
  // only the card id: which candidate it was and what level it went out at
  // are the server's own record of the delivery, so a tab cannot file a
  // verdict about a card that was never shown. It answers for the most recent
  // session, not only a running one — a replay's cards are read after it ends.
  app.post("/api/feedback", async (request, reply) => {
    const parsed = FeedbackRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: `not a feedback verdict: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      } satisfies ApiError);
    }
    const outcome = sessions.recordFeedback(parsed.data.cardId, parsed.data.verdict);
    if (outcome === "no-cards") {
      return reply.code(409).send({
        error: "Sotto has not put anything on the stage yet",
      } satisfies ApiError);
    }
    if (outcome === "unknown-card") {
      return reply.code(404).send({
        error: `no card ${parsed.data.cardId} was delivered in this session`,
      } satisfies ApiError);
    }
    return { recorded: true, verdict: parsed.data.verdict } satisfies FeedbackResponse;
  });

  // A question somebody typed instead of saying (US-019). It takes the same
  // path as a spoken one — the session's answer agent, a card on the stage,
  // a line in `answers.jsonl` — so nothing comes back here but the
  // acknowledgement; the answer arrives on `/ws/events`. Like feedback, it
  // is answered for the most recent session, running or not: the question
  // somebody meant to ask is usually typed once the talking has stopped.
  app.post("/api/ask", async (request, reply) => {
    const parsed = AskRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: `not a question: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      } satisfies ApiError);
    }
    const outcome = sessions.askQuestion(parsed.data.question);
    if (outcome === "no-session") {
      return reply.code(409).send({
        error: "start a session first — Sotto answers a question in the conversation it was asked in",
      } satisfies ApiError);
    }
    if (outcome === "no-model") {
      return reply.code(503).send({
        error: "answering needs MODEL_API_KEY in .env",
      } satisfies ApiError);
    }
    return { asked: true, question: parsed.data.question } satisfies AskResponse;
  });

  // One generated HTML artifact (US-020), for the iframe on its card.
  //
  // The headers are the sandbox's other half: the card's frame has
  // `sandbox="allow-scripts"` and no `allow-same-origin`, so the document is
  // its own opaque origin, and `ARTIFACT_CSP` stops it reaching the network
  // at all. `nosniff` is there because this is the one route that serves
  // bytes a model wrote.
  app.get<{ Params: { id: string; file: string } }>(
    "/api/sessions/:id/artifacts/:file",
    async (request, reply) => {
      const path = sessions.artifactFile(request.params.id, request.params.file);
      if (path === null) {
        return reply.code(404).send({
          error: `no artifact ${request.params.file} in session ${request.params.id}`,
        } satisfies ApiError);
      }
      let html: string;
      try {
        html = await readFile(path, "utf8");
      } catch {
        // The session remembers the artifact but the file is gone, which is a
        // missing artifact as far as the frame is concerned.
        return reply.code(404).send({
          error: `artifact ${request.params.file} is not on disk`,
        } satisfies ApiError);
      }
      return reply
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", ARTIFACT_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .send(html);
    },
  );

  // Microphone audio (US-012): PCM16 mono 24 kHz in 80 ms binary messages,
  // already converted by the browser. The session is started over HTTP first,
  // so by the time this opens there is a `MicSource` waiting for it.
  app.get("/ws/voice", { websocket: true }, (socket) => {
    if (!voice.attach(socket)) socket.close(WS_POLICY_VIOLATION, "voice playback is active in another tab");
  });

  app.get("/ws/audio", { websocket: true }, (socket) => {
    const mic = sessions.micInput();
    if (mic === null) {
      socket.close(WS_POLICY_VIOLATION, "start a microphone session first");
      return;
    }
    if (!mic.attach()) {
      socket.close(WS_POLICY_VIOLATION, "a microphone is already streaming into this session");
      return;
    }
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      // Text on this socket is a bug in the client, not audio; ignore it
      // rather than feeding JSON to the transcription API as samples.
      if (isBinary) mic.write(data);
    });
    // A socket that drops ends the input, which flushes the last words out of
    // the API and ends the session. Stopping from the UI closes it the same way.
    socket.on("close", () => mic.endInput());
    socket.on("error", () => mic.endInput());
  });

  // One socket per browser tab. Each one is caught up with the bus's
  // remembered state first, then follows along.
  app.get("/ws/events", { websocket: true }, (socket) => {
    const send = (event: ServerEvent): void => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(event));
    };
    for (const event of bus.snapshot()) send(event);
    const unsubscribe = bus.subscribe(send);
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });

  // Closing the server must not leave a transcription socket open.
  const unsubscribeVoice = bus.subscribe((event) => { if (event.type === "session" && event.session === null) voice.stop(); });
  app.addHook("onClose", async () => {
    unsubscribeVoice();
    voice.stop();
    await sessions.stop();
  });

  return app;
}
