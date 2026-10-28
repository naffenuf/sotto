/**
 * The pure part of the board panel (US-010): what each section is called, what
 * is on screen once dropped items are folded away, and how long ago the last
 * update was.
 *
 * It lives apart from `BoardPanel.tsx` so `npm test` can cover it in node,
 * the way `audio/resample.ts` is covered.
 */
import type { Board, BoardSection, Item } from "../../shared/index.js";
import { boardSections } from "../../shared/index.js";

/** The heading each section gets, in the order the panel shows them. */
export const SECTION_TITLES: Record<BoardSection, string> = {
  constraints: "Constraints",
  points: "Points",
  questions: "Open Questions",
  decisions: "Decisions",
};

/** The sections, in panel order: constraints first, because they are the limits. */
export const PANEL_SECTIONS: readonly BoardSection[] = boardSections;

/** How long a changed item stays highlighted before it fades back (US-010). */
export const HIGHLIGHT_MS = 3_000;

/** The items a section shows: everything, or everything still live. */
export function visibleItems(items: readonly Item[], showDropped: boolean): Item[] {
  return showDropped ? [...items] : items.filter((item) => item.status !== "dropped");
}

/** How many items the whole board has dropped — the number on the toggle. */
export function droppedCount(board: Board): number {
  return PANEL_SECTIONS.reduce(
    (total, section) => total + board[section].filter((item) => item.status === "dropped").length,
    0,
  );
}

/** True when the board has nothing on it at all, summary included. */
export function boardIsEmpty(board: Board): boolean {
  return board.summary === "" && PANEL_SECTIONS.every((section) => board[section].length === 0);
}

/**
 * How long ago the last update was, for the "updated 12s ago" line.
 *
 * Seconds up to a minute, then whole minutes: the point is to tell a stale
 * board from a fresh one at a glance, not to be a stopwatch. Anything under a
 * second (or a clock that went backwards) reads "just now".
 */
export function formatAgo(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
