/**
 * Sotto as an MCP client (post-V3-011): company information through the
 * servers in `mcp.json`, beside the knowledge folder (V3-009).
 *
 * One of these is built per session by `SessionManager` (through `createMcp`,
 * which defaults to none so `npm test` dials nothing), connects to every
 * configured server at session start, lists each one's tools once, and is
 * closed when the session ends. What it hands the rest of the pipeline is a
 * list of {@link FunctionTool}s — the same seam `search_knowledge` and
 * `show_html` go through — so the answer agent, the research runner and the
 * verifier offer a CRM lookup to the model exactly as they offer a file
 * search, and `MuseClient`'s tool loop routes the call back here.
 *
 * Three rules carry the design:
 *
 *   - **A server that fails is a warning, never an error.** A stdio server
 *     that is not installed, an HTTP server that is down, a listing that takes
 *     too long: each is one line in the log and one entry in `session.json`,
 *     and the session goes on with whatever did connect. A meeting must not
 *     fail to start because a wiki is unreachable.
 *   - **A tool handler never throws.** A timeout, a server error, arguments
 *     the server rejects — the model is told in words and answers anyway,
 *     which is the rule every tool in Sotto follows (US-020).
 *   - **Nothing secret reaches a log line.** Headers and env values are
 *     expanded by `loadMcpConfig` and stay inside the transport; this module
 *     logs server names, tool names, counts and latencies, and every error
 *     message passes through a redactor built from the config's own values
 *     before it is written anywhere. `McpClient.test.ts` asserts it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_STDERR_LINES,
  mcpCitation,
  mcpFunctionName,
  mcpToolDescription,
  mcpToolKey,
  renderMcpResult,
  strictParameters,
  type McpCallRecord,
  type McpConnectedRecord,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolInfo,
} from "../../shared/mcp.js";
import type { Citation } from "../../shared/cards.js";
import { systemClock, type Clock } from "../clock.js";
import type { FunctionTool } from "../model/client.js";

type Logger = Pick<Console, "log" | "warn">;

/** The name and version Sotto introduces itself with to a server. */
export const MCP_CLIENT_INFO = { name: "sotto", version: "0.1.0" } as const;

export interface McpClientOptions {
  logger?: Logger;
  /** Real time, for timeouts and latencies. Never the session clock. */
  wallClock?: Clock;
  callTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Told about every connection attempt, once, with every server's outcome. */
  onConnected?: (record: McpConnectedRecord) => void;
  /** Told about every tool call, whatever became of it. */
  onCall?: (record: McpCallRecord) => void;
  /**
   * Seam for tests: the transport to a server, instead of spawning a process
   * or opening a connection. The SDK's `InMemoryTransport` is the fake.
   */
  createTransport?: (server: McpServerConfig) => Transport;
}

/** One connected server: its SDK client and the tools it listed. */
interface Connected {
  config: McpServerConfig;
  client: Client;
  tools: McpToolInfo[];
}

/** The way back from a function name to the tool it stands for. */
interface Routed {
  info: McpToolInfo;
  parameters: Record<string, unknown>;
  strict: boolean;
}

/** What one call came back with, for the handler to render. */
export interface McpCallOutcome {
  ok: boolean;
  /** What the model is told, rendered. */
  text: string;
  latencyMs: number;
  error?: string;
}

export class McpClient {
  private readonly servers: readonly McpServerConfig[];
  private readonly logger: Logger;
  private readonly wallClock: Clock;
  private readonly options: McpClientOptions;
  private readonly connected: Connected[] = [];
  /** Every tool by its function name, in listing order. */
  private readonly routed = new Map<string, Routed>();
  private readonly secrets: readonly string[];
  private connecting: Promise<McpConnectedRecord> | undefined;
  private record: McpConnectedRecord | undefined;
  private closed = false;
  /** Told about every call, beside {@link McpClientOptions.onCall}: the session's `timing.jsonl`. */
  private readonly callListeners: ((record: McpCallRecord) => void)[] = [];

  constructor(servers: readonly McpServerConfig[], options: McpClientOptions = {}) {
    this.servers = servers;
    this.options = options;
    this.logger = options.logger ?? console;
    this.wallClock = options.wallClock ?? systemClock;
    this.secrets = secretsOf(servers);
  }

  /** The names of the configured servers, connected or not. */
  configured(): readonly string[] {
    return this.servers.map((server) => server.name);
  }

  /**
   * Adds a listener for every call's record. The client is built by
   * `server/app.ts` before any session exists, so the session that wants the
   * records in its `timing.jsonl` attaches here rather than at construction.
   */
  watchCalls(listener: (record: McpCallRecord) => void): void {
    this.callListeners.push(listener);
  }

  /**
   * Connects to every server and lists its tools. Idempotent: the first call
   * starts it, every later one returns the same promise. Never rejects — a
   * server that failed is an entry with `ok: false`.
   */
  connect(): Promise<McpConnectedRecord> {
    return (this.connecting ??= this.connectAll());
  }

  /** Resolves once every connection attempt has finished, success or not. */
  async ready(): Promise<void> {
    await this.connect();
  }

