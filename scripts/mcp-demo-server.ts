/**
 * A tiny MCP server over stdio (post-V3-011): the fictional company's CRM.
 *
 * One tool, `lookup_customer`, over `fixtures/knowledge-demo/customers.csv`
 * — the same fictional accounts V3-009's knowledge folder reads as a file,
 * reached here the way a real CRM would be: through a server Sotto connects
 * to, lists, and calls. It exists so `npm run test:integration` can prove the
 * whole path (connect → list → the model calls the tool → the answer cites
 * `mcp:crm/lookup_customer`) without a real CRM, and so `docs/mcp.md` has a
 * stdio example that runs:
 *
 *     { "mcpServers": { "crm": { "command": "npx", "args": ["tsx", "scripts/mcp-demo-server.ts"] } } }
 *
 * `CUSTOMERS_CSV` names another file; the default is the demo's. Everything in
 * that file is fictional (see `fixtures/knowledge-demo/README.md`).
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_CSV = "fixtures/knowledge-demo/customers.csv";

interface Row {
  [column: string]: string;
}

/** The CSV as rows, the header as keys. Quoted fields with commas are kept whole. */
function readRows(path: string): Row[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = splitCsv(lines[0] ?? "");
  return lines.slice(1).map((line) => {
    const cells = splitCsv(line);
    return Object.fromEntries(header.map((column, index) => [column, cells[index] ?? ""]));
  });
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

function describe(row: Row): string {
  return Object.entries(row)
    .map(([column, value]) => `${column}: ${value}`)
    .join(", ");
}

async function main(): Promise<void> {
  const rows = readRows(process.env["CUSTOMERS_CSV"] ?? DEFAULT_CSV);
  const server = new McpServer({ name: "sotto-demo-crm", version: "0.1.0" });
  server.registerTool(
    "lookup_customer",
    {
      description:
        "Finds a customer account by name, or part of a name, and returns its plan, seats, " +
        "annual value, renewal date, owner and notes.",
      inputSchema: { name: z.string().describe("The customer's name, or part of it.") },
    },
    async ({ name }) => {
      const needle = name.trim().toLowerCase();
      const found = rows.filter((row) => (row["customer"] ?? "").toLowerCase().includes(needle));
      if (needle === "" || found.length === 0) {
        return {
          content: [{ type: "text", text: `No customer matches "${name}".` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: found.map(describe).join("\n") }] };
    },
  );
  server.registerTool(
    "list_customers",
    { description: "Lists every customer account by name, plan and renewal date." },
    async () => ({
      content: [
        {
          type: "text",
          text: rows
            .map((row) => `${row["customer"]}: ${row["plan"]}, renews ${row["renews_on"]}`)
            .join("\n"),
        },
      ],
    }),
  );
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`mcp-demo-server: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
