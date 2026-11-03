/**
 * Post-V3-011: how a company tool is named, cited, resolved and declared.
 */
import { describe, expect, it } from "vitest";
import {
  MCP_FUNCTION_NAME_MAX,
  MCP_RESULT_MAX_CHARS,
  McpConfigFileSchema,
  expandEnvReferences,
  isMcpCitation,
  mcpCitation,
  mcpFunctionName,
  mcpToolDescription,
  renderMcpResult,
  resolveMcpCitation,
  strictParameters,
} from "./mcp.js";

describe("a tool as a source", () => {
  it("is named `mcp:<server>/<tool>`, never a URL", () => {
    const citation = mcpCitation("crm", "lookup_customer");
    expect(citation.url).toBe("mcp:crm/lookup_customer");
    expect(citation.title).toBe("crm: lookup_customer");
    expect(isMcpCitation(citation.url)).toBe(true);
  });

  it("is told apart from every page a search can return, and from a file", () => {
    for (const url of ["https://example.com/mcp:crm", "file:customers.csv", "crm/lookup", ""]) {
      expect(isMcpCitation(url)).toBe(false);
    }
  });
});

describe("resolving a tool the model named", () => {
  const invoked = ["crm/lookup_customer", "wiki/search"];

  it("takes every spelling of a tool the call really ran", () => {
    for (const named of [
      "mcp:crm/lookup_customer",
      "mcp: crm/lookup_customer",
      "crm/lookup_customer",
      "crm__lookup_customer",
      "MCP:CRM/Lookup_Customer",
      " mcp: crm / lookup_customer ",
    ]) {
      expect(resolveMcpCitation(named, invoked)).toBe("crm/lookup_customer");
    }
  });

  it("drops a tool nothing ran, as an unopened page is dropped", () => {
    expect(resolveMcpCitation("crm/delete_customer", invoked)).toBeUndefined();
    expect(resolveMcpCitation("mcp:", invoked)).toBeUndefined();
    expect(resolveMcpCitation("crm", invoked)).toBeUndefined();
    expect(resolveMcpCitation("https://example.com/crm/lookup_customer", invoked)).toBeUndefined();
    expect(resolveMcpCitation("", invoked)).toBeUndefined();
  });
});

