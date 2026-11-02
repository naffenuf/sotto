/**
 * The knowledge folder, read once at session start (PRD V3-009).
 *
 * A few of the group's own files, searched by matching words. There is no
 * index to build and no embedding to compute: the folder is a handful of
 * notes, a price sheet and a customer list, so the whole of it is held in
 * memory and a search is a scan. Plain-text search is what the PRD asks for,
 * and for a few kilobytes it is also the right answer — a group looking for
 * "Harborview renewal" wants the line with those words on it.
 *
 * Two things the scan does that a naive `includes` would not:
 *
 *   - **A CSV row carries its header.** `Harborview Clinic,Pro,2027-03-01`
 *     tells a model nothing; `customer,plan,renews` in front of it tells it
 *     everything. So the first line of a `.csv` is prepended to every match
 *     from that file.
 *   - **Only words that mean something count.** The query is reduced to its
 *     content words before matching, so "when does the Harborview contract
 *     renew?" is a search for *harborview*, *contract* and *renew* rather
 *     than for *when*, *does* and *the* — which every line of every file has.
 *
 * Nothing here is cached across sessions: a group that edits a note between
 * two conversations means it for the second one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
  KNOWLEDGE_EXTENSIONS,
  KNOWLEDGE_MAX_SNIPPETS,
  KNOWLEDGE_SNIPPET_MAX_CHARS,
  type KnowledgeSnippet,
} from "../../shared/knowledge.js";

type Logger = Pick<Console, "log" | "warn">;

/** Bytes of one file that are read. A note, not a corpus. */
export const KNOWLEDGE_FILE_MAX_BYTES = 512 * 1024;

/** Files one folder may hold. Past this, something else is going on in there. */
export const KNOWLEDGE_MAX_FILES = 64;

/**
 * Words a query is stripped of before matching, because they appear on every
 * line of every file and would make every line a match.
 *
 * The question words are in here too: a search is for the thing asked about,
 * never for the asking (the same reason V2-015's briefing strips its own
 * `ASKING_WORDS` before matching a question to a packet).
 */
export const KNOWLEDGE_STOP_WORDS = new Set([
  "a", "about", "all", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can",
  "did", "do", "does", "for", "from", "get", "got", "had", "has", "have", "how", "i", "if", "in",
  "into", "is", "it", "its", "just", "many", "me", "much", "my", "of", "on", "one", "or", "our",
  "out", "so", "some", "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "to", "up", "us", "was", "we", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "would", "you", "your",
]);

/** One file, as it was read. */
interface KnowledgeFile {
  /** Its name, as it is cited: `customers.csv`. */
  name: string;
  /** Its lines, in order. */
  lines: string[];
  /** The header row, for a `.csv`; empty otherwise. */
  header: string;
}

export class KnowledgeIndex {
  private readonly loaded: readonly KnowledgeFile[];
  /** The folder the files came from, for the log and for the report. */
  readonly dir: string;

  private constructor(dir: string, files: readonly KnowledgeFile[]) {
    this.dir = dir;
    this.loaded = files;
  }

  /**
   * Reads every readable `.md`, `.txt` and `.csv` in `dir`, or returns `null`
   * when the folder is missing or holds none.
   *
   * `null` rather than an empty index on purpose: it is the one value every
   * caller already branches on — no folder means no `search_knowledge` tool
   * and no knowledge check in front of the web one, which is exactly what a
   * folder with nothing in it should mean too.
   */
  static load(dir: string, options: { logger?: Logger } = {}): KnowledgeIndex | null {
    const logger = options.logger ?? console;
    const path = resolve(dir);
    let names: string[];
    try {
      names = readdirSync(path).sort();
    } catch {
      // Not an error: most sessions have no knowledge folder at all.
      return null;
    }
    const files: KnowledgeFile[] = [];
    for (const name of names) {
      if (files.length >= KNOWLEDGE_MAX_FILES) {
        logger.warn(
          `[knowledge] ${path} holds more than ${KNOWLEDGE_MAX_FILES} readable files; the rest are ignored`,
        );
        break;
      }
      if (!(KNOWLEDGE_EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase())) {
        continue;
      }
      const file = this.read(path, name, logger);
      if (file !== null) files.push(file);
    }
    if (files.length === 0) return null;
    logger.log(
      `[knowledge] ${path}: ${files.length} file(s) — ${files.map((file) => file.name).join(", ")}`,
    );
    return new KnowledgeIndex(path, files);
  }

  /** One file, or `null` when it cannot be read or is not a file. */
  private static read(dir: string, name: string, logger: Logger): KnowledgeFile | null {
    const path = join(dir, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) return null;
      if (stats.size > KNOWLEDGE_FILE_MAX_BYTES) {
        logger.warn(`[knowledge] ${name} is ${stats.size} bytes and was skipped`);
        return null;
      }
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      const header = extname(name).toLowerCase() === ".csv" ? (lines[0] ?? "").trim() : "";
      return { name, lines, header };
    } catch (error) {
      logger.warn(
        `[knowledge] ${name} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Every file in the folder, by name, in the order they are searched. */
  files(): readonly string[] {
    return this.loaded.map((file) => file.name);
  }

  /**
   * The lines that best match `query`, best first.
   *
   * Scored by how many of the query's content words a line carries, with a
   * line that has the whole phrase on it ranked above one that has the same
   * words scattered. Ties keep file and line order, so the same query twice
   * returns the same snippets in the same order — which is what makes a
   * replay of a conversation reproducible.
   */
  search(query: string, limit = KNOWLEDGE_MAX_SNIPPETS): KnowledgeSnippet[] {
    const terms = contentWords(query);
    const phrase = query.replace(/\s+/g, " ").trim().toLowerCase();
    if (terms.length === 0 && phrase === "") return [];
    const hits: { snippet: KnowledgeSnippet; score: number; order: number }[] = [];
    let order = 0;
    for (const file of this.loaded) {
      file.lines.forEach((raw, index) => {
        const text = raw.trim();
        if (text === "") return;
        const lowered = text.toLowerCase();
        let score = terms.reduce((total, term) => total + (lowered.includes(term) ? 1 : 0), 0);
        if (score === 0) return;
        // The whole question on one line beats the same words spread about.
        if (phrase !== "" && lowered.includes(phrase)) score += terms.length;
        order += 1;
        hits.push({
          score,
          order,
          snippet: {
            file: file.name,
            line: index + 1,
            text: clip(
              file.header === "" || index === 0 ? text : `${file.header} | ${text}`,
              KNOWLEDGE_SNIPPET_MAX_CHARS,
            ),
          },
        });
      });
    }
    hits.sort((left, right) => right.score - left.score || left.order - right.order);
    return hits.slice(0, Math.max(0, limit)).map((hit) => hit.snippet);
  }
}

/** A query's words worth matching on: lowercase, de-duplicated, no filler. */
export function contentWords(query: string): string[] {
  const words: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9$.%-]+/)) {
    const word = raw.replace(/^[.-]+|[.-]+$/g, "");
    if (word.length < 2 && !/^[0-9]$/.test(word)) continue;
    if (KNOWLEDGE_STOP_WORDS.has(word)) continue;
    if (!words.includes(word)) words.push(word);
  }
  return words;
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
