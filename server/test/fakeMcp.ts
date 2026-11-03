/**
 * A company MCP server for the unit tests (post-V3-011): the SDK's own
 * `McpServer` on an in-memory transport, so nothing is spawned and nothing is
 * dialled. One `crm` with a `lookup_customer` tool over two fictional
 * accounts, the shape `scripts/mcp-demo-server.ts` has over the real file.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { McpServerConfig } from "../../shared/mcp.js";
import { McpClient, type McpClientOptions } from "../mcp/McpClient.js";

const quiet = { log: () => {}, warn: () => {} };

/** The config a fake `crm` server is built from: a command nothing runs. */
export const FAKE_CRM: McpServerConfig = {
  name: "crm",
  transport: "stdio",
  command: "node",
  args: ["fake-crm.js"],
  env: {},
};

/** One in-memory `crm` server, connected to the returned client transport. */
export function fakeCrmTransport(calls: Record<string, unknown>[] = []): Transport {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "crm", version: "0.0.1" });
  server.registerTool(
    "lookup_customer",
    {
      description: "Finds a customer account by name.",
      inputSchema: { name: z.string().describe("The customer's name, or part of it.") },
    },
    async ({ name }) => {
      calls.push({ name });
      const rows = [
        "Harborview Clinic: plan Pro, 45 seats, renews 2027-03-01, owner Priya",
        "Oakhurst Dental: plan Starter, 6 seats, renews 2027-01-20, owner Dan",
      ].filter((row) => row.toLowerCase().includes(name.toLowerCase()));
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No customer matches "${name}".` }], isError: true };
      }
      return { content: [{ type: "text", text: rows.join("\n") }] };
    },
  );
  void server.connect(serverSide);
  return clientSide;
}

/**
 * A client over the fake `crm`, not yet connected: the pipeline connects it
 * at session start, exactly as it does the real one.
 */
export function fakeMcpClient(
  calls: Record<string, unknown>[] = [],
  options: McpClientOptions = {},
): McpClient {
  return new McpClient([FAKE_CRM], {
    logger: quiet,
    createTransport: () => fakeCrmTransport(calls),
    ...options,
  });
}
