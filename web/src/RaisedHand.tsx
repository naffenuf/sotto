/**
 * The raised hand (PRD V3-017).
 *
 * Sotto holds almost everything it notices back (V3-008): a contradiction, a
 * number that looks wrong, a question nobody answered, a search that finished
 * while two people were mid-sentence. None of it is said out loud, which is
 * the promise — and the risk of that promise is that a group looking at its
 * own notes never finds out Sotto had anything.
 *
 * So the stage shows what is held as its own zone, "Holding", between what
 * Sotto is doing now and what it has already said: the cards themselves, one
 * line each, rather than a count in the header. No sound, no modal, nothing
 * that moves. Opening one is the keyboard-and-mouse equivalent of calling on
 * Sotto out loud — it leaves the zone and is read in full below — and "seen"
 * clears the rest.
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
  /** The cards the reader has opened, so they are read in full where they land. */
  opened: ReadonlySet<string>;
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
    opened,
    open: (cardId) => setOpened((seen) => new Set(seen).add(cardId)),
    openAll: () => setOpened((seen) => {
      const next = new Set(seen);
      for (const card of held) next.add(card.id);
      return next;
    }),
  };
}
