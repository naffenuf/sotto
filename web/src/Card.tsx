/**
 * One card, in five variants (US-011, V2-009, V2-014).
 *
 * The headline carries the message and everything else is opt-in: the detail
 * is behind "details ▾", and a `glow` is a single muted line until somebody
 * opens it, at which point it becomes exactly the card an `interject` would
 * have been. That is why there is one component and not three — the policy
 * (US-014) picks the level, not the content.
 *
 * A `notice` (V2-009) is Sotto talking about itself rather than about the
 * conversation — the hello, the nudge for names, and a wrap-up nothing could
 * say out loud (V2-018). Same card, read at speaking size rather than
 * across-the-table size, with no label above it and no feedback buttons under
 * it: there was no decision to speak to have an opinion about. The wrap-up is
 * the one whose summary is shown rather than hidden behind "details ▾": the
 * summary is what was asked for.
 *
 * A `research` card (V2-014) is a finished background search. Closed, it is
 * "Research ready: …" and the teaser; open, it is the key points, the visual
 * the search drew and the sources — all of it at once, because one click is
 * the whole interaction. Like a notice it carries no feedback buttons: the
 * server only files a verdict against a card the policy decided to deliver.
 * `forward` is one of those cards once somebody has *asked* about it
 * (V2-015): it opens itself and is accented, because Sotto is talking about
 * it as it arrives.
 *
 * Calm is a requirement, not a preference: no sound, no modal, nothing that
 * moves except the thinking indicator.
 */
import { useEffect, useRef, useState } from "react";
import type { Block, Inline } from "./markdown.js";
import { parseMarkdown } from "./markdown.js";
import {
  NOTICE_CARD_IDS,
  feedbackVerdicts,
  isKnowledgeCitation,
  type CardArtifact,
  type FeedbackVerdict,
  type StageCard,
} from "../../shared/index.js";

/** The label above an interjection — Sotto raising its hand, quietly. */
const NOTICED = "Sotto noticed…";

/** The label above an opened research card (V2-014). */
const RESEARCHED = "Sotto looked this up…";

/**
 * Whether this card's markdown *is* the card rather than an aside behind
 * "details ▾".
 *
 * A research card's key points (V2-014), a wrap-up's summary (V2-018) and the
 * ideas a stuck group asked to hear (V3-007) are all the thing somebody
 * wanted to see: "Where we got to" with the summary hidden is a card that
 * says nothing. The hello and the name nudge are the other way round — a
 * headline, with the how-to tucked away.
 */
function detailIsTheCard(card: StageCard): boolean {
  if (card.variant === "research") return true;
  return (
    card.id.startsWith(NOTICE_CARD_IDS.wrapUp) || card.id.startsWith(NOTICE_CARD_IDS.ideas)
  );
}

/**
 * The one line a collapsed card shows.
 *
 * The headline where there is one; "thinking…" while one is on its way; and
 * the message when there will not be one — a research card whose search came
 * back with nothing (V3-003) is still a button somebody can click, and a
 * blank one would say nothing at all.
 */
function collapsedLine(card: StageCard): string {
  if (card.headline !== "") return card.headline;
  if (card.state === "thinking") return "thinking…";
  return card.message ?? "";
}

/** The variants that are one line until somebody opens them. */
function isCollapsible(variant: StageCard["variant"]): boolean {
  return variant === "glow" || variant === "research";
}

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
  /**
   * The reader has opened this card (V3-017), so whatever Sotto was holding
   * in it has been heard from and the raised hand stops counting it.
   *
   * Only ever called for a card the reader actually expanded: a card that
   * arrives already open was not opened by anybody.
   */
  onOpen?: ((card: StageCard) => void) | undefined;
}

export function Card({
  card,
  defaultExpanded = false,
  onQuoteClick,
  onFeedback,
  onOpen,
}: CardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded || card.forward === true);
  // V2-015: somebody asked for this research, so it opens where it stands —
  // the card is already on the stage, collapsed, when the question arrives.
  // Still collapsible afterwards: the reader keeps the last word on it.
  const forward = card.forward === true;
  useEffect(() => {
    if (forward) setExpanded(true);
  }, [forward]);

  if (isCollapsible(card.variant) && !expanded) {
    const research = card.variant === "research";
    return (
      <button
        type="button"
        className={`card card--${card.variant} card--collapsed`}
        data-testid="card"
        data-variant={card.variant}
        data-state={card.state}
        data-expanded="false"
        aria-expanded={false}
        onClick={() => {
          setExpanded(true);
          onOpen?.(card);
        }}
        title={research ? "Open what Sotto found" : "Open this quiet thought"}
      >
        <span className={research ? "card__research-mark" : "card__glow-dot"} aria-hidden="true">
          {research ? "⌕" : null}
        </span>
        <span className="card__collapsed-lines">
          <span className="card__glow-line" data-testid="card-headline">
            {collapsedLine(card)}
          </span>
          <Note card={card} />
          <Teaser card={card} />
        </span>
        {card.state === "thinking" && <Thinking />}
      </button>
    );
  }

  return (
    <article
      className={`card card--${card.variant}${forward ? " card--forward" : ""}`}
      data-testid="card"
      data-variant={card.variant}
      data-state={card.state}
      data-expanded={isCollapsible(card.variant) ? "true" : undefined}
    >
      <CardLabel card={card} onCollapse={() => setExpanded(false)} />
      <Headline card={card} />
      <Note card={card} />
      <Teaser card={card} />
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
          <Artifacts card={card} />
          <Details card={card} inline={detailIsTheCard(card)} />
          <Spoken card={card} />
          <Sources card={card} />
        </>
      )}
      <Feedback card={card} onFeedback={onFeedback} />
    </article>
  );
}

