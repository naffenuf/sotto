/**
 * Text-only echo matching for V2-006. Compare the captured fragment against
 * each recent utterance, not the other way round: ASR often hears only part
 * of a long answer. Counting repeated tokens prevents a few common words
 * from matching an arbitrarily long turn.
 */

import { DEFAULT_WAKE_SPELLINGS } from "../wake.js";

/** The PRD's minimum fraction of captured tokens also present in speech. */
export const SELF_ECHO_OVERLAP = 0.6;
/**
 * And at least this many content words have to match (all of them, for a
 * shorter fragment): "kit list page" over a long answer that mentions kits and
 * the page is two of three, which the fraction alone would call an echo.
 */
export const SELF_ECHO_MIN_MATCHES = 3;
/** ASR may deliver the last fragment after playback has already finished. */
export const SELF_ECHO_TAIL_MS = 1_500;

/** Actual playback, independent of synthesis and of the session timeline. */
export interface SpeechPlayback {
  playing: boolean;
  /** Includes an active utterance before its first complete word is heard. */
  recent: readonly { id: string; text: string }[];
}

/**
 * Words that say nothing about *which* sentence was heard. A 590-character
 * answer contains "and", "the", "has", "to", "on" and "page" many times over,
 * and "Oh wait, and the kit list has to go on the page?" — said by somebody in
 * the room over that answer — scored 8 of 12 on exactly those, and was thrown
 * away as Sotto's own echo (checkpoint session `2026-11-01_1928-mic`). So the
 * overlap is measured over the words that carry meaning, and these are not
 * counted on either side.
 */
export const ECHO_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "so", "if", "then", "than", "as",
  "to", "of", "in", "on", "at", "for", "with", "by", "from", "into", "about", "up", "out",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "has", "have", "had", "do", "does", "did", "can", "could", "will", "would", "should",
  "it", "its", "this", "that", "these", "those", "there", "here",
  "i", "im", "me", "my", "you", "your", "we", "us", "our", "they", "them", "their", "he", "she",
  "oh", "wait", "okay", "ok", "yeah", "yes", "no", "not", "just", "go", "get", "got",
]);

/**
 * Case and punctuation are ASR choices, not evidence of a different voice —
 * and so is the spelling of Sotto's own name. The hello ends "just say
 * Sotto", which came back as `just say Soto` (session `2026-11-03_0915-mic`):
 * with the name counted as a different word the fragment was two matches of
 * three, read as a person, and its "Soto" barged in on the hello that said
 * it. Every spelling the transcription produces is the same token here.
 */
function tokens(text: string): string[] {
  const all = text.toLowerCase().replace(/[’']/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  return all.map((token) => (DEFAULT_WAKE_SPELLINGS.includes(token) ? "sotto" : token));
}

/** The tokens that carry meaning; all of them when there are none, so "I'm Sotto" still scores. */
function contentTokens(text: string): string[] {
  const all = tokens(text);
  const content = all.filter((token) => !ECHO_FUNCTION_WORDS.has(token));
  return content.length > 0 ? content : all;
}

/**
 * Fraction of the captured content tokens found in one spoken utterance
 * (multiset intersection / captured length). Unlike Jaccard, a short excerpt
 * of a long answer still scores 1. Empty text never matches.
 */
export function echoOverlap(captured: string, spoken: string): number {
  const { matched, heard } = echoMatch(captured, spoken);
  return heard === 0 ? 0 : matched / heard;
}

/** How many of the captured content tokens one utterance accounts for. */
export function echoMatch(captured: string, spoken: string): { matched: number; heard: number } {
  const heard = contentTokens(captured);
  if (heard.length === 0) return { matched: 0, heard: 0 };
  const available = new Map<string, number>();
  for (const token of tokens(spoken)) available.set(token, (available.get(token) ?? 0) + 1);
  let matched = 0;
  for (const token of heard) {
    const remaining = available.get(token) ?? 0;
    if (remaining === 0) continue;
    matched += 1;
    available.set(token, remaining - 1);
  }
  return { matched, heard: heard.length };
}

/**
 * A fragment must match one utterance; unrelated past answers cannot add up.
 * It is an echo when enough of it is in the utterance *and* enough words
 * match outright: a misheard three-word echo may now leak into the transcript
 * as a human line, which is the better failure than a human line swallowed.
 */
export function isSelfEcho(captured: string, spoken: readonly string[]): boolean {
  return spoken.some((text) => {
    const { matched, heard } = echoMatch(captured, text);
    if (heard === 0) return false;
    return matched / heard >= SELF_ECHO_OVERLAP && matched >= Math.min(SELF_ECHO_MIN_MATCHES, heard);
  });
}
