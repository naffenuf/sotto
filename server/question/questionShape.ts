/**
 * V3-002's lexical pre-filter: is this turn shaped like a question at all?
 *
 * Pure, and deliberately generous in one direction only. Everything it passes
 * costs a Spark call, and everything it rejects can never be looked up, so the
 * rules are written against what the captures actually contain rather than
 * against the scripts: a final turn keeps its question mark most of the time
 * (`" Is it an hour and a half? "`) but not always — `ask-search`'s trigger
 * came back as `" Sotto what do the main competitors charge per month. "` —
 * and it never keeps the comma that would mark a clause boundary.
 *
 * So the test is *sentence-initial* question words plus a trailing `?`, never
 * a wh-word anywhere. A wh-word anywhere would pass most of `brainstorm`
 * ("respect what you don't have", "what's on hand", "the bit someone would
 * screenshot") against a budget of about a quarter of its turns. Measured on
 * the captures with these rules: `brainstorm` 2 of 24 (8%), `no-wake` 2 of 12,
 * `offsite-plan` 10 of 37, `moment-*` 8–26%, and `research-business-idea` 12 of
 * 38 — a conversation that really is mostly questions.
 *
 * The one family of statements it passes are the ones that are a question with
 * the question taken off the front — "I have no idea whether they have a
 * Thursday free this month" is the room wondering aloud as plainly as asking
 * would have been, and it is the shape the `offsite-plan` research hook is
 * built on.
 */

/** Question words that only start a question when they start the sentence. */
const OPENERS = [
  // Wh-words and the auxiliaries that invert into a question.
  // Not "which": a question that opens with it keeps its question mark in
  // every capture, while a relative clause opening a sentence ("Which nobody
  // loves", "Which leaves Wednesday and Thursday") never is one.
  "what", "whats", "who", "whos", "whose", "whom", "where", "wheres", "when", "whens",
  "why", "whys", "how", "hows",
  "is", "are", "was", "were", "do", "does", "did", "can", "could", "should", "would", "will",
  "shall", "has", "have", "had", "am",
] as const;

/**
 * Phrases that make a statement a question, wherever they appear.
 *
 * "wonder" and "no idea" are the room thinking aloud; the rest are the ways a
 * group hands itself a lookup without phrasing it as a question.
 */
const WONDERING = [
  /\bi\s+wonder\b/,
  /\bwe\s+wonder\b/,
  /\bwondering\b/,
  /\b(?:no|not\s+a)\s+idea\b/,
  /\bdon'?t\s+know\s+(?:if|whether|how|what|when|where|who|why)\b/,
  /\bnot\s+sure\s+(?:if|whether|how|what|when|where|who|why)\b/,
  /\bdoes\s+anyone\s+know\b/,
  /\banyone\s+know\b/,
  /\bany\s+idea\b/,
  /\bwe'?d\s+need\s+to\s+(?:check|look)\b/,
  /\bwe\s+(?:should|need\s+to)\s+(?:check|look\s+up)\b/,
  /\bhow\s+(?:long|much|many|far|big|old)\b/,
  /\bwhat\s+(?:does|do|did)\b[^.?!]{0,40}\b(?:charge|cost|costs)\b/,
] as const;

/** Whether `text` is worth one classification call (V3-002). */
export function isQuestionShaped(text: string): boolean {
  const normalized = text.toLowerCase();
  if (WONDERING.some((pattern) => pattern.test(normalized))) return true;
  for (const sentence of sentences(normalized)) {
    // A question mark is the clearest signal there is, and the transcription
    // keeps it on most turns that had one.
    if (sentence.endsWith("?")) return true;
    const first = words(sentence).find((word) => !LEAD_INS.has(word));
    if (first !== undefined && (OPENERS as readonly string[]).includes(first)) return true;
  }
  return false;
}

/**
 * Words a sentence can open with before the question word arrives, stripped
 * so the opener test still reads the right word ("Alright, so where do we
 * start?", "Fair. And who's handling food?").
 *
 * Only these, never every conjunction: splitting a turn on "and" or "which"
 * turns every relative clause into a sentence of its own, and the captures are
 * full of them ("Which nobody loves", "which at our volume is basically
 * free") — four extra calls across six conversations for no question.
 */
const LEAD_INS = new Set([
  "okay", "ok", "alright", "right", "so", "and", "but", "then", "well", "oh", "fair", "yeah",
  "yes", "no", "now", "hey", "hmm", "look", "listen", "anyway", "also", "good", "noted", "sorry",
]);

/** The sentences of a turn, by terminator: the transcription keeps those. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}']+/gu) ?? [];
}

/**
 * Ways a group says a thing is settled (V3-013).
 *
 * A closing decision is not question-shaped at all — "OK, let's go with six
 * gardens then" has no question word and no question mark — so it would never
 * reach the classifier on {@link isQuestionShaped} alone, and the PRD's "it
 * costs no extra call" would be an extra call by another name. These are the
 * phrases a room uses to stop weighing something, matched wherever they
 * appear: the turn that settles it usually starts with the agreement
 * ("Right, let's lock that in") but just as often ends with it ("Fine, we kill
 * the Monday meeting then").
 *
 * Generous on purpose, because the model decides: "we could lock it in now, or
 * wait for Alex" matches here and comes back `closing: false`, which is one
 * cheap call rather than a missed read-back. What is *not* here is the bare
 * agreement — "works for me", "fine", "sounds good" — which is most of a
 * conversation's short turns and carries no decision to read back.
 */
const CLOSINGS = [
  /\blet'?s\s+(?:just\s+)?(?:go\s+with|do|lock|book|run\s+with|start\s+with|say|call\s+it|take)\b/,
  /\blet'?s\s+(?:just\s+)?(?:go|do\s+it|do\s+that)\b/,
  /\bwe'?re\s+(?:agreed|going\s+with|doing|booking|locking|settled)\b/,
  /\b(?:that'?s|it'?s|we'?re)\s+(?:settled|decided|agreed|locked|a\s+plan)\b/,
  /\b(?:we'?ll|i'?ll)\s+(?:go\s+with|lock|book|put\s+(?:it|that)\s+down)\b/,
  /\block(?:ing)?\s+(?:it|that|this)\s+in\b/,
  /\bgoing\s+with\b/,
  /\b(?:decided|agreed|settled|sorted)\s+then\b/,
  /\bbook(?:ing)?\s+(?:it|that)\b/,
  /\bsign(?:ing)?\s+off\s+on\b/,
  /\bput\s+(?:it|that)\s+down\s+as\b/,
  /\bgo\s+with\s+(?:the|that|those|six|two|three|four|five|option)\b/,
] as const;

/** Whether this turn is shaped like the group settling something (V3-013). */
export function isClosingShaped(text: string): boolean {
  const normalized = text.toLowerCase();
  return CLOSINGS.some((pattern) => pattern.test(normalized));
}

/**
 * Whether this final turn is worth one classification call at all.
 *
 * The union of the two shapes, because the classifier answers both questions
 * in one call (V3-013): what the turn is doing, and — if that is a decision —
 * whether it was just settled.
 */
export function worthClassifying(text: string): boolean {
  return isQuestionShaped(text) || isClosingShaped(text);
}
