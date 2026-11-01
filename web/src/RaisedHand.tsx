/**
 * The raised hand in the header (PRD V3-017).
 *
 * Sotto holds almost everything it notices back (V3-008): a contradiction, a
 * number that looks wrong, a question nobody answered, a search that finished
 * while two people were mid-sentence. All of it is on the stage and none of it
 * is said out loud, which is the promise — and the risk of that promise is
 * that a group looking at its own notes never finds out Sotto had anything.
 *
 * So one small thing in the header says it does: `✋ 2`, beside the status
 * dots, with the way to hear it in the tooltip. No sound, no modal, nothing
 * that moves. Clicking it is the keyboard-and-mouse equivalent of calling on
 * Sotto out loud — it marks what is held as seen and the hand goes down —
 * which is also the only way to clear a card that is already shown in full
 * and so can never be "opened".
 */
import { useEffect, useMemo, useState } from "react";
import { nextTrayDueAt, raisedCards, type StageCardView } from "./stageView.js";

/** What somebody says to hear the latest, which is the tooltip's second half. */
export const CALL_ON_HINT = 'say “Sotto, go ahead” to hear the latest';

/** What the hand is holding, and how to take it down. */
export interface RaisedHandState {
  /** The cards Sotto is holding, newest first. */
  cards: StageCardView[];
  /** One card has been read: it no longer counts. */
  open: (cardId: string) => void;
  /** All of them have: the hand goes down. */
  openAll: () => void;
}

/**
 * Follows the stage: which raised cards the reader has not seen yet.
 *
 * The clock is the browser's, like the tray's, because "expired" here means
 * a glow that has aged off the stage and that is measured in screen time
 * rather than in conversation time.
 */
export function useRaisedHand(cards: readonly StageCardView[]): RaisedHandState {
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const due = nextTrayDueAt(cards, now);

  useEffect(() => {
    if (due === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(due - Date.now(), 0) + 50);
    return () => window.clearTimeout(timer);
  }, [due]);

  const held = useMemo(() => raisedCards(cards, opened, now), [cards, opened, now]);
  return {
    // Already newest first, which is what the tooltip names.
    cards: held,
    open: (cardId) => setOpened((seen) => new Set(seen).add(cardId)),
    openAll: () => setOpened((seen) => {
      const next = new Set(seen);
      for (const card of held) next.add(card.id);
      return next;
    }),
  };
}

export interface RaisedHandProps {
  /** The cards Sotto is holding, newest first. */
  cards: readonly StageCardView[];
  /** Clears the hand. Absent on a page where there is nothing to clear. */
  onOpenAll?: (() => void) | undefined;
}

/** `✋ 2`, or nothing at all when Sotto is holding nothing. */
export function RaisedHand({ cards, onOpenAll }: RaisedHandProps) {
  if (cards.length === 0) return null;
  const newest = cards[0];
  const title =
    `Sotto is holding ${cards.length} thing${cards.length === 1 ? "" : "s"}` +
    ` it has not said — ${CALL_ON_HINT}` +
    (newest === undefined || newest.headline === "" ? "" : `. Latest: ${newest.headline}`);
  return (
    <button
      type="button"
      className="raised-hand"
      data-testid="raised-hand"
      data-count={cards.length}
      title={title}
      aria-label={title}
      onClick={onOpenAll}
    >
      <span className="raised-hand__mark" aria-hidden="true">
        ✋
      </span>
      <span className="raised-hand__count" data-testid="raised-hand-count">
        {cards.length}
      </span>
    </button>
  );
}
