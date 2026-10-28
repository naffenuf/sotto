/**
 * One card, in three variants (US-011).
 *
 * The headline carries the message and everything else is opt-in: the detail
 * is behind "details ▾", and a `glow` is a single muted line until somebody
 * opens it, at which point it becomes exactly the card an `interject` would
 * have been. That is why there is one component and not three — the policy
 * (US-014) picks the level, not the content.
 *
 * Calm is a requirement, not a preference: no sound, no modal, nothing that
 * moves except the thinking indicator.
 */
import { useState } from "react";
import type { Block, Inline } from "./markdown.js";
import { parseMarkdown } from "./markdown.js";
import { feedbackVerdicts, type FeedbackVerdict, type StageCard } from "../../shared/index.js";

/** The label above an interjection — Sotto raising its hand, quietly. */
const NOTICED = "Sotto noticed…";

/** The three buttons under a delivered card (US-015), in the PRD's order. */
const FEEDBACK: Readonly<Record<FeedbackVerdict, { icon: string; label: string }>> = {
  useful: { icon: "👍", label: "useful" },
  not_useful: { icon: "👎", label: "not useful" },
  wrong_moment: { icon: "⏱", label: "wrong moment" },
};

export interface CardProps {
  card: StageCard;
  /** A `glow` starts collapsed; this opens it without touching the card. */
  defaultExpanded?: boolean;
  /**
   * Scrolls the transcript to one of the evidence quotes' turns and
   * highlights it (US-015). Absent on a page with no transcript beside it,
   * which leaves the quotes as plain text.
   */
  onQuoteClick?: ((turnId: string) => void) | undefined;
  /**
   * Files the group's verdict on this card. Absent means no buttons: a card
   * nobody can give an opinion on is better than one whose buttons do nothing.
   */
  onFeedback?: ((card: StageCard, verdict: FeedbackVerdict) => void) | undefined;
}

export function Card({
  card,
  defaultExpanded = false,
  onQuoteClick,
  onFeedback,
}: CardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const glowCollapsed = card.variant === "glow" && !expanded;

  if (glowCollapsed) {
    return (
      <button
        type="button"
        className="card card--glow card--collapsed"
        data-testid="card"
        data-variant="glow"
        data-state={card.state}
        data-expanded="false"
        aria-expanded={false}
        onClick={() => setExpanded(true)}
        title="Open this quiet thought"
      >
        <span className="card__glow-dot" aria-hidden="true" />
        <span className="card__glow-line" data-testid="card-headline">
          {card.state === "thinking" && card.headline === "" ? "thinking…" : card.headline}
        </span>
        {card.state === "thinking" && <Thinking />}
      </button>
    );
  }

  return (
    <article
      className={`card card--${card.variant}`}
      data-testid="card"
      data-variant={card.variant}
      data-state={card.state}
      data-expanded={card.variant === "glow" ? "true" : undefined}
    >
      <CardLabel card={card} onCollapse={() => setExpanded(false)} />
      <Headline card={card} />
      {card.whyNow !== undefined && card.whyNow !== "" && (
        <p className="card__why" data-testid="card-why">
          <span className="card__why-label">why now</span> {card.whyNow}
        </p>
      )}
      {card.state === "error" ? (
        <p className="card__error" data-testid="card-error">
          {card.message ?? "Sotto could not finish this one."}
        </p>
      ) : (
        <>
          <Evidence card={card} onQuoteClick={onQuoteClick} />
          <Details card={card} />
          <Sources card={card} />
        </>
      )}
      <Feedback card={card} onFeedback={onFeedback} />
    </article>
  );
}

/** The line above the headline: the question for an answer, the label otherwise. */
function CardLabel({ card, onCollapse }: { card: StageCard; onCollapse: () => void }) {
  if (card.variant === "answer") {
    if (card.question === undefined || card.question === "") return null;
    return (
      <p className="card__ask" data-testid="card-question">
        <span className="card__question">{card.question}</span>
        {card.askedBy !== undefined && card.askedBy !== "" && (
          <span className="card__asker" data-testid="card-asker">
            {card.askedBy}
          </span>
        )}
      </p>
    );
  }
  // A glow the reader opened keeps a way back, so the stage can go quiet again.
  if (card.variant === "glow") {
    return (
      <button
        type="button"
        className="card__label card__label--button"
        data-testid="card-collapse"
        aria-expanded
        onClick={onCollapse}
      >
        {NOTICED} <span aria-hidden="true">▴</span>
      </button>
    );
  }
  return (
    <p className="card__label" data-testid="card-label">
      {NOTICED}
    </p>
  );
}

/** The headline, with the thinking indicator beside it while more is coming. */
function Headline({ card }: { card: StageCard }) {
  const thinking = card.state === "thinking";
  if (card.headline === "") {
    // A broken card that never got a headline says so in its message; a blank
    // line above it would only be one more thing to read.
    if (!thinking) return null;
    return (
      <p className="card__pending" data-testid="card-headline">
        <Thinking label="thinking" />
      </p>
    );
  }
  return (
    <h2 className="card__headline" data-testid="card-headline">
      {card.headline}
      {thinking && <Thinking />}
    </h2>
  );
}

/** Three dots that fade in turn. The only moving thing on the stage. */
function Thinking({ label }: { label?: string }) {
  return (
    <span className="card__thinking" data-testid="card-thinking" role="status">
      {label !== undefined && <span className="card__thinking-label">{label}</span>}
      <span className="card__dot" />
      <span className="card__dot" />
      <span className="card__dot" />
    </span>
  );
}

