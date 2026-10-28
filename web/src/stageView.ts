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
