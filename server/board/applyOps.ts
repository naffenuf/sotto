/**
 * Folding a model's operations into the board (PRD US-009).
 *
 * Pure: `applyOps` copies what it touches and returns a new board, so the
 * previous one can be kept and compared. Three rules make the board stable
 * enough for the UI and for the interjection engine to point at:
 *
 * - **Ids never move.** A section numbers its items from 1 and never reuses a
 *   number, even after the item it belonged to is dropped.
 * - **Nothing is deleted.** The only way off the board is `status: "dropped"`.
 * - **A no-op is a no-op.** An operation naming an id that does not exist, or
 *   setting text to what it already says, changes nothing and is reported in
 *   `ignored` for the caller to log — a bad operation never throws away the
 *   good ones beside it.
 */
import {
  addOpSections,
  boardSections,
  sectionIdPrefixes,
  type AddOp,
  type Board,
  type BoardOp,
  type BoardSection,
  type Item,
} from "../../shared/board.js";

/** Why one operation changed nothing. */
export type IgnoredReason = "unknown id" | "blank text" | "unchanged";

/** An operation that was skipped, kept so the update loop can log it. */
export interface IgnoredOp {
  op: BoardOp;
  reason: IgnoredReason;
  /** The id the operation named, when it named one. */
  id?: string;
}

export interface ApplyOpsResult {
  /** The new board. The one passed in is untouched. */
  board: Board;
  /**
   * Ids of the items this call added or changed, in the order it touched them.
   * The board panel (US-010) highlights exactly these.
   */
  changedIds: string[];
  /** True when the summary was replaced with something different. */
  summaryChanged: boolean;
  /** Operations that changed nothing, and why. */
  ignored: IgnoredOp[];
}

/**
 * Applies `ops` to `board` in order, as of `nowMs` on the session clock.
 *
 * Later operations see the result of earlier ones, so a model may add an item
 * and cover it in the same update.
 */
export function applyOps(board: Board, ops: BoardOp[], nowMs: number): ApplyOpsResult {
  const next: Board = {
    summary: board.summary,
    constraints: [...board.constraints],
    points: [...board.points],
    questions: [...board.questions],
    decisions: [...board.decisions],
  };
  const changed: string[] = [];
  const ignored: IgnoredOp[] = [];
  let summaryChanged = false;

  const touched = (id: string): void => {
    if (!changed.includes(id)) changed.push(id);
  };

  for (const op of ops) {
    switch (op.op) {
      case "add_constraint":
      case "add_point":
      case "add_question":
      case "add_decision": {
        const text = normalizeText(op.text);
        if (text === "") {
          ignored.push({ op, reason: "blank text" });
          break;
        }
        const section = addOpSections[op.op];
        const item = newItem(section, next[section], text, op, nowMs);
        next[section] = [...next[section], item];
        touched(item.id);
        break;
      }
      case "set_status": {
        const found = find(next, op.id);
        if (found === null) {
          ignored.push({ op, reason: "unknown id", id: op.id });
          break;
        }
        if (found.item.status === op.status) {
          ignored.push({ op, reason: "unchanged", id: op.id });
          break;
        }
        replace(next, found, { ...found.item, status: op.status, updatedAtMs: nowMs });
        touched(op.id);
        break;
      }
      case "edit_text": {
        const text = normalizeText(op.text);
        if (text === "") {
          ignored.push({ op, reason: "blank text", id: op.id });
          break;
        }
        const found = find(next, op.id);
        if (found === null) {
          ignored.push({ op, reason: "unknown id", id: op.id });
          break;
        }
        if (found.item.text === text) {
          ignored.push({ op, reason: "unchanged", id: op.id });
          break;
        }
        replace(next, found, { ...found.item, text, updatedAtMs: nowMs });
        touched(op.id);
        break;
      }
      case "set_summary": {
        const text = normalizeText(op.text);
        if (text === "") {
          ignored.push({ op, reason: "blank text" });
          break;
        }
        if (text === next.summary) {
          ignored.push({ op, reason: "unchanged" });
          break;
        }
        next.summary = text;
        summaryChanged = true;
        break;
      }
    }
  }

  return { board: next, changedIds: changed, summaryChanged, ignored };
}

/** Where an item sits, so it can be written back without searching twice. */
interface Found {
  section: BoardSection;
  index: number;
  item: Item;
}

function find(board: Board, id: string): Found | null {
  for (const section of boardSections) {
    const index = board[section].findIndex((item) => item.id === id);
    if (index !== -1) return { section, index, item: board[section][index]! };
  }
  return null;
}

function replace(board: Board, at: Found, item: Item): void {
  const items = [...board[at.section]];
  items[at.index] = item;
  board[at.section] = items;
}

function newItem(
  section: BoardSection,
  items: Item[],
  text: string,
  op: AddOp,
  nowMs: number,
): Item {
  return {
    id: nextId(section, items),
    text,
    status: "open",
    sourceTurnIds: [...new Set(op.sourceTurnIds.map((id) => id.trim()).filter((id) => id !== ""))],
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

/**
 * The next free id in a section: one past the highest number it has ever
 * handed out, so a dropped `p3` is never reborn as somebody else.
 */
function nextId(section: BoardSection, items: Item[]): string {
  const prefix = sectionIdPrefixes[section];
  let highest = 0;
  for (const item of items) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(item.id);
    if (match === null) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}${highest + 1}`;
}

/** Items are one line of text: collapse whitespace, drop the edges. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