/** The line above the headline: the question for an answer, the label otherwise. */
function CardLabel({ card, onCollapse }: { card: StageCard; onCollapse: () => void }) {
  // A `notice` is Sotto talking about itself (V2-009), so "Sotto noticed…"
  // would be the wrong label and there is nothing else worth putting there.
  if (card.variant === "notice") return null;
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
  // A card the reader opened keeps a way back, so the stage can go quiet again.
  if (isCollapsible(card.variant)) {
    return (
      <button
        type="button"
        className="card__label card__label--button"
        data-testid="card-collapse"
        aria-expanded
        onClick={onCollapse}
      >
        {card.variant === "research" ? RESEARCHED : NOTICED}{" "}
        <span aria-hidden="true">▴</span>
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
  // Not on an answer (US-018) and not on a notice (V2-009): the verdicts are
  // about an interjection *call* — "useful", "not useful", "wrong moment" are
  // what the policy (US-014) learns from — and the server only records one
  // against a card it decided to deliver, so a button here would have nothing
  // to file.
  if (card.variant === "answer" || card.variant === "notice" || card.variant === "research") {
    return null;
  }
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

/**
 * The HTML the model drew, in a frame it cannot get out of (US-020).
 *
 * `sandbox="allow-scripts"` **without** `allow-same-origin` is the whole
 * point: the document may animate itself and may not touch this page, its
 * origin, its storage or its cookies. The server serves it with a CSP that
 * blocks every request it could make. The page never sees the markup — only
 * the URL — so there is nothing here to inject.
 */
function Artifacts({ card }: { card: StageCard }) {
  const artifacts = card.artifacts ?? [];
  if (artifacts.length === 0) return null;
  return (
    <div className="card__artifacts" data-testid="card-artifacts">
      {artifacts.map((artifact) => (
        <ArtifactFrame key={artifact.url} artifact={artifact} />
      ))}
    </div>
  );
}

function ArtifactFrame({ artifact }: { artifact: CardArtifact }) {
  const frame = useRef<HTMLDivElement>(null);
  return (
    <figure className="card__artifact" data-testid="card-artifact" ref={frame}>
      <figcaption className="card__artifact-bar">
        <span className="card__artifact-title" data-testid="card-artifact-title">
          {artifact.title}
        </span>
        <button
          type="button"
          className="card__artifact-full"
          data-testid="card-artifact-fullscreen"
          title="Open full screen"
          onClick={() => {
            // The *frame* goes full screen, not the document inside it: the
            // iframe is a foreign origin and cannot ask for this itself.
            const element = frame.current;
            if (element === null) return;
            if (document.fullscreenElement === element) void document.exitFullscreen();
            else void element.requestFullscreen?.();
          }}
        >
          open full screen
        </button>
      </figcaption>
      <iframe
        className="card__artifact-frame"
        data-testid="card-artifact-frame"
        title={artifact.title}
        src={artifact.url}
        sandbox="allow-scripts"
        loading="lazy"
      />
    </figure>
  );
}

/**
 * The one line about a card's own standing (V3-004, V3-013).
 *
 * Shown closed as well as open, above the teaser: when somebody in the room
 * answered the question first, whether the search agrees with them is the
 * thing worth reading, and it is the only thing said about it — nothing was
 * spoken. The same line says what decision a correction of Sotto's own is
 * still open against, which is why that card has just come to the top.
 */
function Note({ card }: { card: StageCard }) {
  const note = card.note ?? "";
  if (note.trim() === "") return null;
  return (
    <span className="card__note" data-testid="card-note">
      {note}
    </span>
  );
}

/**
 * The one or two sentences under a research card's headline (V2-014).
 *
 * Shown closed as well as open, because it is what somebody reads before
 * deciding whether to open the rest.
 */
function Teaser({ card }: { card: StageCard }) {
  const teaser = card.teaser ?? "";
  if (teaser.trim() === "") return null;
  return (
    <span className="card__teaser" data-testid="card-teaser">
      {teaser}
    </span>
  );
}

/**
 * "details ▾", and the markdown it opens — or the markdown on its own.
 *
 * `inline` is the research card (V2-014): opening it is the one click, so its
 * key points are not behind a second toggle.
 */
function Details({ card, inline = false }: { card: StageCard; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const detail = card.detailMd ?? "";
  if (detail.trim() === "") return null;
  if (inline) {
    return (
      <div className="card__markdown card__markdown--inline" data-testid="card-details">
        <Markdown source={detail} />
      </div>
    );
  }
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

/**
 * What Sotto said out loud, for anybody who missed it (V2-005).
 *
 * Folded away like the detail, and for the same reason: the room already heard
 * this, so it is there to be gone back to rather than read. It is plain text,
 * not markdown — the spoken half is written to be heard, so there is no
 * markdown in it to parse.
 */
function Spoken({ card }: { card: StageCard }) {
  const [open, setOpen] = useState(false);
  const spoken = card.spokenText ?? "";
  if (spoken.trim() === "") return null;
  return (
    <div className="card__details">
      <button
        type="button"
        className="card__details-toggle"
        data-testid="card-spoken-toggle"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        transcript of answer <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <p className="card__spoken" data-testid="card-spoken">
          {spoken}
        </p>
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
          {/* V3-009: one of the group's own files has no page to open, so it
              is named rather than linked. */}
          {isKnowledgeCitation(citation.url) ? (
            <span className="card__source-file" data-testid="card-source-file">
              {citation.title === "" ? citation.url : citation.title}
            </span>
          ) : (
            <a
              className="card__source-link"
              href={citation.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {citation.title === "" ? citation.url : citation.title}
            </a>
          )}
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