  /** The outcome of {@link connect}, or `undefined` before it has finished. */
  status(): McpConnectedRecord | undefined {
    return this.record;
  }

  /** Every tool every connected server listed, in order. */
  tools(): readonly McpToolInfo[] {
    return [...this.routed.values()].map((one) => one.info);
  }

  /**
   * The tools as the model is offered them, one {@link FunctionTool} each.
   *
   * `invoked` is filled with the key (`crm/lookup_customer`) of every tool
   * that actually ran during the call being built, because only a tool that
   * ran may be cited — the rule `search_knowledge`'s `read` set enforces for
   * files (V3-009) and `searchedUrls` enforces for pages (US-013).
   * `label` names the caller in the log (`answer`, `research-packet`).
   */
  functionTools(invoked: Set<string>, label: string): FunctionTool[] {
    if (this.closed) return [];
    return [...this.routed.entries()].map(([name, { info, parameters, strict }]) => ({
      name,
      description: mcpToolDescription(info),
      parameters,
      strict,
      run: async (args: unknown): Promise<string> => {
        const outcome = await this.call(info.server, info.tool, args, label);
        if (outcome.ok) invoked.add(mcpToolKey(info.server, info.tool));
        return outcome.text;
      },
    }));
  }

  /** The citation a call to this tool earns. */
  citation(key: string): Citation | undefined {
    const slash = key.indexOf("/");
    if (slash <= 0) return undefined;
    return mcpCitation(key.slice(0, slash), key.slice(slash + 1));
  }

