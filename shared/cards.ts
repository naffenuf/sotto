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
 * - `notice`: Sotto talking about itself rather than about the conversation —
 *   the opening hello when the voice is muted, and the one nudge for names
 *   (V2-009). Plain, unaccented, and carrying no feedback buttons: there is no
 *   decision to speak here for the group to have an opinion about, which is
 *   also why the eval harness and the end-to-end checks never count one as a
 *   delivery.
 */
export const cardVariants = ["answer", "interject", "glow", "notice"] as const;
export type CardVariant = (typeof cardVariants)[number];

/**
 * Ids the {@link CardVariant} `notice` cards take (V2-009).
 *
 * Derived rather than counted, like a delivered card's id, and one per kind:
 * there is exactly one hello and at most one name nudge in a session, so
 * pushing either twice replaces it rather than stacking a second copy.
 */
export const NOTICE_CARD_IDS = {
  /** The opening hello, shown when the voice could not say it. */
  hello: "notice-hello",
  /** "I'd love to know who's here", once, at a pause. */
  names: "notice-names",
} as const;

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

/**
 * One piece of generated HTML on a card (US-020).
 *
 * The card holds a URL, not the HTML: the document is written into the
 * session folder and served from there with a restrictive CSP, so what the
 * browser renders is a sandboxed frame rather than markup the page has ever
 * touched.
 */
export interface CardArtifact {
  /** The label above the frame. */
  title: string;
  /** `/api/sessions/<id>/artifacts/<file>`. */
  url: string;
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
  /**
   * `answer`: the words Sotto said out loud, behind "transcript of answer ▾"
   * (V2-005).
   *
   * Not the same writing as {@link detailMd}: the spoken half is sentences
   * meant to be heard and the screen half is meant to be glanced at. It is
   * present even when voice was muted — the answer was still written to be
   * heard, and somebody reading the card should be able to see what would
   * have been said.
   */
  spokenText?: string;
  /** `interject`/`glow`: why this is worth saying now (US-012). */
  whyNow?: string;
  /** `interject`/`glow`: what in the conversation it rests on. */
  evidence?: EvidenceQuote[];
  /** Numbered sources, deduplicated by URL before they get here. */
  citations?: Citation[];
  /** `answer`: HTML the model drew, rendered in a sandboxed frame (US-020). */
  artifacts?: CardArtifact[];
  /** `state: "error"`: the muted line shown in place of the content. */
  message?: string;
}
