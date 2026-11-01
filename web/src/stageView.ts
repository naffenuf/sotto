/**
 * The pure part of the stage (US-011): what order cards are in, and which
 * glows have gone quiet enough to fold into the tray.
 *
 * A card's `createdAtMs` is on the session clock — an offset into the
 * conversation, which a `max`-speed replay runs far ahead of the wall — so it
 * cannot say how old a card is on screen. The stage stamps each arrival with
 * `Date.now()` instead, the same way the board panel's freshness line does.
 */
import type { StageCard } from "../../shared/index.js";

/** A card, plus when the browser got it. */
export interface StageCardView extends StageCard {
  /** `Date.now()` when the card reached this page. */
  receivedAtMs: number;
}

/**
 * Folds one card into the stage.
 *
 * A card with an id already there is replaced in place, keeping the arrival
 * time it was first stamped with, so an answer that lands in pieces
 * (thinking, headline, detail) neither doubles itself nor jumps to the top of
 * the stack each time.
 *
 * `forward` is the one exception (V2-015): a research card that somebody has
 * just asked for is stamped again, so it comes back to the top of the stage
 * while Sotto briefs the room on it.
 */
export function foldCard(
  cards: readonly StageCardView[],
  card: StageCard,
  now: number,
  max: number,
): StageCardView[] {
  const index = cards.findIndex((existing) => existing.id === card.id);
  if (index !== -1) {
    const existing = cards[index] as StageCardView;
    const next = [...cards];
    next[index] = { ...card, receivedAtMs: card.forward === true ? now : existing.receivedAtMs };
    return next;
  }
  const next = [...cards, { ...card, receivedAtMs: now }];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** How long a glow stays on the stage before it collapses into the tray. */
export const QUIET_TRAY_MS = 120_000;

export interface StageArrangement {
  /** On the stage, newest first. */
  stack: StageCardView[];
  /** Folded into the "n quiet thoughts" tray, newest first. */
  tray: StageCardView[];
}

/**
 * Newest on top, with glows older than {@link QUIET_TRAY_MS} moved to the
 * tray. Answers and interjections stay on the stage however old they get:
 * they were worth saying out loud, so they are worth still being readable.
 */
export function arrangeCards(cards: readonly StageCardView[], now: number): StageArrangement {
  const newestFirst = [...cards].sort((a, b) => b.receivedAtMs - a.receivedAtMs);
  const stack: StageCardView[] = [];
  const tray: StageCardView[] = [];
  for (const card of newestFirst) {
    if (card.variant === "glow" && now - card.receivedAtMs >= QUIET_TRAY_MS) tray.push(card);
    else stack.push(card);
  }
  return { stack, tray };
}

/**
 * What Sotto is holding and has not said (PRD V3-017), newest first — the
 * stage's own order, so the first of them is the one a `call_on` would be
 * answered with.
 *
 * Three things take a card off this list, which is the whole of the PRD's
 * "opened, spoken or expired":
 *
 *   - **Opened**: the reader expanded it, so they have heard what Sotto had.
 *     That is the one of the three only the browser can know, which is why
 *     the count lives here rather than on the server.
 *   - **Spoken**: the server republishes the card without
 *     {@link StageCard.raised} the moment the sentence lands — because it was
 *     said in a `bold` session (V3-008), or because the room called on it.
 *   - **Expired**: a glow that has aged into the tray is no longer on the
 *     stage, and a hand still up for it would be asking about a thought the
 *     conversation left behind two minutes ago.
 */
export function raisedCards(
  cards: readonly StageCardView[],
  opened: ReadonlySet<string>,
  now: number,
): StageCardView[] {
  return arrangeCards(cards, now).stack.filter(
    (card) => card.raised === true && !opened.has(card.id),
  );
}

/** The tray's label. One thought is not "1 quiet thoughts". */
export function trayLabel(count: number): string {
  return `${count} quiet thought${count === 1 ? "" : "s"}`;
}

/**
 * When the stage next has to re-check the tray — the moment the youngest glow
 * still on the stage is due to collapse — or `null` when nothing can move.
 *
 * Glows that are already past due are left out on purpose: a due time in the
 * past is a timer that fires immediately and finds nothing to do, which is how
 * a render loop starts.
 */
export function nextTrayDueAt(cards: readonly StageCardView[], now: number): number | null {
  const dues = cards
    .filter((card) => card.variant === "glow")
    .map((card) => card.receivedAtMs + QUIET_TRAY_MS)
    .filter((due) => due > now);
  return dues.length === 0 ? null : Math.min(...dues);
}
