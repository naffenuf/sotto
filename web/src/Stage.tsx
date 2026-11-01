/**
 * The stage: the one large area where everything Sotto contributes shows up
 * (US-011).
 *
 * Newest on top, because the thing just said is the thing being read. Glows
 * age out of the stack into a tray rather than being dismissed, so the stage
 * stays calm without anything being lost — {@link arrangeCards} decides which
 * are which and `nextTrayDueAt` means the timer only runs while one is ageing.
 *
 * Under both of those sits the "almost said" tray (V3-016): the things that
 * never became cards at all.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlmostSaid } from "./AlmostSaid.js";
import { Card } from "./Card.js";
import type { StageCardView } from "./stageView.js";
import { arrangeCards, nextTrayDueAt, trayLabel } from "./stageView.js";
import type { FeedbackVerdict, StageCard, SuppressedCandidate } from "../../shared/index.js";

export interface StageProps {
  cards: readonly StageCardView[];
  /**
   * What the policy held back this session (V3-016), shown collapsed under
   * the cards. Restraint is part of what the stage is reporting.
   */
  almostSaid?: readonly SuppressedCandidate[];
  /** Shown while Sotto has contributed nothing yet. */
  placeholder?: ReactNode;
  /** Shown above the cards, whatever else is on the stage. */
  banner?: ReactNode;
  /**
   * Pinned under the cards rather than scrolling with them: the "Ask Sotto…"
   * box (US-019) has to be reachable however much is on the stage.
   */
  footer?: ReactNode;
  /** Shows an evidence quote's turn in the transcript (US-015). */
  onQuoteClick?: ((turnId: string) => void) | undefined;
  /** Files the group's verdict on a card (US-015). */
  onFeedback?: ((card: StageCard, verdict: FeedbackVerdict) => void) | undefined;
  /** The reader opened a card, so the raised hand stops counting it (V3-017). */
  onOpen?: ((card: StageCard) => void) | undefined;
}

export function Stage({
  cards,
  almostSaid = [],
  placeholder,
  banner,
  footer,
  onQuoteClick,
  onFeedback,
  onOpen,
}: StageProps) {
  const now = useTrayClock(cards);
  const { stack, tray } = useMemo(() => arrangeCards(cards, now), [cards, now]);
  const [trayOpen, setTrayOpen] = useState(false);

  return (
    <section className="stage-area">
      <main className="stage" data-testid="stage">
        {banner}
        {cards.length === 0 ? (
          placeholder
        ) : (
          <div className="stage__cards" data-testid="stage-cards">
            {stack.map((card) => (
              <Card
                key={card.id}
                card={card}
                onQuoteClick={onQuoteClick}
                onFeedback={onFeedback}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
        {tray.length > 0 && (
          <div className="stage__tray" data-testid="stage-tray">
            <button
              type="button"
              className="stage__tray-toggle"
              data-testid="stage-tray-toggle"
              aria-expanded={trayOpen}
              onClick={() => setTrayOpen((open) => !open)}
            >
              {trayLabel(tray.length)} <span aria-hidden="true">{trayOpen ? "▴" : "▾"}</span>
            </button>
            {trayOpen && (
              <div className="stage__tray-cards" data-testid="stage-tray-cards">
                {tray.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    onQuoteClick={onQuoteClick}
                    onFeedback={onFeedback}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {/* V3-016: below the cards and below the tray, because it is the
            quietest thing on the stage — what Sotto noticed and kept to
            itself, with the policy's own reason. */}
        <AlmostSaid held={almostSaid} />
      </main>
      {footer}
    </section>
  );
}

/**
 * `Date.now()`, re-read only when the next glow is due to collapse.
 *
 * The stage has no clock of its own and needs none: the server's injected
 * `Clock` is about the conversation's timeline, and "two minutes on screen" is
 * about the reader's.
 */
function useTrayClock(cards: readonly StageCardView[]): number {
  const [now, setNow] = useState(() => Date.now());
  const due = nextTrayDueAt(cards, now);

  useEffect(() => {
    if (due === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(due - Date.now(), 0) + 50);
    return () => window.clearTimeout(timer);
  }, [due]);

  return now;
}
