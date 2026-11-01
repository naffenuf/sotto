/**
 * The board, under the transcript (US-010).
 *
 * The board arrives whole on every update, with the ids the update touched
 * alongside it, so the panel's only real work is to say what changed: those
 * items light up and fade back over {@link HIGHLIGHT_MS}, and the header says
 * how long ago the last update was — or spins, while one is out.
 *
 * Nothing is ever removed from the board, only dropped, so dropped items are
 * folded behind one toggle rather than left to clutter four sections.
 */
import { useEffect, useRef, useState } from "react";
import { Marked } from "./Marked.js";
import { matchesQuery } from "./search.js";
import type { Board, BoardSection, Item } from "../../shared/index.js";
import {
  HIGHLIGHT_MS,
  PANEL_SECTIONS,
  SECTION_TITLES,
  boardIsEmpty,
  droppedCount,
  formatAgo,
  visibleItems,
} from "./boardView.js";

/** How often the "updated 12s ago" line re-reads the clock. */
const TICK_MS = 1_000;

export interface BoardPanelProps {
  board: Board;
  /** Ids the latest update added or changed. */
  changedIds: readonly string[];
  /**
   * When the latest update reached the browser (`Date.now()`), or `0` when
   * there has not been one — which is what the header reads as "no update yet".
   */
  updatedAt: number;
  /** True while an update is in flight, so the header shows a spinner. */
  updating: boolean;
  historical?: boolean;
  /** Without its own title row: the fold it sits in carries the title and the freshness. */
  bare?: boolean;
  /** The transcript's normalized search text, so the same word lights up here. */
  query?: string;
}

export function BoardPanel({ board, changedIds, updatedAt, updating, historical = false, bare = false, query = "" }: BoardPanelProps) {
  const highlighted = useHighlight(changedIds, updatedAt);
  const [showDropped, setShowDropped] = useState(false);
  const dropped = droppedCount(board);

  // A board with no dropped items left must not leave the toggle on, or the
  // next dropped item appears without anyone asking for it.
  useEffect(() => {
    if (dropped === 0) setShowDropped(false);
  }, [dropped]);

  return (
    <section className="board" data-testid="board">
      {!bare && (
        <div className="board__header">
          <h2 className="panel__title">Summary</h2>
          {!historical && <BoardFreshness updatedAt={updatedAt} updating={updating} />}
        </div>
      )}
      <div className="board__body">
        {boardIsEmpty(board) ? (
          <p className="board__empty" data-testid="board-empty">
            {updating
              ? "Reading the conversation…"
              : "Notes will appear as the group talks."}
          </p>
        ) : (
          <>
            {board.summary !== "" && (
              <p className="board__summary" data-testid="board-summary">
                <Marked text={board.summary} query={query} />
              </p>
            )}
            {PANEL_SECTIONS.map((section) => (
              <BoardSectionList
                key={section}
                section={section}
                items={visibleItems(board[section], showDropped)}
                highlighted={highlighted}
                query={query}
              />
            ))}
            {dropped > 0 && (
              <button
                type="button"
                className="board__dropped-toggle"
                data-testid="show-dropped"
                aria-pressed={showDropped}
                onClick={() => setShowDropped((shown) => !shown)}
              >
                {showDropped ? `hide dropped (${dropped})` : `show dropped (${dropped})`}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

interface BoardSectionListProps {
  section: BoardSection;
  items: readonly Item[];
  highlighted: ReadonlySet<string>;
  query: string;
}

/** One section. An empty one is left out rather than shown as a stub. */
function BoardSectionList({ section, items, highlighted, query }: BoardSectionListProps) {
  if (items.length === 0) return null;
  return (
    <div className="board__section" data-testid="board-section" data-section={section}>
      <h3 className="board__section-title">{SECTION_TITLES[section]}</h3>
      <ul className="board__items">
        {items.map((item) => (
          <li
            key={item.id}
            className={`board__item board__item--${item.status}${
              query !== "" && !matchesQuery(item.text, query) ? " board__item--dim" : ""
            }`}
            data-testid="board-item"
            data-match={query !== "" && matchesQuery(item.text, query) ? true : undefined}
            data-item-id={item.id}
            data-status={item.status}
            data-changed={highlighted.has(item.id)}
          >
            <span className="board__box" aria-hidden="true">
              {item.status === "open" ? "☐" : "☑"}
            </span>
            <span className="board__text">
              <Marked text={item.text} query={query} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface BoardFreshnessProps {
  updatedAt: number;
  updating: boolean;
}

/** "updated 12s ago", ticking, with a spinner while a call is out. */
export function BoardFreshness({ updatedAt, updating }: BoardFreshnessProps) {
  const ago = useAgo(updatedAt);

  return (
    <span className="board__freshness" data-testid="board-updated" data-updating={updating}>
      {updating && (
        <span className="board__spinner" data-testid="board-spinner" aria-hidden="true" />
      )}
      <span className="board__freshness-text">
        {updatedAt === 0 ? (updating ? "updating…" : "no update yet") : `updated ${ago}`}
      </span>
    </span>
  );
}

/**
 * The ids to light up: the latest update's, until {@link HIGHLIGHT_MS} has
 * passed.
 *
 * Keyed on `updatedAt` rather than on `changedIds`, because two updates in a
 * row can touch exactly the same items and the second one still has to light
 * them up again.
 */
function useHighlight(changedIds: readonly string[], updatedAt: number): ReadonlySet<string> {
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(new Set());
  // Read inside the effect so a new array with the same contents, which React
  // hands over on every render, does not restart the fade.
  const latest = useRef(changedIds);
  latest.current = changedIds;

  useEffect(() => {
    if (updatedAt === 0) {
      setHighlighted(new Set());
      return;
    }
    setHighlighted(new Set(latest.current));
    const timer = window.setTimeout(() => setHighlighted(new Set()), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [updatedAt]);

  return highlighted;
}

/** How long ago the last update was, re-read once a second. */
function useAgo(updatedAt: number): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (updatedAt === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [updatedAt]);

  return formatAgo(now - updatedAt);
}
