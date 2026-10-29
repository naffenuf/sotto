/**
 * An answer to a question somebody asked Sotto (PRD US-018).
 *
 * Unlike every other model call in Sotto, an answer comes back as **prose**
 * rather than as JSON: the PRD's shape is "line 1 is a headline, then optional
 * markdown detail", which is a text reply, and a text reply is also the only
 * kind the API attaches `url_citation` annotations to — an annotation is a
 * character range into what the model wrote, so a JSON body gives it nothing
 * to point at (measured; see `CLAUDE.md`).
 *
 * So the parsing lives here, pure and tested: {@link splitAnswer} turns the
 * model's text into the headline, the detail and the sources it listed, and
 * applies the stated limits. It runs on a half-finished reply too, which is
 * what lets the headline reach the stage while the detail is still arriving.
 */
import { z } from "zod";
import type { Citation } from "./cards.js";

/** Characters of headline. Long enough to answer, short enough to glance at. */
export const ANSWER_HEADLINE_MAX_CHARS = 90;

/** Words of detail. More than this is not a glance, it is a document. */
export const ANSWER_DETAIL_MAX_WORDS = 150;

/** What `askedBy` says when the question was typed rather than spoken (US-019). */
export const TYPED_ASKER = "typed";

/**
 * Characters a typed question may be (US-019).
 *
 * Generous — a question asked in writing is often longer than one asked out
 * loud — but bounded, because this is a text box pointed at a model call.
 */
export const ASK_QUESTION_MAX_CHARS = 500;

/**
 * Body of `POST /api/ask`: one typed question (US-019).
 *
 * Nothing else goes over the wire. Who asked is {@link TYPED_ASKER} by
 * definition, and the context the question is answered in — the board, the
 * last ten minutes of transcript — is the server's, not the tab's.
 */