/**
 * The quotes an interjection rests on, attributed where the speaker is known.
 *
 * A quote is a button when there is a transcript to scroll: the fastest way
 * to disagree with Sotto is to go and read what was actually said, so one
 * click puts the cited turn on screen and highlights it (US-015).
 */
function Evidence({
  card,
  onQuoteClick,
}: {
  card: StageCard;
  onQuoteClick?: ((turnId: string) => void) | undefined;
}) {
  const quotes = card.evidence ?? [];
  if (quotes.length === 0) return null;
  return (
    <ul className="card__evidence" data-testid="card-evidence">
      {quotes.map((one) => {
        const body = (
          <>
            <span className="card__quote-text">“{one.quote}”</span>
            {one.speaker !== undefined && one.speaker !== "" && (
              <span className="card__quote-speaker">— {one.speaker}</span>
            )}
          </>
        );
        return (
          <li
            key={`${one.turnId}:${one.quote}`}
            className="card__quote"
            data-testid="card-quote"
            data-turn-id={one.turnId}
          >
            {onQuoteClick === undefined ? (
              body
            ) : (
              <button
                type="button"
                className="card__quote-button"
                data-testid="card-quote-link"
                title="Show this in the transcript"
                onClick={() => onQuoteClick(one.turnId)}
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 👍 / 👎 / ⏱, and nothing after the click but the button staying pressed.
 *
 * The verdict is the only thing this page does that Sotto learns from, so it
 * has to cost one click and no confirmation. A second click changes the
 * verdict: the file keeps both lines, and the later one is what was meant.
 */
function Feedback({
  card,
  onFeedback,
}: {
  card: StageCard;
  onFeedback?: ((card: StageCard, verdict: FeedbackVerdict) => void) | undefined;
}) {
  const [chosen, setChosen] = useState<FeedbackVerdict | null>(null);
  if (onFeedback === undefined) return null;
  return (
    <div className="card__feedback" data-testid="card-feedback">
      {feedbackVerdicts.map((verdict) => (
        <button
          key={verdict}
          type="button"
          className="card__feedback-button"
          data-testid={`card-feedback-${verdict}`}
          data-chosen={verdict === chosen}
          aria-pressed={verdict === chosen}
          title={FEEDBACK[verdict].label}
          onClick={() => {
            setChosen(verdict);
            onFeedback(card, verdict);
          }}
        >
          <span aria-hidden="true">{FEEDBACK[verdict].icon}</span>
          <span className="card__feedback-label">{FEEDBACK[verdict].label}</span>
        </button>
      ))}
    </div>
  );
}

/** "details ▾", and the markdown it opens. */
function Details({ card }: { card: StageCard }) {
  const [open, setOpen] = useState(false);
  const detail = card.detailMd ?? "";
  if (detail.trim() === "") return null;
  return (
    <div className="card__details">
      <button
        type="button"
        className="card__details-toggle"
        data-testid="card-details-toggle"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        details <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="card__markdown" data-testid="card-details">
          <Markdown source={detail} />
        </div>
      )}
    </div>
  );
}

/** The numbered sources, matching the `[1]` markers a model writes inline. */
function Sources({ card }: { card: StageCard }) {
  const citations = card.citations ?? [];
  if (citations.length === 0) return null;
  return (
    <ol className="card__sources" data-testid="card-sources">
      {citations.map((citation, index) => (
        <li key={citation.url} className="card__source" data-testid="card-source">
          <span className="card__source-number" aria-hidden="true">
            [{index + 1}]
          </span>
          <a
            className="card__source-link"
            href={citation.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {citation.title === "" ? citation.url : citation.title}
          </a>
        </li>
      ))}
    </ol>
  );
}

/** The parsed markdown, as elements. */
function Markdown({ source }: { source: string }) {
  return (
    <>
      {parseMarkdown(source).map((block, index) => (
        <MarkdownBlock key={index} block={block} />
      ))}
    </>
  );
}

function MarkdownBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="md__p">
          <Spans spans={block.spans} />
        </p>
      );
    case "heading": {
      const Tag = `h${block.level + 2}` as "h3" | "h4" | "h5";
      return (
        <Tag className="md__h">
          <Spans spans={block.spans} />
        </Tag>
      );
    }
    case "bullets":
      return (
        <ul className="md__ul">
          {block.items.map((item, index) => (
            <li key={index}>
              <Spans spans={item} />
            </li>
          ))}
        </ul>
      );
    case "numbers":
      return (
        <ol className="md__ol">
          {block.items.map((item, index) => (
            <li key={index}>
              <Spans spans={item} />
            </li>
          ))}
        </ol>
      );
  }
}

function Spans({ spans }: { spans: readonly Inline[] }) {
  return (
    <>
      {spans.map((span, index) => {
        switch (span.kind) {
          case "strong":
            return <strong key={index}>{span.text}</strong>;
          case "em":
            return <em key={index}>{span.text}</em>;
          case "code":
            return (
              <code key={index} className="md__code">
                {span.text}
              </code>
            );
          case "link":
            return (
              <a key={index} href={span.href} target="_blank" rel="noreferrer noopener">
                {span.text}
              </a>
            );
          case "text":
            return <span key={index}>{span.text}</span>;
        }
      })}
    </>
  );
}
