import { config as loadDotenv } from "dotenv";

/** Server-side configuration. The model API key never leaves this process. */
export interface ServerConfig {
  /** Meta Model API key, read from `.env`. Never log or serialize this. */
  modelApiKey: string;
  /** Port the Fastify server listens on, bound to 127.0.0.1. */
  port: number;
}

/** Only 127.0.0.1 — Sotto is a local app and must not be reachable from the network. */
export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "MODEL_API_KEY is missing. Copy .env.example to .env and set MODEL_API_KEY to your Meta Model API key.",
    );
    this.name = "MissingApiKeyError";
  }
}

/**
 * Loads `.env` and returns the server config.
 * Throws {@link MissingApiKeyError} when `MODEL_API_KEY` is absent or blank.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  loadDotenv({ quiet: true });
  const modelApiKey = (env.MODEL_API_KEY ?? "").trim();
  if (modelApiKey === "") throw new MissingApiKeyError();
  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(env.PORT)}`);
  }
  return { modelApiKey, port };
}
