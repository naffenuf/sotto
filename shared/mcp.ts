/**
 * Company tools over MCP, as the model and the card see them (post-V3-011).
 *
 * The knowledge folder (V3-009) is the group's own files on this disk. MCP is
 * the same idea for everything that is *not* a file: a CRM, a ticket tracker,
 * a wiki, a document store — any system that speaks the Model Context
 * Protocol. Sotto is a client of each configured server, lists its tools once
 * per session and hands them to the model as function tools beside
 * `web_search`, `search_knowledge` and `show_html`, which V2-013 and US-020
 * already proved go in one request.
 *
 * Three shapes live here because both ends need them, exactly as
 * `shared/knowledge.ts` does for files:
 *
 *   - **A tool's name on the wire.** `<server>__<tool>`, sanitised to what the
 *     Responses API accepts ({@link mcpFunctionName}), and the way back from
 *     that name to the server and tool it stands for.
 *   - **A tool result as a source.** A finding that came out of a CRM lookup
 *     is cited as `mcp:crm/lookup_customer` rather than as a URL, and the card
 *     renders it as text because there is no page to open
 *     ({@link mcpCitation}, {@link isMcpCitation}, {@link resolveMcpCitation}).
 *   - **The server's schema, as strict mode wants it.** Strict function calling
 *     accepts a subset of JSON Schema; a server's `inputSchema` is whatever the
 *     server wrote. {@link strictParameters} says whether one can be declared
 *     strictly without changing what it means, and the tool is declared
 *     non-strict otherwise rather than dropped.
 */
import { z } from "zod";
import type { Citation } from "./cards.js";

/** The prefix a tool source carries where a web source carries a scheme. */
export const MCP_CITATION_PREFIX = "mcp:";

/** Joins a server name and a tool name into one function name. */
export const MCP_NAME_SEPARATOR = "__";

/** What the Responses API accepts as a function name: `^[a-zA-Z0-9_-]{1,64}$`. */
export const MCP_FUNCTION_NAME_MAX = 64;

/**
 * How long one tool call may take before the model is told it did not come
 * back. A CRM lookup is a database query; ten seconds is a server that is
 * stuck, and a model waiting longer than that is a room waiting with it.
 */
export const MCP_CALL_TIMEOUT_MS = 10_000;

/** How long connecting to one server may take, listing included. */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Characters of one tool result the model is handed. A customer record or a
 * wiki page, not a whole export: past this the result is clipped and the
 * model is told so.
 */
export const MCP_RESULT_MAX_CHARS = 8_000;

/** Lines of a server's stderr kept for the log line when it fails to connect. */
export const MCP_STDERR_LINES = 8;

/** A server name as it is written in the config: short, lowercase, no spaces. */
const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** A server reached by running a process and talking over its stdio. */
export const McpStdioServerSchema = z.strictObject({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  /** Extra environment for the process; `${NAME}` expands from Sotto's own. */
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().trim().min(1).optional(),
});

