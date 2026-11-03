/**
 * The MCP client against a fake server (post-V3-011).
 *
 * The fake is the SDK's own `McpServer` on an `InMemoryTransport`, so what is
 * under test is the real protocol — initialize, `tools/list`, `tools/call` —
 * and only the wire is replaced. Nothing here spawns a process or opens a
 * socket, which is what keeps `npm test` offline.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpCallRecord, McpConnectedRecord, McpServerConfig } from "../../shared/mcp.js";
import { McpClient, mcpFromEnv } from "./McpClient.js";

const quiet = { log: () => {}, warn: () => {} };

/** A CRM with one lookup, a wiki with a loose schema, and a tool that hangs. */
function fakeServer(name: string, options: { hang?: boolean } = {}): McpServer {
  const server = new McpServer({ name, version: "0.0.1" });
  server.registerTool(
    "lookup_customer",
    {
      description: "Finds a customer by name.",
      inputSchema: { name: z.string().describe("The customer's name, or part of it.") },
    },
    async ({ name: who }) => {
      if (options.hang === true) return new Promise(() => {});
      if (who === "nobody") return { content: [{ type: "text", text: "no such customer" }], isError: true };
      return {
        content: [{ type: "text", text: `${who}: Pro, 45 seats, renews 2027-03-01, owner Priya` }],
      };
    },
  );
  server.registerTool(
    "search",
    {
      description: "Searches the wiki.",
      // `limit` is optional: outside the strict subset, so declared non-strict.
      inputSchema: { query: z.string(), limit: z.number().optional() },
    },
    async ({ query }) => ({ content: [{ type: "text", text: `page about ${query}` }] }),
  );
  return server;
}

function stdio(name: string, env: Record<string, string> = {}): McpServerConfig {
  return { name, transport: "stdio", command: "node", args: [`${name}.js`], env };
}

function http(name: string, headers: Record<string, string> = {}): McpServerConfig {
  return { name, transport: "http", url: `https://${name}.example.com/mcp?key=url-secret-${name}`, headers };
}

interface Harness {
  client: McpClient;
  log: string[];
  connected: McpConnectedRecord[];
  calls: McpCallRecord[];
}

/** A client whose transports go to fake servers, or fail, by server name. */
function harness(
  servers: McpServerConfig[],
  behaviour: Record<string, "ok" | "hang" | "down" | "unreachable">,
  options: { callTimeoutMs?: number; connectTimeoutMs?: number } = {},
): Harness {
  const log: string[] = [];
  const connected: McpConnectedRecord[] = [];
  const calls: McpCallRecord[] = [];
  const client = new McpClient(servers, {
    logger: { log: (line: unknown) => log.push(String(line)), warn: (line: unknown) => log.push(String(line)) },
    onConnected: (record) => connected.push(record),
    onCall: (record) => calls.push(record),
    ...options,
    createTransport: (server): Transport => {
      const kind = behaviour[server.name] ?? "ok";
      if (kind === "unreachable") throw new Error(`connect ECONNREFUSED ${server.transport === "http" ? server.url : server.command}`);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      if (kind === "down") {
        // A transport that opens and never answers: the connect times out.
        return clientSide;
      }
      void fakeServer(server.name, { hang: kind === "hang" }).connect(serverSide);
      return clientSide;
    },
  });
  return { client, log, connected, calls };
}