export const AskRequestSchema = z.object({
  question: z.string().trim().min(1).max(ASK_QUESTION_MAX_CHARS),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

/**
 * Response to it. The answer itself does not come back this way: it arrives
 * on `/ws/events` as an `answer` card, thinking first and finished later,
 * exactly as a spoken question's does (US-018).
 */
export interface AskResponse {
  asked: true;
  /** The question as the server took it, trimmed. */
  question: string;
}

/**
 * - `thinking`: the call is out. The headline may already be here, or not.
 * - `done`: all of it arrived.
 * - `error`: it will not arrive, and `error` says why.
 */
export const answerStatuses = ["thinking", "done", "error"] as const;
export type AnswerStatus = (typeof answerStatuses)[number];

/** One answer, at whatever stage it has reached. */
export interface Answer {
  /** `ans-1`, `ans-2`: unique within the session. */
  id: string;
  /** What was asked, without the wake phrase. */
  question: string;
  /**
   * Who asked: the display name of whoever said it, their diarization label
   * if they have no name yet, or {@link TYPED_ASKER}.
   */
  askedBy: string;
  /** Line 1. Empty while there is nothing but `thinking`. */
  headline: string;
  /** The markdown under the headline, without the sources it listed. */
  detailMd: string;
  /** Numbered sources, deduplicated by URL. */
  citations: Citation[];
  status: AnswerStatus;
  /** When the question arrived, on the session clock. */
  createdAtMs: number;
  /** How long the answer took, so far. */
  latencyMs: number;
  /**
   * `status: "error"`: the short line shown in place of the answer.
   *
   * Not in the PRD's field list, which stops at `status` — but a status of
   * `error` with no reason is a card that says nothing and a log line that
   * explains nothing, so the message is kept with the record it belongs to.
   */
  error?: string;
}

/** One line of `answers.jsonl` (US-008). */
export interface AnswerLogRecord extends Answer {
  kind: "answer";
  /** The turn the question was asked in, or `null` when it was typed. */
  turnId: string | null;
}

/** A source the model listed in its own words, before it is resolved. */
export interface ListedSource {
  title: string;
  url: string;
}

/** What {@link splitAnswer} made of the model's text. */
export interface AnswerText {
  /** Line 1, collapsed to one line and clipped. */
  headline: string;
  /** Everything after it, without the sources block. */
  detailMd: string;
  /** The pages the model listed under "Sources:", in the order it gave them. */
  sources: ListedSource[];
  /** Whether a complete first line has arrived, i.e. whether a line 2 exists. */
  headlineComplete: boolean;
}

/**
 * The heading the model is asked to put its sources under.
 *
 * The sources are pulled out of the text rather than left in it because the
 * card draws them itself, as numbered links under the detail (US-011) — and
 * because a list of bare URLs in the middle of a detail is the opposite of
 * glanceable.
 */
const SOURCES_HEADING = /^\s*(?:[-*]\s*)?(?:\*\*|__)?\s*sources?\b\s*:?\s*(?:\*\*|__)?\s*$/i;

/** `Sources: <a source on the same line>`, which the model also writes. */
const SOURCES_INLINE = /^\s*(?:\*\*|__)?\s*sources?\b\s*:\s*(?:\*\*|__)?\s*(?=\S)/i;

/** A markdown link, which is the other way the model names a page. */
const MARKDOWN_LINK = /^\s*(?:[-*]\s*)?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*$/;

/** Every URL in a line; the last one is the page, anything before it the title. */
const URL_PATTERN = /https?:\/\/[^\s<>()[\]"']+/g;

/**
 * Splits one answer, whole or half-written.
 *
 * It is deliberately tolerant: the model is told the shape in
 * `server/prompts/answer.md` but nothing enforces it, and a reply whose
 * headline arrives as `**What rivals charge**` or `## What rivals charge` is a
 * good answer typed in markdown, not a failure.
 */
export function splitAnswer(text: string): AnswerText {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) {
    return { headline: "", detailMd: "", sources: [], headlineComplete: false };
  }

  const headline = clipChars(plainText(lines[first] as string), ANSWER_HEADLINE_MAX_CHARS);
  const rest = lines.slice(first + 1);
  const { body, sources } = takeSources(rest);
  return {
    headline,
    detailMd: clipWords(body.join("\n").trim(), ANSWER_DETAIL_MAX_WORDS),
    sources,
    // The first line is only finished once there is a line after it: a
    // headline still being typed must not reach the stage half-said.
    headlineComplete: lines.length > first + 1,
  };
}

/** The detail and the sources block, told apart by the heading between them. */
function takeSources(lines: readonly string[]): {
  body: string[];
  sources: ListedSource[];
} {
  const at = lines.findIndex(
    (line) => SOURCES_HEADING.test(line) || SOURCES_INLINE.test(line),
  );
  if (at === -1) return { body: [...lines], sources: [] };
  const block = [
    (lines[at] as string).replace(SOURCES_INLINE, ""),
    ...lines.slice(at + 1),
  ];
  return { body: lines.slice(0, at), sources: parseSources(block) };
}

/** One source per line that names a page; anything else in the block is dropped. */
function parseSources(lines: readonly string[]): ListedSource[] {
  const sources: ListedSource[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const source = parseSource(line);
    if (source === null || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
  }
  return sources;
}

/** `- Title - https://…`, `- [Title](https://…)`, or a bare URL. */
function parseSource(line: string): ListedSource | null {
  const link = MARKDOWN_LINK.exec(line);
  if (link !== null) {
    return { title: plainText(link[1] as string), url: link[2] as string };
  }
  // The last URL on the line: a title can contain one, a URL cannot contain a
  // title, so reading from the right is what separates them.
  const urls = [...line.matchAll(URL_PATTERN)];
  const url = urls[urls.length - 1];
  if (url === undefined) return null;
  const title = plainText((line.slice(0, url.index) as string).replace(/[-–—:,|]\s*$/, ""));
  return { title, url: url[0].replace(/[.,;)]+$/, "") };
}

/** One line, without the markdown a headline or a title can arrive wearing. */
function plainText(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\*\*|__|[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** `text`, cut to `max` characters at a word boundary with an ellipsis. */
function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * `text`, cut to `max` words — keeping its line breaks, because the detail is
 * markdown and a bullet list that loses its newlines becomes one long line.
 */
function clipWords(text: string, max: number): string {
  const words = [...text.matchAll(/\S+/g)];
  if (words.length <= max) return text;
  const last = words[max - 1] as RegExpMatchArray;
  return `${text.slice(0, (last.index ?? 0) + last[0].length).trimEnd()}…`;
}