  /**
   * Calls one tool. Never throws: a timeout, a server that has gone away and
   * a result the server marked as an error all come back as words for the
   * model, with `ok: false` and the reason in `error`.
   */
  async call(server: string, tool: string, args: unknown, label = "mcp"): Promise<McpCallOutcome> {
    const startedAt = this.wallClock.now();
    const done = (outcome: Omit<McpCallOutcome, "latencyMs">): McpCallOutcome => {
      const latencyMs = Math.max(0, Math.round(this.wallClock.now() - startedAt));
      const result = { ...outcome, latencyMs };
      const record: McpCallRecord = {
        server,
        tool,
        ok: result.ok,
        latencyMs,
        chars: result.text.length,
        ...(result.error === undefined ? {} : { error: result.error }),
      };
      this.options.onCall?.(record);
      for (const listener of this.callListeners) listener(record);
      this.logger.log(
        `[mcp] ${label}: ${server}/${tool} ${result.ok ? "ok" : `failed (${result.error ?? "no detail"})`} in ${latencyMs} ms` +
          `${result.ok ? `, ${result.text.length} chars` : ""}`,
      );
      return result;
    };
    const connection = this.connected.find((one) => one.config.name === server);
    if (this.closed || connection === undefined) {
      return done({
        ok: false,
        text: `The ${server} server is not connected in this session. Answer in words instead.`,
        error: this.closed ? "closed" : "not connected",
      });
    }
    const timeoutMs = this.options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
    const controller = new AbortController();
    const cancelTimer = this.wallClock.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const arguments_ =
        typeof args === "object" && args !== null && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};
      const result = await connection.client.callTool(
        { name: tool, arguments: arguments_ },
        undefined,
        { signal: controller.signal, timeout: timeoutMs },
      );
      // The compatibility union: an old server answers `toolResult` instead
      // of `content`, which renders as nothing and is told to the model so.
      const shaped = result as { content?: unknown; structuredContent?: unknown; isError?: unknown };
      const text = renderMcpResult(server, tool, shaped);
      if (shaped.isError === true) return done({ ok: false, text, error: "tool error" });
      return done({ ok: true, text });
    } catch (error) {
      if (controller.signal.aborted) {
        return done({
          ok: false,
          text: `The ${server} tool ${tool} did not answer within ${Math.round(timeoutMs / 1000)} seconds. Answer in words instead.`,
          error: `timeout after ${timeoutMs} ms`,
        });
      }
      const detail = this.redact(message(error));
      return done({
        ok: false,
        text: `The ${server} tool ${tool} failed (${detail}). Answer in words instead.`,
        error: detail,
      });
    } finally {
      cancelTimer();
    }
  }

  /** Closes every connection. Idempotent; never rejects. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // A connection still being made is closed once it exists.
    if (this.connecting !== undefined) await this.connecting.catch(() => undefined);
    await Promise.all(
      this.connected.map(async (one) => {
        try {
          await one.client.close();
        } catch (error) {
          this.logger.warn(`[mcp] ${one.config.name} did not close cleanly: ${this.redact(message(error))}`);
        }
      }),
    );
    this.connected.length = 0;
    this.routed.clear();
  }

  private async connectAll(): Promise<McpConnectedRecord> {
    const statuses = await Promise.all(this.servers.map((server) => this.connectOne(server)));
    // Named after every server has answered, so the function names are the
    // same from one session to the next whatever order the servers came up in.
    for (const connection of this.connected) {
      for (const info of connection.tools) this.route(info);
    }
    const record: McpConnectedRecord = { servers: statuses };
    this.record = record;
    const up = statuses.filter((status) => status.ok);
    if (this.servers.length > 0) {
      this.logger.log(
        `[mcp] ${up.length}/${this.servers.length} server(s) connected, ${this.routed.size} tool(s)` +
          (up.length === 0 ? "" : `: ${up.map((status) => `${status.name} (${status.tools})`).join(", ")}`),
      );
    }
    this.options.onConnected?.(record);
    return record;
  }

  private async connectOne(server: McpServerConfig): Promise<McpServerStatus> {
    const startedAt = this.wallClock.now();
    const latency = (): number => Math.max(0, Math.round(this.wallClock.now() - startedAt));
    const stderr: string[] = [];
    const client = new Client(MCP_CLIENT_INFO);
    const timeoutMs = this.options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
    const controller = new AbortController();
    const cancelTimer = this.wallClock.setTimeout(() => controller.abort(), timeoutMs);
    let transport: Transport | undefined;
    try {
      transport = this.options.createTransport?.(server) ?? this.transport(server, stderr);
      await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
      const listed = await client.listTools(undefined, { signal: controller.signal, timeout: timeoutMs });
      if (this.closed) {
        await client.close().catch(() => undefined);
        return { name: server.name, transport: server.transport, ok: false, tools: 0, toolNames: [], latencyMs: latency(), error: "closed" };
      }
      const tools: McpToolInfo[] = listed.tools.map((tool) => ({
        server: server.name,
        tool: tool.name,
        name: mcpFunctionName(server.name, tool.name),
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      }));
      this.connected.push({ config: server, client, tools });
      return {
        name: server.name,
        transport: server.transport,
        ok: true,
        tools: tools.length,
        toolNames: tools.map((tool) => tool.tool),
        latencyMs: latency(),
      };
    } catch (error) {
      const why = controller.signal.aborted
        ? `no answer within ${timeoutMs} ms`
        : this.redact(message(error));
      const tail = stderr.length === 0 ? "" : ` — stderr: ${this.redact(stderr.join(" | "))}`;
      this.logger.warn(`[mcp] ${server.name} (${server.transport}) could not be connected: ${why}${tail}`);
      await client.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      return { name: server.name, transport: server.transport, ok: false, tools: 0, toolNames: [], latencyMs: latency(), error: why };
    } finally {
      cancelTimer();
    }
  }

  /** The real transport for one server. */
  private transport(server: McpServerConfig, stderr: string[]): Transport {
    if (server.transport === "http") {
      return new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers },
      });
    }
    const transport = new StdioClientTransport({
      command: server.command,
      args: [...server.args],
      // The server's own environment on top of a safe default — never the
      // whole of Sotto's, which holds every API key in `.env`.
      env: { ...defaultChildEnv(), ...server.env },
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      // Kept for the log line when the connection fails, otherwise discarded:
      // a server's stderr is its own, and a chatty one must not fill Sotto's.
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() === "") continue;
        stderr.push(line.slice(0, 200));
        if (stderr.length > MCP_STDERR_LINES) stderr.shift();
      }
    });
    return transport;
  }

  /** Gives one tool its function name, keeping two that collapse apart. */
  private route(info: McpToolInfo): void {
    let name = info.name;
    for (let suffix = 2; this.routed.has(name); suffix += 1) {
      const tag = `_${suffix}`;
      name = `${info.name.slice(0, info.name.length - tag.length)}${tag}`;
    }
    const strict = strictParameters(info.inputSchema);
    if (strict === null) {
      this.logger.log(`[mcp] ${info.server}/${info.tool} is declared non-strict (its schema is outside the strict subset)`);
    }
    this.routed.set(name, {
      info: { ...info, name },
      parameters: strict ?? info.inputSchema,
      strict: strict !== null,
    });
  }

  /** `text` with every configured secret blanked out. */
  private redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join("[redacted]");
    return out;
  }
}

/**
 * Every value in the config that could be a secret: header values, env values
 * and the URLs themselves (a token in a query string is still a token).
 */
function secretsOf(servers: readonly McpServerConfig[]): string[] {
  const values = new Set<string>();
  for (const server of servers) {
    if (server.transport === "http") {
      values.add(server.url);
      for (const value of Object.values(server.headers)) values.add(value);
    } else {
      for (const value of Object.values(server.env)) values.add(value);
    }
  }
  // Longest first, so a secret that contains another is blanked whole.
  return [...values].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
}

/** `PATH` and `HOME`, and nothing that looks like a key: what a child server gets. */
function defaultChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "SHELL", "TERM", "USER", "LANG", "TMPDIR", "NODE_PATH"]) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The session's MCP client from `.env`, or `null` when nothing is configured.
 *
 * Read here rather than inside `SessionManager` for the reason `glimmerFromEnv`
 * and `KnowledgeIndex.load` are: a test that builds its own session manager
 * reads nothing and connects to nothing. `server/app.ts` is the only caller.
 */
export function mcpFromEnv(
  load: () => readonly McpServerConfig[],
  options: McpClientOptions = {},
): McpClient | null {
  const servers = load();
  if (servers.length === 0) return null;
  return new McpClient(servers, options);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
