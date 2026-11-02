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
 * - `research`: background research that is ready to read (V2-014). Compact
 *   and closed like a glow — "Research ready: …" plus the teaser — and it
 *   opens into the key points, the sources and any visual. Never *unasked*
 *   spoken — V3-004 says one the room wondered aloud, and V3-017 reads one
 *   out when the room calls on it — and never a decision the policy took, so
 *   it carries no feedback buttons.
 * - `notice`: Sotto talking about itself rather than about the conversation —
 *   the opening hello when the voice is muted, the one nudge for names
 *   (V2-009), a wrap-up nothing could say out loud (V2-018), the note saying
 *   the room just turned it down or up (V3-006) and the ideas a stuck group
 *   asked to hear (V3-007). Plain, unaccented, and carrying no feedback buttons: there is no
 *   decision to speak here for the group to have an opinion about, which is
 *   also why the eval harness and the end-to-end checks never count one as a
 *   delivery.
 */
export const cardVariants = ["answer", "interject", "glow", "notice", "research"] as const;
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
  /**
   * A wrap-up that could not be said out loud (V2-018), numbered: unlike the
   * other two, a group can ask for one more than once in a conversation.
   */
  wrapUp: "notice-wrapup",
  /**
   * "Sotto will speak up less" — the frequency the room just changed
   * (V3-006), numbered, because a group can turn Sotto down and then up
   * again in one conversation and each note says what changed.
   */
  steering: "notice-steering",
  /**
   * "A few ideas on the name" — the ideas a group that was stuck asked to
   * hear (V3-007), numbered by the set they belong to. It goes up only on a
   * yes: ideas nobody asked for are what the offer exists to not do.
   */
  ideas: "notice-ideas",
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
  /**
   * `research`: the one or two sentences under the headline (V2-014).
   *
   * The packet's teaser, which is the only thing somebody reads before
   * deciding whether to open the rest, so it is shown closed as well as open
   * — unlike {@link detailMd}, which is what opening it is for.
   */
  teaser?: string;
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
  /**
   * `answer`/`research`: HTML the model drew, rendered in a sandboxed frame
   * (US-020) — on a research card, the packet's one visual (V2-013).
   */
  artifacts?: CardArtifact[];
  /** `state: "error"`: the muted line shown in place of the content. */
  message?: string;
  /**
   * One short line about the card's own standing (V3-004, V3-013).
   *
   * On a `research` card: somebody in the room answered the question before
   * Sotto could say what it found, so nothing was said out loud — `confirmed`
   * when the search agrees with them, and the fact that it does not when it
   * does not. On an `interject` or a `glow`: the decision this correction of
   * Sotto's own is still open against, which is why it has just come to the
   * top of the stage ("Still open against \"six sheds\""). Shown closed as
   * well as open, like {@link teaser} — it is the reason the card is worth a
   * glance at all.
   */
  note?: string;
  /**
   * Sotto has this and has not said it out loud (V3-008, V3-017).
   *
   * Set on every card the interjection policy delivers — a contradiction, a
   * wrong number, an assumption nobody checked, a thread they dropped, a
   * question nobody answered — except the one a `bold` session says in a
   * sentence, and on every `research` card, which is a finding Sotto looked
   * up and did not say. It is what V3-017's raised hand counts: the header
   * shows that Sotto is holding something, and anybody can call on it, which
   * is how a correction reaches the room's ears at the default settings.
   *
   * It goes both ways. A card that was queued to be spoken and then never was
   * — no pause, cut off twice, the room moved on — is published again with
   * this set; and a card that *was* said, because the room called on it or
   * because a `bold` session spoke it, is published again with it `false`.
   * The card itself stays on the stage either way.
   */
  raised?: boolean;
  /**
   * Bring this card back to the top of the stage, open (V2-015, V3-013).
   *
   * Set on the one push that happens because somebody *asked* for the
   * research — Sotto is briefing the room on it as the card arrives, so it is
   * the thing being read, and the key points, the sources and the visual are
   * what they asked to see — and on a correction of Sotto's own pinned beside
   * a decision the group has just settled, which is the one moment that card
   * is worth looking at again. Everywhere else a card that arrives again keeps
   * its place and its collapsed state, so an answer landing in pieces does
   * not jump the stack.
   */
  forward?: boolean;
}
