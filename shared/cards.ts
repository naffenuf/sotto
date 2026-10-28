/**
 * What the stage shows (PRD US-011).
 *
 * Everything Sotto contributes to the group — an answer to a question, an
 * interjection, a quiet thought — arrives in the browser as one of these and
 * is drawn by one component, so a glow that the reader opens becomes the same
 * card an interjection would have been. The `variant` is the *level* the
 * policy (US-014) chose, not a different kind of content.
 *
 * The fields a variant does not use are simply absent; a reader should treat a
 * missing `detailMd` as "there is no detail", never as an error. That is what
 * lets the answer agent (US-018) push the same card three times — `thinking`
 * with nothing but an id, then a headline, then the detail and its sources.
 */

/**
 * - `answer`: a reply to a question, spoken (US-017) or typed (US-019).
 * - `interject`: Sotto raising its hand — same size as an answer, accented.
 * - `glow`: a quiet thought, one muted line until somebody opens it.
 */
export const cardVariants = ["answer", "interject", "glow"] as const;
export type CardVariant = (typeof cardVariants)[number];

/**
 * - `thinking`: on its way. The headline may already be there, or not.
 * - `ready`: all of it has arrived.
 * - `error`: it will not arrive, and `message` says why.
 */
export const cardStates = ["thinking", "ready", "error"] as const;
export type CardState = (typeof cardStates)[number];

/** One numbered source under a card. */
export interface Citation {
  url: string;
  title: string;
}

/** A quote from the transcript, which an interjection rests its case on. */
export interface EvidenceQuote {
  /** The turn it came from, so US-015 can scroll the transcript to it. */
  turnId: string;
  quote: string;
  /** Who said it, already resolved to the display name where there is one. */
  speaker?: string;
}

/** One card on the stage. */
export interface StageCard {
  id: string;
  variant: CardVariant;
  state: CardState;
  /** When Sotto decided to show it, on the session clock. */
  createdAtMs: number;
  /** The line that carries the message. Empty while there is only `thinking`. */
  headline: string;
  /** `answer`: what was asked. */
  question?: string;
  /** `answer`: who asked — a speaker's name, or `"typed"` (US-019). */
  askedBy?: string;
  /** Markdown, behind "details ▾". */
  detailMd?: string;
  /** `interject`/`glow`: why this is worth saying now (US-012). */
  whyNow?: string;
  /** `interject`/`glow`: what in the conversation it rests on. */
  evidence?: EvidenceQuote[];
  /** Numbered sources, deduplicated by URL before they get here. */
  citations?: Citation[];
  /** `state: "error"`: the muted line shown in place of the content. */
  message?: string;
}
