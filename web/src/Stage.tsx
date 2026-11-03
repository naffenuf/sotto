/**
 * The stage: the one large area where everything Sotto contributes shows up
 * (US-011), in three zones that read as Sotto's present state.
 *
 *   - **Now** (`now`): what it is doing this second — listening, looking
 *     something up, waiting for a gap, speaking. The one part that moves.
 *   - **Holding**: the raised hand (V3-017) as the cards themselves, one line
 *     each. Opening one is calling on it: it leaves this zone and is read in
 *     full in the next.
 *   - **Said**: what Sotto already put into the meeting, newest on top, each
 *     marked when the room heard it. Glows age out of this stack into a tray
 *     rather than being dismissed — {@link arrangeCards} decides which are
 *     which and `nextTrayDueAt` means the timer only runs while one is ageing.
 *
 * Under all of it sits the "almost said" tray (V3-016): the things that never
 * became cards at all.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlmostSaid } from "./AlmostSaid.js";
import { Card, KIND_LABEL } from "./Card.js";
import type { StageCardView } from "./stageView.js";
import { CALL_ON_HINT } from "./RaisedHand.js";
import { arrangeCards, nextTrayDueAt, saidCards, trayLabel } from "./stageView.js";
import type { FeedbackVerdict, StageCard, SuppressedCandidate } from "../../shared/index.js";

export interface StageProps {
  cards: readonly StageCardView[];
  /**
   * What the policy held back this session (V3-016), shown collapsed under
   * the cards. Restraint is part of what the stage is reporting.
   */
  almostSaid?: readonly SuppressedCandidate[];
  /** The Now zone, already rendered: what Sotto is doing this second. */
  now?: ReactNode;
  /** What Sotto is holding and has not said (V3-017), newest first. */
  held?: readonly StageCardView[];
  /** The cards the reader opened, which are read in full where they land. */
  opened?: ReadonlySet<string>;
  /** The card the Now zone is showing on its way, so Said does not show it twice. */
  inNow?: string | undefined;
  /** "seen": the reader has heard from all of it, and the hand goes down. */
  onSeenAll?: (() => void) | undefined;
  /** Whether the room heard a card, for the mark beside its kind. */
  spokenMark?: ((card: StageCard) => "spoken" | "interrupted" | null) | undefined;
  /** Shown above the zones, whatever else is on the stage: problems, notes. */
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
  now: nowZone,
  held = [],
  opened,
  inNow,
  onSeenAll,
  spokenMark,
  banner,
  footer,
  onQuoteClick,
  onFeedback,
  onOpen,
}: StageProps) {
  const now = useTrayClock(cards);
  const { stack, tray } = useMemo(() => arrangeCards(cards, now), [cards, now]);
  const said = useMemo(() => saidCards(stack, held, inNow), [stack, held, inNow]);
  const [trayOpen, setTrayOpen] = useState(false);

  return (
    <section className="stage-area">
      <main className="stage" data-testid="stage">
        {banner}
        {nowZone !== undefined && (
          <div className="zone zone--now" data-testid="zone-now">
            <p className="zone__label">Now</p>
            {nowZone}
          </div>
        )}
        {held.length > 0 && (
          <div
            className="zone zone--holding"
            data-testid="raised-hand"
            data-count={held.length}
            title={`Sotto is holding ${held.length} thing${held.length === 1 ? "" : "s"} it has not said — ${CALL_ON_HINT}`}
          >
            <p className="zone__label">
              <span>Holding</span>
              <small>
                <span data-testid="raised-hand-count">{held.length}</span>
                {held.length === 1 ? " thing" : " things"} · {CALL_ON_HINT}, or open one
                {onSeenAll !== undefined && (
                  <>
                    {" · "}
                    <button type="button" className="zone__seen" data-testid="raised-hand-clear" onClick={onSeenAll}>
                      seen
                    </button>
                  </>
                )}
              </small>
            </p>
            <div className="holding" data-testid="holding">
              {held.map((card) => (
                <Held key={card.id} card={card} onOpen={onOpen} />
              ))}
            </div>
          </div>
        )}
        {said.length > 0 && (
          <div className="zone zone--said" data-testid="zone-said">
            <p className="zone__label">Said</p>
            <div className="stage__cards" data-testid="stage-cards">
              {said.map((card) => (
                <Card
                  key={card.id}
                  card={card}
                  defaultExpanded={opened?.has(card.id) === true}
                  spoken={spokenMark?.(card) ?? null}
                  onQuoteClick={onQuoteClick}
                  onFeedback={onFeedback}
                  onOpen={onOpen}
                />
              ))}
            </div>
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
 * One thing Sotto is holding: its kind and its line, as a button. Opening it
 * is the room calling on it — it leaves this zone and is read in full in
 * Said, which is where {@link StageProps.opened} comes in.
 */
function Held({
  card,
  onOpen,
}: {
  card: StageCardView;
  onOpen?: ((card: StageCard) => void) | undefined;
}) {
  const line = card.headline !== "" ? card.headline : card.state === "thinking" ? "thinking…" : (card.message ?? "");
  return (
    <button
      type="button"
      className={`held card--${card.variant}`}
      data-testid="held-card"
      data-variant={card.variant}
      title="Open this — Sotto has not said it out loud"
      onClick={() => onOpen?.(card)}
    >
      <span className="card__kind">{KIND_LABEL[card.variant]}</span>
      <span className="held__line">{line}</span>
      {card.note !== undefined && card.note !== "" && <span className="held__note">{card.note}</span>}
    </button>
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