/** A server reached over Streamable HTTP. */
export const McpHttpServerSchema = z.strictObject({
  url: z
    .string()
    .trim()
    .refine((url) => /^https?:\/\//i.test(url), { message: "url must be http(s)" }),
  /** Request headers; `${NAME}` expands from Sotto's own environment. */
  headers: z.record(z.string(), z.string()).default({}),
});

export const McpServerSpecSchema = z.union([McpStdioServerSchema, McpHttpServerSchema]);

/**
 * The config file: `{ "mcpServers": { "<name>": <spec> } }`, the shape Claude
 * Desktop and the editors write, so an existing file can be pointed at.
 */
export const McpConfigFileSchema = z.object({
  mcpServers: z.record(
    z.string().refine((name) => SERVER_NAME_PATTERN.test(name), {
      message: "a server name is lowercase letters, digits, _ or -, at most 32 characters",
    }),
    McpServerSpecSchema,
  ),
});

export type McpStdioServer = z.infer<typeof McpStdioServerSchema>;
export type McpHttpServer = z.infer<typeof McpHttpServerSchema>;

/** One configured server, named. */
export type McpServerConfig = { name: string } & (
  | ({ transport: "stdio" } & McpStdioServer)
  | ({ transport: "http" } & McpHttpServer)
);

/** One tool a server offers, as the client lists it. */
export interface McpToolInfo {
  server: string;
  tool: string;
  /** Its name as the model sees it: {@link mcpFunctionName}. */
  name: string;
  description: string;
  /** The server's own `inputSchema`, as sent. */
  inputSchema: Record<string, unknown>;
}

/** What `session.json` and `timing.jsonl` record about one server (post-V3-011). */
export interface McpServerStatus {
  name: string;
  transport: "stdio" | "http";
  ok: boolean;
  /** Tools listed; 0 when the connection failed. */
  tools: number;
  /** Tool names, for the record — never arguments, never results. */
  toolNames: string[];
  latencyMs: number;
  error?: string;
}

/** The `mcp_connected` line. */
export interface McpConnectedRecord {
  servers: McpServerStatus[];
}

/** The `mcp_call` line: one tool call, whatever became of it. */
export interface McpCallRecord {
  server: string;
  tool: string;
  ok: boolean;
  latencyMs: number;
  /** Characters of result handed to the model, after clipping. */
  chars: number;
  error?: string;
}

/** `crm/lookup_customer`: the key a tool is tracked under once it has been called. */
export function mcpToolKey(server: string, tool: string): string {
  return `${server}/${tool}`;
}

/**
 * `crm__lookup_customer`: a server and tool as one function name.
 *
 * Anything outside `[A-Za-z0-9_-]` becomes `_`, and the whole is cut to the
 * API's 64 characters. A caller that has two tools collapse to one name has
 * to tell them apart itself ({@link McpClient} appends a counter).
 */
export function mcpFunctionName(server: string, tool: string): string {
  const clean = (part: string): string => part.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const name = `${clean(server) || "server"}${MCP_NAME_SEPARATOR}${clean(tool) || "tool"}`;
  return name.slice(0, MCP_FUNCTION_NAME_MAX);
}

/** `mcp:crm/lookup_customer` — one tool, as a source under a card. */
export function mcpCitation(server: string, tool: string): Citation {
  return {
    url: `${MCP_CITATION_PREFIX}${mcpToolKey(server, tool)}`,
    title: `${server}: ${tool}`,
  };
}

/** Whether this source is a company tool rather than a page. */
export function isMcpCitation(url: string): boolean {
  return url.trimStart().toLowerCase().startsWith(MCP_CITATION_PREFIX);
}

/**
 * The tool a citation names, however the model spelled it, or `undefined`.
 *
 * The same tolerance a file citation gets (V3-009): the model is asked for
 * `mcp:crm/lookup_customer` and may write `crm/lookup_customer`,
 * `crm__lookup_customer` or `mcp: CRM / lookup_customer`. Only a tool this
 * call really invoked resolves — a name nothing ran is dropped, exactly as an
 * unopened page is. Returns the key as it was invoked (`crm/lookup_customer`).
 */
export function resolveMcpCitation(named: string, invoked: Iterable<string>): string | undefined {
  let name = named.trim();
  if (isMcpCitation(name)) name = name.slice(name.indexOf(":") + 1).trim();
  // A page on the web is never a tool: this runs before the URL resolution.
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name)) return undefined;
  const key = name.replace(/\s+/g, "").replace(MCP_NAME_SEPARATOR, "/").toLowerCase();
  if (key === "" || !key.includes("/")) return undefined;
  for (const one of invoked) if (one.toLowerCase() === key) return one;
  return undefined;
}

/** The `${NAME}` references in a config value, expanded from `env`. */
export function expandEnvReferences(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
}

/**
 * The keywords strict function calling rejects. Anything in this list
 * anywhere in a schema makes the tool non-strict, because strict mode would
 * refuse the request outright (measured for structured output: `CLAUDE.md`
 * on `boardOpsJsonSchema`).
 */
const NON_STRICT_KEYWORDS = new Set([
  "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties",
  "maxProperties", "oneOf", "not", "if", "then", "else", "dependentRequired",
  "dependentSchemas", "patternProperties", "default", "$ref", "$defs", "definitions",
  "allOf", "contains", "minContains", "maxContains", "propertyNames", "unevaluatedProperties",
  "prefixItems", "examples",
]);

/**
 * A server's `inputSchema` as strict mode wants it, or `null` when it cannot
 * be declared strictly without changing what it means.
 *
 * Strict mode wants every object closed, every property required and none of
 * the length or range keywords. A schema already in that shape is copied with
 * `additionalProperties: false` on every object (which strict mode needs
 * spelled out). One with an optional property is **not** made required — the
 * server would then be sent arguments it never asked for — and one with a
 * rejected keyword is left as the server wrote it; both come back `null`, and
 * the caller declares the tool non-strict. An empty schema (`{}`,
 * `{ type: "object" }`) is the common case for a tool with no arguments and
 * is strict as `{ type: "object", properties: {}, required: [] }`.
 */
export function strictParameters(schema: unknown): Record<string, unknown> | null {
  const out = strictNode(schema, true);
  return out === null ? null : out;
}

