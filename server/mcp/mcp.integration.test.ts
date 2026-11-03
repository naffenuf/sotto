/**
 * The MCP client end to end (post-V3-011): a real stdio server, the real
 * model, and a typed question through the real route.
 *
 * `scripts/mcp-demo-server.ts` is the fictional company's CRM — one
 * `lookup_customer` tool over `fixtures/knowledge-demo/customers.csv` — run
 * as a child process over stdio, exactly as a real server would be. The
 * session is an `events` replay of a capture with no words in it, so the only
 * model call is the answer's; the question is typed through `POST /api/ask`
 * (US-019), which is answered against the most recent session, and the proof
 * is a citation of `mcp:crm/lookup_customer` on the finished card — a renewal
 * date nothing on the web knows.
 *
 * What is really under test is `answer.md`'s paragraph about company tools:
 * the function tool is on the table either way, and whether the model reaches
 * for it before the web, and names it as a source, is the prompt.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StageCard } from "../../shared/cards.js";
import { isMcpCitation } from "../../shared/mcp.js";
import { buildApp } from "../app.js";
import { EventReplaySource } from "../asr/EventReplaySource.js";
import { EventBus } from "../events/bus.js";
import { SessionManager } from "../session/SessionManager.js";
import { SESSION_FILES, SessionStore } from "../session/SessionStore.js";
import { McpClient } from "./McpClient.js";

// `globalSetup` runs in the main process; a test file runs in a worker.
loadDotenv({ quiet: true });

const apiKey = (process.env["MODEL_API_KEY"] ?? "").trim();
const describeSpark = apiKey === "" ? describe.skip : describe;

const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const loud = {
  log: (line: unknown) => process.stderr.write(`${String(line)}\n`),
  warn: (line: unknown) => process.stderr.write(`${String(line)}\n`),
  error: (line: unknown) => process.stderr.write(`${String(line)}\n`),
};

/** A capture with a handshake and the closing frame, and not one word. */
const EMPTY_CAPTURE = [
  JSON.stringify({ atMs: 0, session: 0, frame: { sessionId: "test/empty" } }),
  JSON.stringify({ atMs: 100, session: 0, frame: { type: "transcript", transcript: "", final: true, audioProcessedMs: 80 } }),
].join("\n");

describeSpark("a typed question answered from a stdio MCP server", () => {
  let root: string;
  let app: FastifyInstance;
  let bus: EventBus;
  let client: McpClient;
  const cards: StageCard[] = [];
  let timing: Record<string, unknown>[] = [];
  let sessionDir = "";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-mcp-"));
    const capture = join(root, "empty.jsonl");
    writeFileSync(capture, `${EMPTY_CAPTURE}\n`);
    bus = new EventBus(quiet);
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
    });
    client = new McpClient(
      [
        {
          name: "crm",
          transport: "stdio",
          command: "node_modules/.bin/tsx",
          args: ["scripts/mcp-demo-server.ts"],
          env: {},
        },
      ],
      { logger: loud },
    );
    const sessions = new SessionManager({
      bus,
      apiKey,
      logger: loud,
      replaySpeed: "max",
      createStore: (info) => {
        const store = SessionStore.create(info, { root, logger: quiet });
        sessionDir = store.dir;
        return store;
      },
      createReplaySource: (_fixture, options) => EventReplaySource.forPath(capture, options),
      createMcp: () => client,
    });
    app = await buildApp({ bus, sessions, apiKey });
    await app.ready();

    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "empty" } },
    });
    expect(started.statusCode, started.body).toBe(200);
    await ended;

    const finished = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "card" && event.card.variant === "answer" && (event.card.state === "ready" || event.card.state === "error")) {
          off();
          resolve();
        }
      });
    });
    const asked = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: { question: "When does the Harborview Clinic contract renew, and who owns the account?" },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    await finished;
    const { readFileSync, existsSync } = await import("node:fs");
    const path = join(sessionDir, SESSION_FILES.timing);
    timing = existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  }, 5 * 60_000);

  afterAll(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("connected the server and listed its tools, before any question", () => {
    expect(client.status()?.servers[0]).toMatchObject({ name: "crm", ok: true, toolNames: ["lookup_customer", "list_customers"] });
    const connected = timing.filter((event) => event.stage === "mcp_connected");
    expect(connected).toHaveLength(1);
  });

  it("called the tool, and the call is in timing.jsonl", () => {
    const calls = timing.filter((event) => event.stage === "mcp_call");
    expect(calls.length, JSON.stringify(timing.map((event) => event.stage))).toBeGreaterThan(0);
    expect(calls[0]).toMatchObject({ server: "crm", ok: true });
    expect(typeof calls[0]?.latencyMs).toBe("number");
  });

  it("cites the tool on the finished card, and has the date from the CRM", () => {
    const done = cards.filter((card) => card.variant === "answer" && card.state === "ready").at(-1);
    expect(done, JSON.stringify(cards.at(-1))).toBeDefined();
    const sources = (done?.citations ?? []).map((citation) => citation.url);
    expect(sources.filter(isMcpCitation), JSON.stringify(done)).toContain("mcp:crm/lookup_customer");
    const text = `${done?.headline ?? ""} ${done?.detailMd ?? ""} ${done?.spokenText ?? ""}`;
    expect(text).toMatch(/2027|twenty twenty[- ]seven/i);
    expect(text).toMatch(/Priya/);
  });
});
