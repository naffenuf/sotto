/**
 * The noise Sotto makes while it is still thinking (V2-005).
 *
 * Somebody has just said Sotto's name out loud in front of other people, and
 * the honest answer takes ten to twenty seconds to write. Silence in that gap
 * reads as "it didn't hear me", and the group says the question again. So the
 * first thing out is two words, and which two depends on how long the wait is
 * about to be: "Mm-hm." is a listener's acknowledgment for a question the
 * board already answers, and "One sec." buys the time a search needs. Not
 * "Let me check.": the holding line that follows two seconds later says
 * where Sotto is going ("Let me pull the current ticketing fees"), and the
 * demo's second take heard the two "let me"s back to back.
 *
 * Both are short on purpose. They are spoken before the answer exists and are
 * cut off the moment its first sentence does, so anything longer would be
 * interrupting Sotto's own answer.
 */

/** Heard, and answering from what was already said. */
export const ACK_QUICK = "Mm-hm.";

/** Heard, and going to look it up — said when the wait will be a long one. */
export const ACK_SEARCH = "One sec.";

/**
 * The ways a question says it is about *this conversation*.
 *
 * Those are answered from the board and the transcript, which are already in
 * the request, so nothing is searched and the answer is quick. Everything else
 * is assumed to need the web: that is the common case for a question somebody
 * bothers to ask out loud, and guessing "quick" wrongly leaves the room in
 * silence, while guessing "check" wrongly costs two words.
 */
const ABOUT_THE_ROOM: readonly RegExp[] = [
  /\bwe (?:just )?(?:decide|decided|agree|agreed|said|say|settled|picked|chose|choose|landed)\b/i,
  /\b(?:did|have|had) we\b/i,
  /\bwhat'?s? (?:on )?(?:the )?board\b/i,
  /\b(?:recap|summar\w+|wrap us up|wrap up)\b/i,
  /\bso far\b/i,
  /\bopen (?:questions?|items?|threads?)\b/i,
  /\b(?:you|he|she|they) (?:just )?said\b/i,
  /\bwhat'?s left\b/i,
  /\bwhere (?:are|were) we\b/i,
];

/** Whether answering this question will probably mean a web search. */
export function searchLikely(question: string): boolean {
  return !ABOUT_THE_ROOM.some((pattern) => pattern.test(question));
}

/** The acknowledgment to say while this question is being answered. */
export function chooseAcknowledgment(question: string): string {
  return searchLikely(question) ? ACK_SEARCH : ACK_QUICK;
}
