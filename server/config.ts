import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { DEFAULT_KNOWLEDGE_DIR } from "../shared/knowledge.js";
import { McpConfigFileSchema, expandEnvReferences, type McpServerConfig } from "../shared/mcp.js";
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

/** The default config file, read when `MCP_SERVERS` is unset. Optional. */
export const DEFAULT_MCP_CONFIG_PATH = "mcp.json";

/**
 * Which MCP servers this Sotto is a client of (post-V3-011), or an empty list.
 *
 * `MCP_SERVERS` is either a path to a JSON file or the JSON itself (anything
 * that starts with `{`). The file is `{ "mcpServers": { "<name>": … } }` —
 * the shape Claude Desktop and the editors write — where each server is
 * `command`/`args`/`env` (stdio) or `url`/`headers` (Streamable HTTP). A
 * `${NAME}` in a header or env value expands from Sotto's own environment,
 * which is how a token stays in `.env` while `mcp.json` can be committed.
 *
 * Like the knowledge folder, this is optional and never an error: a missing
 * file is an empty list, which is what every session without company tools
 * gets. A file that *is* there but does not parse is reported through
 * `logger.warn` and also read as empty, because a typo in `mcp.json` must not
 * stop a meeting from starting. Secrets are expanded here and nowhere else;
 * nothing in the returned list is ever logged.
 */
export function loadMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { logger?: Pick<Console, "warn">; readFile?: (path: string) => string } = {},
): McpServerConfig[] {
  loadDotenv({ quiet: true });
  const logger = options.logger ?? console;
  const read = options.readFile ?? ((path: string): string => readFileSync(path, "utf8"));
  const setting = (env.MCP_SERVERS ?? "").trim();
  let text: string;
  let where: string;
  if (setting.startsWith("{")) {
    text = setting;
    where = "MCP_SERVERS";
  } else {
    where = setting === "" ? DEFAULT_MCP_CONFIG_PATH : setting;
    try {
      text = read(where);
    } catch (error) {
      // The default file not being there is the ordinary case; a named one
      // not being there is worth a line.
      if (setting !== "") logger.warn(`[mcp] ${where} could not be read: ${message(error)}`);
      return [];
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logger.warn(`[mcp] ${where} is not JSON (${message(error)}); no company tools this session`);
    return [];
  }
  const config = McpConfigFileSchema.safeParse(parsed);
  if (!config.success) {
    logger.warn(
      `[mcp] ${where} is not an MCP config: ${config.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
    return [];
  }
  const expand = (values: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, expandEnvReferences(value, env)]),
    );
  return Object.entries(config.data.mcpServers).map(([name, spec]): McpServerConfig => {
    if ("url" in spec) {
      return { name, transport: "http", url: spec.url, headers: expand(spec.headers) };
    }
    return {
      name,
      transport: "stdio",
      command: spec.command,
      args: spec.args,
      env: expand(spec.env),
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    };
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
