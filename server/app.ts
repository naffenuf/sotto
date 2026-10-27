import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { ApiError, HealthResponse } from "../shared/types.js";
import type { ServerEvent } from "../shared/events.js";
import {
  SessionStartRequestSchema,
  type FixtureListResponse,
  type SessionStartResponse,
  type SessionStopResponse,
} from "../shared/session.js";
import { EventBus } from "./events/bus.js";
import { listFixtures } from "./fixtures.js";
import { SessionManager, SessionStartError } from "./session/SessionManager.js";

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
