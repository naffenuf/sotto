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

/**
 * Somebody correcting the name the room just heard: "No, that was EJ",
 * "It's EJ", "Her name is EJ". Anchored at the start of the turn, like an
 * introduction, and only ever applied by the caller to the *previous*
 * speaker — the one who just introduced themselves and was misheard
 * (`2026-11-03_0945-mic` heard "And I'm EJ" as "And I'm AJ", and Craig's
 * "No, that was EJ" went nowhere).
 */
export function correctedName(text: string): string | null {
  const match = text.trim().match(
    /^(?:[Nn]o[,.!]?\s+|[Aa]ctually[,.!]?\s+|[Ss]orry[,.!]?\s+)?(?:[Tt]hat(?:['’]s| was| is)|[Ii]t(?:['’]s| was| is)|[Ss]he(?:['’]s| is)|[Hh]e(?:['’]s| is)|[Hh]er name is|[Hh]is name is|[Tt]heir name is)\s+([\p{Lu}][\p{L}\p{M}'’\-]{0,39})(?=$|[,.!?]|\s+(?:not|and|by the way|okay|so)\b)/u,
  );
  if (!match) return null;
  const name = match[1];
  if (!name || /^(?:A|An|The|Not|Fine|Good|Okay|OK|Right|True|Correct|Wrong|It|Sotto|Me|Him|Her|Them|Us|Why|What|When|Where|How|All|Done|Enough|Great|Nice)$/i.test(name)) return null;
  return name;
}