describe("McpClient", () => {
  it("lists every server's tools as function tools named <server>__<tool>", async () => {
    const { client, connected } = harness([stdio("crm"), http("wiki")], {});
    const record = await client.connect();
    expect(record.servers.map((server) => [server.name, server.ok, server.tools])).toEqual([
      ["crm", true, 2],
      ["wiki", true, 2],
    ]);
    expect(connected).toEqual([record]);
    const invoked = new Set<string>();
    const tools = client.functionTools(invoked, "test");
    expect(tools.map((tool) => tool.name)).toEqual([
      "crm__lookup_customer",
      "crm__search",
      "wiki__lookup_customer",
      "wiki__search",
    ]);
    expect(tools[0]?.description).toMatch(/^Finds a customer by name\./);
    expect(tools[0]?.description).toContain("`mcp:crm/lookup_customer`");
    // The server's schema, closed for strict mode, with its description kept.
    expect(tools[0]?.strict).toBe(true);
    expect(tools[0]?.parameters).toEqual({
      type: "object",
      properties: { name: { type: "string", description: "The customer's name, or part of it." } },
      required: ["name"],
      additionalProperties: false,
    });
    // An optional argument is outside the strict subset: declared as written.
    expect(tools[1]?.strict).toBe(false);
    expect((tools[1]?.parameters as { required?: string[] }).required).toEqual(["query"]);
    await client.close();
  });

  it("routes a call to the right server and records only a tool that ran as citable", async () => {
    const { client, calls } = harness([stdio("crm")], {});
    await client.connect();
    const invoked = new Set<string>();
    const tool = client.functionTools(invoked, "answer").find((one) => one.name === "crm__lookup_customer");
    const text = await tool!.run({ name: "Harborview Clinic" });
    expect(text).toContain("Harborview Clinic: Pro, 45 seats, renews 2027-03-01");
    expect(text).toContain("Cite this as `mcp:crm/lookup_customer`");
    expect([...invoked]).toEqual(["crm/lookup_customer"]);
    expect(client.citation("crm/lookup_customer")).toEqual({ url: "mcp:crm/lookup_customer", title: "crm: lookup_customer" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ server: "crm", tool: "lookup_customer", ok: true });
    expect(calls[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    await client.close();
  });

  it("tells the model in words about a result the server marked as an error", async () => {
    const { client, calls } = harness([stdio("crm")], {});
    await client.connect();
    const invoked = new Set<string>();
    const tool = client.functionTools(invoked, "answer")[0]!;
    const text = await tool.run({ name: "nobody" });
    expect(text).toMatch(/reported an error: no such customer/);
    expect(text).toMatch(/answer in words instead/i);
    expect(invoked.size).toBe(0);
    expect(calls[0]).toMatchObject({ ok: false, error: "tool error" });
    await client.close();
  });

  it("ignores a server that fails to connect and keeps the rest", async () => {
    const { client, log } = harness(
      [stdio("crm"), http("wiki", { Authorization: "Bearer wiki-header-secret" })],
      { wiki: "unreachable" },
    );
    const record = await client.connect();
    expect(record.servers.map((server) => [server.name, server.ok])).toEqual([["crm", true], ["wiki", false]]);
    expect(record.servers[1]?.error).toMatch(/ECONNREFUSED/);
    expect(client.functionTools(new Set(), "x").map((tool) => tool.name)).toEqual(["crm__lookup_customer", "crm__search"]);
    expect(log.some((line) => /wiki \(http\) could not be connected/.test(line))).toBe(true);
    await client.close();
  });

  it("gives up on a server that never answers the handshake, within the connect timeout", async () => {
    const { client } = harness([stdio("crm")], { crm: "down" }, { connectTimeoutMs: 50 });
    const record = await client.connect();
    expect(record.servers[0]).toMatchObject({ name: "crm", ok: false, tools: 0 });
    expect(record.servers[0]?.error).toMatch(/no answer within 50 ms/);
    expect(client.tools()).toEqual([]);
    await client.close();
  });

  it("answers a call that times out in words, without throwing", async () => {
    const { client, calls } = harness([stdio("crm")], { crm: "hang" }, { callTimeoutMs: 50 });
    await client.connect();
    const invoked = new Set<string>();
    const tool = client.functionTools(invoked, "answer")[0]!;
    const text = await tool.run({ name: "Harborview" });
    expect(text).toMatch(/did not answer within 0 seconds|did not answer within \d+ seconds/);
    expect(text).toMatch(/Answer in words instead/);
    expect(invoked.size).toBe(0);
    expect(calls[0]).toMatchObject({ ok: false, error: "timeout after 50 ms" });
    await client.close();
  });

  it("answers in words once closed, and after a call to a server that never connected", async () => {
    const { client } = harness([stdio("crm")], {});
    await client.connect();
    const before = await client.call("wiki", "search", { query: "x" });
    expect(before.ok).toBe(false);
    expect(before.text).toMatch(/not connected.*Answer in words instead/);
    await client.close();
    expect(client.functionTools(new Set(), "x")).toEqual([]);
    const after = await client.call("crm", "lookup_customer", { name: "x" });
    expect(after).toMatchObject({ ok: false, error: "closed" });
  });

  it("never puts a header, an env value or a URL in a log line or a record", async () => {
    const secrets = ["crm-env-secret", "Bearer wiki-header-secret", "url-secret-wiki"];
    const { client, log, connected } = harness(
      [stdio("crm", { CRM_TOKEN: "crm-env-secret" }), http("wiki", { Authorization: "Bearer wiki-header-secret" })],
      { crm: "unreachable", wiki: "unreachable" },
    );
    await client.connect();
    // The failure messages name the command and the URL — which is where a
    // token in a query string would otherwise leak.
    expect(log.length).toBeGreaterThanOrEqual(2);
    const everything = JSON.stringify({ log, connected, status: client.status() });
    for (const secret of secrets) expect(everything).not.toContain(secret);
    expect(everything).toContain("[redacted]");
    await client.close();
  });

  it("keeps two tools whose names collapse to one apart", async () => {
    const client = new McpClient([stdio("crm")], {
      logger: quiet,
      createTransport: (): Transport => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const server = new McpServer({ name: "crm", version: "0" });
        server.registerTool("look up", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "a" }] }));
        server.registerTool("look-up", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "b" }] }));
        void server.connect(serverSide);
        return clientSide;
      },
    });
    await client.connect();
    const tools = client.functionTools(new Set(), "x");
    expect(tools.map((tool) => tool.name)).toEqual(["crm__look_up", "crm__look-up"]);
    expect(await tools[0]!.run({})).toContain("a");
    expect(await tools[1]!.run({})).toContain("b");
    await client.close();
  });
});

describe("mcpFromEnv", () => {
  it("is null with nothing configured, so a session costs nothing", () => {
    expect(mcpFromEnv(() => [])).toBeNull();
  });

  it("builds a client over whatever is configured, without connecting yet", () => {
    const client = mcpFromEnv(() => [stdio("crm")], { logger: quiet });
    expect(client?.configured()).toEqual(["crm"]);
    expect(client?.status()).toBeUndefined();
  });
});