describe("a function name on the wire", () => {
  it("joins server and tool with a double underscore and keeps to the API's characters", () => {
    expect(mcpFunctionName("crm", "lookup_customer")).toBe("crm__lookup_customer");
    expect(mcpFunctionName("my crm", "look.up/customer")).toBe("my_crm__look_up_customer");
    expect(mcpFunctionName("crm", "x".repeat(100))).toHaveLength(MCP_FUNCTION_NAME_MAX);
    expect(mcpFunctionName("crm", "lookup")).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("the strict subset", () => {
  it("closes an object whose properties are all required", () => {
    expect(
      strictParameters({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { name: { type: "string", description: "who" }, limit: { type: "integer" } },
        required: ["name", "limit"],
      }),
    ).toEqual({
      type: "object",
      properties: { name: { type: "string", description: "who" }, limit: { type: "integer" } },
      required: ["name", "limit"],
      additionalProperties: false,
    });
  });

  it("reads an empty schema as a tool with no arguments", () => {
    const empty = { type: "object", properties: {}, required: [], additionalProperties: false };
    expect(strictParameters({})).toEqual(empty);
    expect(strictParameters({ type: "object" })).toEqual(empty);
    expect(strictParameters(true)).toEqual(empty);
  });

  it("refuses to make an optional property required", () => {
    expect(
      strictParameters({
        type: "object",
        properties: { name: { type: "string" }, limit: { type: "integer" } },
        required: ["name"],
      }),
    ).toBeNull();
  });

  it("refuses the keywords strict mode rejects, wherever they are", () => {
    expect(
      strictParameters({
        type: "object",
        properties: { name: { type: "string", minLength: 1 } },
        required: ["name"],
      }),
    ).toBeNull();
    expect(
      strictParameters({
        type: "object",
        properties: { items: { type: "array", items: { type: "string" }, maxItems: 5 } },
        required: ["items"],
      }),
    ).toBeNull();
    expect(
      strictParameters({ type: "object", properties: { a: { $ref: "#/$defs/x" } }, required: ["a"] }),
    ).toBeNull();
    expect(strictParameters({ type: "string" })).toBeNull();
  });

  it("recurses through arrays, nested objects and anyOf", () => {
    const out = strictParameters({
      type: "object",
      properties: {
        filters: {
          type: "array",
          items: { type: "object", properties: { field: { type: "string" } }, required: ["field"] },
        },
        mode: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["filters", "mode"],
    });
    expect(out).not.toBeNull();
    const filters = (out?.["properties"] as Record<string, Record<string, unknown>>)["filters"];
    expect((filters?.["items"] as Record<string, unknown>)["additionalProperties"]).toBe(false);
  });
});

describe("what the model is handed back", () => {
  it("joins the text blocks and says how to cite them", () => {
    const text = renderMcpResult("crm", "lookup_customer", {
      content: [
        { type: "text", text: "Harborview Clinic, Pro, renews 2027-03-01" },
        { type: "image", mimeType: "image/png", data: "AAAA" },
      ],
    });
    expect(text).toContain("Harborview Clinic");
    expect(text).toContain("[image omitted: image/png]");
    expect(text).not.toContain("AAAA");
    expect(text).toContain("Cite this as `mcp:crm/lookup_customer`");
  });

  it("falls back to structured content, and says when there is nothing", () => {
    expect(renderMcpResult("crm", "t", { content: [], structuredContent: { ok: 1 } })).toContain('"ok": 1');
    expect(renderMcpResult("crm", "t", { content: [] })).toContain("returned nothing");
  });

  it("reports an error in words, with the advice every tool gives", () => {
    const text = renderMcpResult("crm", "t", {
      content: [{ type: "text", text: "no such customer" }],
      isError: true,
    });
    expect(text).toMatch(/reported an error: no such customer/);
    expect(text).toMatch(/answer in words instead/i);
  });

  it("clips a long result and says so", () => {
    const text = renderMcpResult("wiki", "page", {
      content: [{ type: "text", text: "x".repeat(MCP_RESULT_MAX_CHARS * 2) }],
    });
    expect(text.length).toBeLessThan(MCP_RESULT_MAX_CHARS + 200);
    expect(text).toContain(`[truncated at ${MCP_RESULT_MAX_CHARS} characters]`);
  });
});

describe("the config file", () => {
  it("accepts the shape Claude Desktop writes, stdio and http", () => {
    const parsed = McpConfigFileSchema.safeParse({
      mcpServers: {
        crm: { command: "node", args: ["crm.js"], env: { CRM_TOKEN: "${CRM_TOKEN}" } },
        wiki: { url: "https://wiki.example.com/mcp", headers: { Authorization: "Bearer ${WIKI}" } },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a server name the function name could not carry, and an unknown key", () => {
    expect(McpConfigFileSchema.safeParse({ mcpServers: { "My CRM": { command: "x" } } }).success).toBe(false);
    expect(McpConfigFileSchema.safeParse({ mcpServers: { crm: { command: "x", token: "y" } } }).success).toBe(false);
    expect(McpConfigFileSchema.safeParse({ mcpServers: { crm: { url: "ftp://x" } } }).success).toBe(false);
  });

  it("expands ${NAME} from the environment and nothing else", () => {
    expect(expandEnvReferences("Bearer ${T}", { T: "abc" })).toBe("Bearer abc");
    expect(expandEnvReferences("Bearer ${MISSING}", {})).toBe("Bearer ");
    expect(expandEnvReferences("$T and ${T", { T: "abc" })).toBe("$T and ${T");
  });
});

describe("what the model is told a tool is for", () => {
  it("keeps the server's own description and adds the company-first rule and the citation", () => {
    const text = mcpToolDescription({
      server: "crm",
      tool: "lookup_customer",
      name: "crm__lookup_customer",
      description: "Finds a customer by name.",
      inputSchema: {},
    });
    expect(text).toMatch(/^Finds a customer by name\./);
    expect(text).toContain("`mcp:crm/lookup_customer`");
  });
});
