/**
 * Text-only echo matching for V2-006. Compare the captured fragment against
 * each recent utterance, not the other way round: ASR often hears only part
 * of a long answer. Counting repeated tokens prevents a few common words
 * from matching an arbitrarily long turn.
 */

/** The PRD's minimum fraction of captured tokens also present in speech. */
export const SELF_ECHO_OVERLAP = 0.6;
/** ASR may deliver the last fragment after playback has already finished. */
export const SELF_ECHO_TAIL_MS = 1_500;

/** Actual playback, independent of synthesis and of the session timeline. */
export interface SpeechPlayback {
  playing: boolean;
  /** Includes an active utterance before its first complete word is heard. */
  recent: readonly { id: string; text: string }[];
}

/** Case and punctuation are ASR choices, not evidence of a different voice. */
function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[’']/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Fraction of the captured tokens found in one spoken utterance (multiset
 * intersection / captured length). Unlike Jaccard, a short excerpt of a
 * long answer still scores 1. Empty text never matches.
 */
export function echoOverlap(captured: string, spoken: string): number {
  const heard = tokens(captured);
  if (heard.length === 0) return 0;
  const available = new Map<string, number>();
  for (const token of tokens(spoken)) available.set(token, (available.get(token) ?? 0) + 1);
  let matched = 0;
  for (const token of heard) {
    const remaining = available.get(token) ?? 0;
    if (remaining === 0) continue;
    matched += 1;
    available.set(token, remaining - 1);
  }
  return matched / heard.length;
}

/** A fragment must match one utterance; unrelated past answers cannot add up. */
export function isSelfEcho(captured: string, spoken: readonly string[]): boolean {
  return spoken.some((text) => echoOverlap(captured, text) >= SELF_ECHO_OVERLAP);
}
