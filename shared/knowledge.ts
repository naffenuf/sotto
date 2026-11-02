/**
 * The group's own files, as the model sees them (PRD V3-009).
 *
 * Sotto's answers come from the web, which is the one thing a room full of
 * people cannot look up faster than it can. The knowledge folder is the other
 * half: a handful of the group's own `.md`, `.txt` and `.csv` files —
 * customers, prices, notes — that nothing on the web knows. There are no
 * embeddings and no index to build: the whole folder is a few kilobytes of
 * plain text, so it is read at session start and searched by matching words.
 *
 * Two shapes live here because both ends need them. The research runner
 * declares {@link SEARCH_KNOWLEDGE_TOOL} beside `web_search` (V2-013's tool
 * loop takes any number of function tools in one request), and a finding that
 * came out of a file is cited as `file: customers.csv` rather than as a URL —
 * which is also why {@link isKnowledgeCitation} exists: the card renders a
 * file source as text, since there is no page for a reader to open.
 */
import { z } from "zod";
import type { Citation } from "./cards.js";

/** The one folder Sotto reads, when there is one. Relative to the repo root. */
export const DEFAULT_KNOWLEDGE_DIR = "knowledge";

/** The extensions a knowledge file may have. Plain text, nothing to parse. */
export const KNOWLEDGE_EXTENSIONS = [".md", ".txt", ".csv"] as const;

/** The function tool's name, as the model sees it. */
export const SEARCH_KNOWLEDGE_TOOL = "search_knowledge";

/** Snippets one search hands back. Enough to answer from, short enough to read. */
export const KNOWLEDGE_MAX_SNIPPETS = 8;

/** Characters of one snippet. A line of a CSV or a sentence of a note. */
export const KNOWLEDGE_SNIPPET_MAX_CHARS = 400;

/** The prefix a file source carries where a web source carries a scheme. */
export const KNOWLEDGE_CITATION_PREFIX = "file:";

/**
 * One matching line of one file.
 *
 * `line` is 1-based, as an editor counts, and `text` is the matched line —
 * preceded by the header row when the file is a CSV, because a row of a
 * customer list means nothing without its columns.
 */
export interface KnowledgeSnippet {
  /** The file's name, as it is cited: `customers.csv`. */
  file: string;
  /** The 1-based line the match was on. */
  line: number;
  /** The matched text, clipped to {@link KNOWLEDGE_SNIPPET_MAX_CHARS}. */
  text: string;
}

/** The arguments of one {@link SEARCH_KNOWLEDGE_TOOL} call. */
export const SearchKnowledgeArgsSchema = z.object({
  query: z
    .string()
    .transform((query) => query.replace(/\s+/g, " ").trim())
    .refine((query) => query !== "", { message: "query must not be empty" }),
});
export type SearchKnowledgeArgs = z.infer<typeof SearchKnowledgeArgsSchema>;

/**
 * The tool's parameter schema, in the subset strict function calling accepts:
 * a closed object, every property required, no length keywords.
 *
 * Written by hand next to {@link SearchKnowledgeArgsSchema} for the reason
 * `showHtmlJsonSchema` is — `z.toJSONSchema` emits keywords strict mode
 * rejects — and `shared/knowledge.test.ts` keeps the two in step.
 */
export const searchKnowledgeJsonSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "The words to look for, as they would appear in the files: a customer name, a product, a column heading, a price. Two to five words works better than a sentence, and calling it twice with different words is cheap.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

/** What the model is told the tool is for. */
export function searchKnowledgeDescription(files: readonly string[]): string {
  return (
    "Searches the group's own files — the records they keep, which nothing on the web knows — " +
    "and returns the matching lines with their file names. Search here first for anything about " +
    "this group's customers, prices, dates or internal notes, and cite what you use as " +
    `\`${KNOWLEDGE_CITATION_PREFIX} <file name>\`. The files are: ${files.join(", ")}.`
  );
}

/** `file: customers.csv` — one file, as a source under a card. */
export function knowledgeCitation(file: string): Citation {
  return { url: `${KNOWLEDGE_CITATION_PREFIX}${file}`, title: `${KNOWLEDGE_CITATION_PREFIX} ${file}` };
}

/** Whether this source is one of the group's files rather than a page. */
export function isKnowledgeCitation(url: string): boolean {
  return url.trimStart().toLowerCase().startsWith(KNOWLEDGE_CITATION_PREFIX);
}

/**
 * The file a citation names, however the model spelled it, or `undefined`.
 *
 * The same tolerance a web citation gets (US-013 resolves a host to the page
 * the search returned from it): the model is asked for `file: customers.csv`
 * and may write `customers.csv`, `knowledge/customers.csv` or
 * `file:Customers.csv`. Only a file the search really returned resolves — a
 * name nothing produced is dropped, exactly as an unopened page is.
 */
export function resolveKnowledgeCitation(
  named: string,
  files: Iterable<string>,
): string | undefined {
  let name = named.trim();
  if (isKnowledgeCitation(name)) name = name.slice(name.indexOf(":") + 1).trim();
  // A page on the web is never one of their files, however its path ends:
  // this runs *before* the URL resolution, so `https://x.com/prices.csv` has
  // to be left for that rather than claimed here.
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name)) return undefined;
  name = name.replace(/^.*[/\\]/, "").toLowerCase();
  if (name === "") return undefined;
  for (const file of files) if (file.toLowerCase() === name) return file;
  return undefined;
}

/** What one search hands back to the model. */
export function renderKnowledgeResults(
  query: string,
  snippets: readonly KnowledgeSnippet[],
): string {
  if (snippets.length === 0) {
    return (
      `Nothing in the group's files matches "${query}". Try other words, or answer from the web instead.`
    );
  }
  const lines = snippets.map(
    (snippet) => `- ${snippet.file} (line ${snippet.line}): ${snippet.text}`,
  );
  return [
    `${snippets.length} matching line(s) in the group's own files for "${query}":`,
    ...lines,
    `Cite any of these as \`${KNOWLEDGE_CITATION_PREFIX} <file name>\`, e.g. ` +
      `\`${KNOWLEDGE_CITATION_PREFIX} ${snippets[0]?.file ?? "notes.md"}\`.`,
  ].join("\n");
}
