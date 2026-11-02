import { config as loadDotenv } from "dotenv";
import { DEFAULT_KNOWLEDGE_DIR } from "../shared/knowledge.js";
import { DEFAULT_SOTTO_VOICE_ID } from "./voice/Speaker.js";

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

export class MissingElevenLabsKeyError extends Error {
  constructor() {
    super(
      "ELEVENLABS_API_KEY is missing. Copy .env.example to .env and set ELEVENLABS_API_KEY to your ElevenLabs API key.",
    );
    this.name = "MissingElevenLabsKeyError";
  }
}

/**
 * Loads `.env` and returns the ElevenLabs API key, which Sotto's voice (V2-003)
 * and the fixture renderer (V2-001) both need. Separate from
 * {@link loadConfig} because rendering test audio needs no model key.
 * Throws {@link MissingElevenLabsKeyError} when the key is absent or blank.
 */
export function loadElevenLabsApiKey(env: NodeJS.ProcessEnv = process.env): string {
  loadDotenv({ quiet: true });
  const key = (env.ELEVENLABS_API_KEY ?? "").trim();
  if (key === "") throw new MissingElevenLabsKeyError();
  return key;
}

/** Where Muse Glimmer is served, when it is (V2-010). */
export interface GlimmerConfig {
  /** `GLIMMER_BASE_URL`, e.g. `http://127.0.0.1:11434/v1`, without a trailing slash. */
  baseUrl: string;
  /** `GLIMMER_MODEL`, e.g. `muse-glimmer:30b-q4_K_M`. */
  model: string;
}

/**
 * Loads `.env` and returns where Glimmer is, or `null` when either variable
 * is missing. Unlike the two API keys this is *optional*: Glimmer is a local
 * server that may not be running, and a session without it judges with Muse
 * Spark instead (see {@link JudgmentRouter}), so there is no error to throw.
 */
export function loadGlimmerConfig(env: NodeJS.ProcessEnv = process.env): GlimmerConfig | null {
  loadDotenv({ quiet: true });
  const baseUrl = (env.GLIMMER_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const model = (env.GLIMMER_MODEL ?? "").trim();
  if (baseUrl === "" || model === "") return null;
  return { baseUrl, model };
}

/**
 * The ElevenLabs voice Sotto speaks with: `ELEVENLABS_VOICE_ID` when set,
 * otherwise {@link DEFAULT_SOTTO_VOICE_ID}. A voice id is configuration rather
 * than something to discover, because the key in `.env` is scoped to synthesis
 * and may not list voices.
 */
export function loadSottoVoiceId(env: NodeJS.ProcessEnv = process.env): string {
  loadDotenv({ quiet: true });
  return (env.ELEVENLABS_VOICE_ID ?? "").trim() || DEFAULT_SOTTO_VOICE_ID;
}

/**
 * Where the group's own files are (V3-009): `KNOWLEDGE_DIR` when it is set,
 * otherwise {@link DEFAULT_KNOWLEDGE_DIR} under the current directory.
 *
 * A path rather than an index, and never an error: the folder is optional and
 * most sessions have none — {@link KnowledgeIndex.load} returns `null` for a
 * folder that is missing or empty, which is what every caller branches on.
 */
export function loadKnowledgeDir(env: NodeJS.ProcessEnv = process.env): string {
  loadDotenv({ quiet: true });
  return (env.KNOWLEDGE_DIR ?? "").trim() || DEFAULT_KNOWLEDGE_DIR;
}
