import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { ApiError, HealthResponse } from "../shared/types.js";
import type { ServerEvent } from "../shared/events.js";
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

  await app.register(websocket);

  app.get("/api/health", async (): Promise<HealthResponse> => ({ ok: true }));

  app.get("/api/fixtures", async (): Promise<FixtureListResponse> => listFixtures());

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

  app.post("/api/session/stop", async (): Promise<SessionStopResponse> => ({
    stopped: await sessions.stop(),
  }));

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
    return {
      settings: sessions.setChattiness(parsed.data.chattiness),
    } satisfies SessionSettingsResponse;
  });

  // Microphone audio (US-012): PCM16 mono 24 kHz in 80 ms binary messages,
  // already converted by the browser. The session is started over HTTP first,
  // so by the time this opens there is a `MicSource` waiting for it.
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
  app.addHook("onClose", async () => {
    await sessions.stop();
  });

  return app;
}
