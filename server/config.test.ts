import { describe, expect, it } from "vitest";
import { DEFAULT_KNOWLEDGE_DIR } from "../shared/knowledge.js";
import {
  DEFAULT_PORT,
  HOST,
  loadConfig,
  loadKnowledgeDir,
  loadMcpConfig,
  loadSottoVoiceId,
  MissingApiKeyError,
} from "./config.js";
import { DEFAULT_SOTTO_VOICE_ID } from "./voice/Speaker.js";

describe("loadConfig", () => {
  it("returns the key and the default port", () => {
    expect(loadConfig({ MODEL_API_KEY: "test-key" })).toEqual({
      modelApiKey: "test-key",
      port: DEFAULT_PORT,
    });
  });

  it("honours PORT", () => {
    expect(loadConfig({ MODEL_API_KEY: "test-key", PORT: "9001" }).port).toBe(9001);
  });

  it("throws a clear error when MODEL_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(MissingApiKeyError);
    expect(() => loadConfig({})).toThrow(/MODEL_API_KEY is missing/);
  });

  it("treats a blank MODEL_API_KEY as missing", () => {
    expect(() => loadConfig({ MODEL_API_KEY: "   " })).toThrow(MissingApiKeyError);
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadConfig({ MODEL_API_KEY: "test-key", PORT: "nope" })).toThrow(/PORT must be/);
  });

  it("binds to loopback only", () => {
    expect(HOST).toBe("127.0.0.1");
  });
});

describe("loadSottoVoiceId", () => {
  it("falls back to the documented default voice", () => {
    expect(loadSottoVoiceId({})).toBe(DEFAULT_SOTTO_VOICE_ID);
    expect(loadSottoVoiceId({ ELEVENLABS_VOICE_ID: "  " })).toBe(DEFAULT_SOTTO_VOICE_ID);
  });

  it("honours ELEVENLABS_VOICE_ID", () => {
    expect(loadSottoVoiceId({ ELEVENLABS_VOICE_ID: "custom-voice" })).toBe("custom-voice");
  });
});

describe("loadKnowledgeDir", () => {
  it("falls back to the default folder, which may not exist", () => {
    expect(loadKnowledgeDir({})).toBe(DEFAULT_KNOWLEDGE_DIR);
    expect(loadKnowledgeDir({ KNOWLEDGE_DIR: "  " })).toBe(DEFAULT_KNOWLEDGE_DIR);
  });

  it("honours KNOWLEDGE_DIR", () => {
    expect(loadKnowledgeDir({ KNOWLEDGE_DIR: "fixtures/knowledge-demo" })).toBe(
      "fixtures/knowledge-demo",
    );
  });
});

describe("loadMcpConfig", () => {
  const quiet = { warn: () => {} };
  const file = JSON.stringify({
    mcpServers: {
      crm: { command: "node", args: ["crm.js"], env: { CRM_TOKEN: "${CRM_TOKEN}" } },
      wiki: { url: "https://wiki.example.com/mcp", headers: { Authorization: "Bearer ${WIKI_TOKEN}" } },
    },
  });

  it("is an empty list when the default file is not there, with nothing said", () => {
    const warnings: string[] = [];
    const servers = loadMcpConfig({}, {
      logger: { warn: (line: unknown) => warnings.push(String(line)) },
      readFile: () => { throw new Error("ENOENT"); },
    });
    expect(servers).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("reads the file MCP_SERVERS names and expands ${NAME} from the environment", () => {
    const servers = loadMcpConfig(
      { MCP_SERVERS: "conf/mcp.json", CRM_TOKEN: "crm-secret", WIKI_TOKEN: "wiki-secret" },
      { logger: quiet, readFile: (path) => { expect(path).toBe("conf/mcp.json"); return file; } },
    );
    expect(servers).toEqual([
      { name: "crm", transport: "stdio", command: "node", args: ["crm.js"], env: { CRM_TOKEN: "crm-secret" } },
      { name: "wiki", transport: "http", url: "https://wiki.example.com/mcp", headers: { Authorization: "Bearer wiki-secret" } },
    ]);
  });

  it("takes the JSON inline", () => {
    const servers = loadMcpConfig({ MCP_SERVERS: file }, { logger: quiet, readFile: () => { throw new Error("not read"); } });
    expect(servers.map((server) => server.name)).toEqual(["crm", "wiki"]);
  });

  it("warns and carries on with nothing when the file is broken", () => {
    const warnings: string[] = [];
    const logger = { warn: (line: unknown) => warnings.push(String(line)) };
    expect(loadMcpConfig({ MCP_SERVERS: "x.json" }, { logger, readFile: () => "{ not json" })).toEqual([]);
    expect(loadMcpConfig({ MCP_SERVERS: "x.json" }, { logger, readFile: () => '{"mcpServers":{"Bad Name":{"command":"x"}}}' })).toEqual([]);
    expect(loadMcpConfig({ MCP_SERVERS: "missing.json" }, { logger, readFile: () => { throw new Error("ENOENT"); } })).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/not JSON/);
    expect(warnings[1]).toMatch(/not an MCP config/);
    expect(warnings[2]).toMatch(/could not be read/);
  });
});
