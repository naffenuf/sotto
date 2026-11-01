/**
 * Finding a word in what was said (and in the notes): a case-insensitive
 * substring match, split so the panel can wrap each hit in a `<mark>`.
 * Pure, so it is unit-tested in node like the rest of `web/src/*.ts`.
 */

export interface MatchPart {
  text: string;
  match: boolean;
}

/** What a query is, once trimmed; `""` means "not searching". */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Whether `text` contains the (normalized) query. An empty query matches nothing. */
export function matchesQuery(text: string, query: string): boolean {
  return query !== "" && text.toLowerCase().includes(query);
}

/**
 * `text` cut into alternating plain and matching parts, in order. With an
 * empty query, or no hit, the whole text comes back as one plain part.
 */
export function splitMatches(text: string, query: string): MatchPart[] {
  if (query === "") return [{ text, match: false }];
  const lower = text.toLowerCase();
  const parts: MatchPart[] = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(query, from);
    if (at === -1) break;
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + query.length), match: true });
    from = at + query.length;
  }
  if (from < text.length || parts.length === 0) parts.push({ text: text.slice(from), match: false });
  return parts;
}
