/** Detect explicit self-introductions, without guessing identities from context. */
export function introducedName(text: string): string | null {
  // Anchor at the beginning of a turn: "I'm meeting Jordan" and quoted or
  // reported introductions are not evidence that this speaker is Jordan.
  const match = text.trim().match(/^(?:(?:[Hh]i|[Hh]ello|[Hh]ey)[,.!]?\s+)?(?:[Aa]nd\s+)?(?:[Mm]y name is|[Ii](?:['’]m| am)|[Tt]his is)\s+([\p{Lu}][\p{L}\p{M}'’\-]{0,39})(?=$|[,.!?]|\s+(?:I\b|and\b))/u);
  if (!match) return null;
  const name = match[1];
  if (!name || /^(?:A|An|The|Just|Here|New|Ready|Sorry|Happy|Going|Looking|Working|Thinking|Wondering|Trying|Not|Sure|Fine|Good|Okay|OK|Back|Also|Actually|Sotto)$/i.test(name)) return null;
  return name;
}

/**
 * Every self-introduction in one turn, in order. The transcription service
 * ends a turn on silence, not on a change of voice, so two people introducing
 * themselves back to back ("I'm Craig. I'm EJ. Okay, so…") arrive as one turn
 * with one label; the first name is that speaker's and the rest belong to
 * voices the session has not been given a label for yet.
 */
export function introducedNames(text: string): string[] {
  const names: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/u)) {
    const name = introducedName(sentence);
    if (name !== null && !names.includes(name)) names.push(name);
  }
  return names;
}
