/**
 * Turning a decision into a card (PRD US-015).
 *
 * Pure, and deliberately dull: the policy (US-014) has already decided *what*
 * is said and *at what level*, so all that is left is to lay the candidate out
 * the way {@link StageCard} wants it. The level becomes the variant — an
 * `interject` is a full card, a `glow` is one muted line until somebody opens
 * it — and nothing else about the content changes with it, because a glow the
 * reader opens has to be exactly the card an interjection would have been.
 *
 * The one thing that is not a straight copy is the evidence: the observer
 * attaches the diarization label a quote came from (`A`, `B`), and a group
 * reading the card wants the name they gave that label (US-007).
 */
import type { SpeakerNames } from "../../shared/events.js";
import type { EvidenceQuote, StageCard } from "../../shared/cards.js";
import type { Interjection } from "./InterjectionPolicy.js";

/** Prefix of a delivered card's id, so a log line says what it refers to. */
export const CARD_ID_PREFIX = "card-";

/**
 * The id the card for one candidate gets. Derived rather than counted: a
 * candidate is delivered at most once, so this is stable, and the feedback
 * route (US-015) can be given a card id and find its way back.
 */
export function deliveredCardId(candidateId: string): string {
  return `${CARD_ID_PREFIX}${candidateId}`;
}

/**
 * The card for one delivered interjection, with the speaker names the user
 * has given resolved into its quotes.
 *
 * `state` is always `ready`: the policy only ever sees a candidate that has
 * been through the fact check (US-013), so there is nothing still arriving.
 */
export function cardForInterjection(
  interjection: Interjection,
  speakers: SpeakerNames = {},
): StageCard {
  const candidate = interjection.candidate;
  const evidence = namedQuotes(candidate.evidence, speakers);
  return {
    id: deliveredCardId(candidate.id),
    variant: interjection.level,
    state: "ready",
    createdAtMs: interjection.atMs,
    headline: candidate.headline,
    ...(candidate.whyNow.trim() === "" ? {} : { whyNow: candidate.whyNow }),
    ...(candidate.detail.trim() === "" ? {} : { detailMd: candidate.detail }),
    ...(evidence.length === 0 ? {} : { evidence }),
    ...(candidate.citations === undefined || candidate.citations.length === 0
      ? {}
      : { citations: candidate.citations }),
  };
}

/** The same quotes, attributed to whoever the group has named. */
function namedQuotes(
  quotes: readonly EvidenceQuote[],
  speakers: SpeakerNames,
): EvidenceQuote[] {
  return quotes.map((quote) =>
    quote.speaker === undefined
      ? quote
      : { ...quote, speaker: speakers[quote.speaker] ?? quote.speaker },
  );
}
