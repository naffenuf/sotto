/**
 * `board.md`: the board as something a person reads after the session (US-008).
 *
 * The file is a plain checklist, not a dump — `board.json` beside it keeps the
 * ids, timestamps and source turns. An open item is an empty checkbox, a
 * covered one is ticked, and a dropped one is struck through and left in place,
 * because what the group abandoned is part of the story of the conversation.
 *
 * Every section is written even when empty, so the file keeps the same shape
 * from the first update to the last and a diff of two sessions lines up.
 */
import { boardSections, type Board, type BoardSection, type Item } from "../../shared/board.js";

/** The heading each section gets. */
const sectionHeadings: Record<BoardSection, string> = {
  constraints: "Constraints",
  points: "Points",
  questions: "Open Questions",
  decisions: "Decisions",
};

/** Stands in for an empty section, so no heading is left dangling. */
const EMPTY = "_nothing yet_";

export function renderBoardMarkdown(board: Board): string {
  const blocks: string[] = ["# Board", "## Summary", board.summary.trim() || EMPTY];
  for (const section of boardSections) {
    blocks.push(`## ${sectionHeadings[section]}`);
    const items = board[section];
    blocks.push(items.length === 0 ? EMPTY : items.map(renderItem).join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

/** One checklist line. */
function renderItem(item: Item): string {
  const box = item.status === "covered" ? "- [x]" : "- [ ]";
  const text = item.status === "dropped" ? `~~${item.text}~~` : item.text;
  return `${box} ${text}`;
}
