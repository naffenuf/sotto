/**
 * The little bit of markdown a card's details can contain (US-011).
 *
 * The answer agent (US-018) is asked for "optional detail in markdown of
 * ≤ 150 words", which in practice means paragraphs, a bullet or numbered
 * list, bold, italics, inline code and the occasional link. So this parses
 * exactly that into a tree of spans the card renders as React elements —
 * no HTML string, no `dangerouslySetInnerHTML`, and no dependency.
 *
 * Anything it does not recognize stays as literal text, which is the right
 * failure for a model's output: a stray `#` is shown, never swallowed.
 *
 * Pure, so `npm test` covers it in node the way `audio/resample.ts` is.
 */

/** A run of text inside a block. */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

/** One block of a detail: a paragraph, a heading or a list. */
export type Block =
  | { kind: "paragraph"; spans: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; spans: Inline[] }
  | { kind: "bullets"; items: Inline[][] }
  | { kind: "numbers"; items: Inline[][] };

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;

/**
 * `**strong**`, `*em*`, `_em_`, `` `code` `` and `[text](href)`, in one pass so
 * the first match in the string wins rather than the first pattern.
 */
const INLINE =
  /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** Blocks, in document order. Blank lines separate paragraphs and lists. */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  /** The paragraph being gathered: markdown joins its lines with a space. */
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? "";
    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      const level = Math.min(heading[1]?.length ?? 1, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, spans: parseInline(heading[2] ?? "") });
      continue;
    }

    // A list runs until the first line that is not an item of the same kind,
    // so one `- ` in the middle of a paragraph does not split it in three.
    const list = listKind(line);
    if (list !== null) {
      flush();
      const items: Inline[][] = [];
      while (at < lines.length) {
        const item = itemText(lines[at] ?? "", list);
        if (item === null) break;
        items.push(parseInline(item));
        at += 1;
      }
      at -= 1;
      blocks.push(list === "bullets" ? { kind: "bullets", items } : { kind: "numbers", items });
      continue;
    }

    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

function listKind(line: string): "bullets" | "numbers" | null {
  if (BULLET.test(line)) return "bullets";
  if (NUMBER.test(line)) return "numbers";
  return null;
}

function itemText(line: string, kind: "bullets" | "numbers"): string | null {
  const match = (kind === "bullets" ? BULLET : NUMBER).exec(line);
  return match === null ? null : (match[1] ?? "");
}

/** The spans of one line. */
export function parseInline(text: string): Inline[] {
  const spans: Inline[] = [];
  let at = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    if (match.index > at) spans.push({ kind: "text", text: text.slice(at, match.index) });
    spans.push(span(match));
    at = match.index + match[0].length;
  }
  if (at < text.length) spans.push({ kind: "text", text: text.slice(at) });
  return spans;
}

function span(match: RegExpExecArray): Inline {
  const [, strong, emStar, emScore, code, linkText, href] = match;
  if (strong !== undefined) return { kind: "strong", text: strong };
  if (emStar !== undefined) return { kind: "em", text: emStar };
  if (emScore !== undefined) return { kind: "em", text: emScore };
  if (code !== undefined) return { kind: "code", text: code };
  if (linkText !== undefined && href !== undefined) {
    // A model can hallucinate a `javascript:` URL as easily as any other, and
    // this one goes straight into an href: anything but the web stays text.
    return isWebUrl(href)
      ? { kind: "link", text: linkText, href }
      : { kind: "text", text: match[0] };
  }
  return { kind: "text", text: match[0] };
}

/** True for the only two schemes a card will ever link to. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}
