import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { HealthResponse } from "../shared/index.js";

export interface AppOptions {
  /** Fastify logger setting; off by default so tests stay quiet. */
  logger?: boolean;
}

/**
 * Builds the Fastify instance. Kept separate from {@link start} so tests can
 * use `app.inject()` without opening a socket.
 */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(websocket);

  app.get("/api/health", async (): Promise<HealthResponse> => ({ ok: true }));

  return app;
}