function strictNode(node: unknown, root: boolean): Record<string, unknown> | null {
  if (node === true) return root ? emptyObjectSchema() : null;
  if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
  const schema = node as Record<string, unknown>;
  for (const key of Object.keys(schema)) if (NON_STRICT_KEYWORDS.has(key)) return null;
  const type = schema["type"];
  const properties = schema["properties"];
  const isObject = type === "object" || (type === undefined && properties !== undefined);
  if (root && !isObject && Object.keys(schema).filter((key) => key !== "$schema").length === 0) {
    return emptyObjectSchema();
  }
  if (root && !isObject) return null;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") continue;
    copy[key] = value;
  }
  if (isObject) {
    const props = (properties ?? {}) as Record<string, unknown>;
    if (typeof props !== "object" || props === null || Array.isArray(props)) return null;
    const names = Object.keys(props);
    const required = schema["required"];
    const requiredNames = required === undefined ? [] : required;
    if (!Array.isArray(requiredNames)) return null;
    // Every property must already be required: making one required would
    // send the server an argument it marked optional.
    for (const name of names) if (!requiredNames.includes(name)) return null;
    for (const name of requiredNames) if (!names.includes(name)) return null;
    const additional = schema["additionalProperties"];
    if (additional !== undefined && additional !== false) return null;
    const strictProps: Record<string, unknown> = {};
    for (const name of names) {
      const child = strictNode(props[name], false);
      if (child === null) return null;
      strictProps[name] = child;
    }
    copy["type"] = "object";
    copy["properties"] = strictProps;
    copy["required"] = names;
    copy["additionalProperties"] = false;
    return copy;
  }
  if (type === "array") {
    const items = schema["items"];
    if (items === undefined) return null;
    const child = strictNode(items, false);
    if (child === null) return null;
    copy["items"] = child;
    return copy;
  }
  const anyOf = schema["anyOf"];
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf)) return null;
    const branches: Record<string, unknown>[] = [];
    for (const branch of anyOf) {
      const child = strictNode(branch, false);
      if (child === null) return null;
      branches.push(child);
    }
    copy["anyOf"] = branches;
    return copy;
  }
  if (type === undefined) return null;
  // A scalar, or a union of scalars written as `type: ["string", "null"]`.
  return copy;
}

function emptyObjectSchema(): Record<string, unknown> {
  return { type: "object", properties: {}, required: [], additionalProperties: false };
}

/** What the model is told a server's tools are, in one description line each. */
export function mcpToolDescription(info: McpToolInfo): string {
  const own = info.description.replace(/\s+/g, " ").trim();
  return (
    `${own === "" ? `The ${info.server} tool ${info.tool}.` : own} ` +
    `(Company tool on the "${info.server}" server. Prefer it over the web for anything about ` +
    `this group's own organisation — its customers, tickets, documents, people — and cite what ` +
    `you use as \`${MCP_CITATION_PREFIX}${mcpToolKey(info.server, info.tool)}\`.)`
  );
}

/** One content block of a tool result, as the protocol sends it. */
interface ResultBlock {
  type?: unknown;
  text?: unknown;
  mimeType?: unknown;
  resource?: { uri?: unknown; text?: unknown; mimeType?: unknown } | unknown;
}

/**
 * What one tool result hands back to the model.
 *
 * Text blocks are joined; an image or a binary resource is named rather than
 * sent, because a model writing an answer cannot read a PNG and the bytes
 * would only eat the budget. `structuredContent` stands in when there is no
 * text at all. Clipped at {@link MCP_RESULT_MAX_CHARS} and the model is told
 * so, and a result the server marked as an error is reported in words — the
 * "… Answer in words instead." rule every tool handler in Sotto follows.
 */
export function renderMcpResult(
  server: string,
  tool: string,
  result: { content?: unknown; structuredContent?: unknown; isError?: unknown },
): string {
  const parts: string[] = [];
  const blocks = Array.isArray(result.content) ? (result.content as ResultBlock[]) : [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image" || block.type === "audio") {
      parts.push(`[${String(block.type)} omitted${typeof block.mimeType === "string" ? `: ${block.mimeType}` : ""}]`);
    } else if (block.type === "resource" && typeof block.resource === "object" && block.resource !== null) {
      const resource = block.resource as { uri?: unknown; text?: unknown; mimeType?: unknown };
      if (typeof resource.text === "string") parts.push(resource.text);
      else parts.push(`[resource omitted${typeof resource.uri === "string" ? `: ${resource.uri}` : ""}]`);
    } else if (block.type === "resource_link" && typeof (block as { uri?: unknown }).uri === "string") {
      parts.push(`[resource: ${String((block as { uri?: unknown }).uri)}]`);
    }
  }
  let text = parts.join("\n").trim();
  if (text === "" && result.structuredContent !== undefined) {
    text = JSON.stringify(result.structuredContent, null, 1);
  }
  const key = `${MCP_CITATION_PREFIX}${mcpToolKey(server, tool)}`;
  if (result.isError === true) {
    return (
      `The ${server} tool ${tool} reported an error` +
      `${text === "" ? "" : `: ${clip(text, 600).replace(/[.!?]+$/, "")}`}. ` +
      "Try it with different arguments if that would help, or answer in words instead."
    );
  }
  if (text === "") {
    return `The ${server} tool ${tool} returned nothing for those arguments. Try different arguments, or answer in words instead.`;
  }
  const clipped = text.length > MCP_RESULT_MAX_CHARS;
  return (
    `Result from the ${server} tool ${tool}:\n${clip(text, MCP_RESULT_MAX_CHARS)}` +
    `${clipped ? `\n[truncated at ${MCP_RESULT_MAX_CHARS} characters]` : ""}` +
    `\nCite this as \`${key}\`.`
  );
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
