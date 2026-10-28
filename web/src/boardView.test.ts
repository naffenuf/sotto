import { describe, expect, it } from "vitest";
import { emptyBoard, type Board, type Item, type ItemStatus } from "../../shared/index.js";
import {
  PANEL_SECTIONS,
  SECTION_TITLES,
  boardIsEmpty,
  droppedCount,
  formatAgo,
  visibleItems,
} from "./boardView.js";

function item(id: string, status: ItemStatus): Item {
  return { id, text: id, status, sourceTurnIds: [], createdAtMs: 0, updatedAtMs: 0 };
}

function board(overrides: Partial<Board> = {}): Board {
  return { ...emptyBoard(), ...overrides };
}

describe("PANEL_SECTIONS", () => {
  it("names every section, constraints first", () => {
    expect(PANEL_SECTIONS[0]).toBe("constraints");
    for (const section of PANEL_SECTIONS) expect(SECTION_TITLES[section]).toBeTruthy();
  });
});

describe("visibleItems", () => {
  const items = [item("p1", "open"), item("p2", "dropped"), item("p3", "covered")];

  it("folds dropped items away by default", () => {
    expect(visibleItems(items, false).map((one) => one.id)).toEqual(["p1", "p3"]);
  });

  it("shows them all when the toggle is on, in board order", () => {
    expect(visibleItems(items, true).map((one) => one.id)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("droppedCount", () => {
  it("counts dropped items across every section", () => {
    expect(
      droppedCount(
        board({
          constraints: [item("c1", "dropped")],
          points: [item("p1", "open"), item("p2", "dropped")],
          questions: [item("q1", "covered")],
          decisions: [item("d1", "dropped")],
        }),
      ),
    ).toBe(3);
  });

  it("is zero for an empty board", () => {
    expect(droppedCount(emptyBoard())).toBe(0);
  });
});

describe("boardIsEmpty", () => {
  it("is true before the first update", () => {
    expect(boardIsEmpty(emptyBoard())).toBe(true);
  });

  it("is false once there is a summary, even with no items", () => {
    expect(boardIsEmpty(board({ summary: "Pricing for a solo plan." }))).toBe(false);
  });

  it("is false once there is an item, even a dropped one", () => {
    expect(boardIsEmpty(board({ points: [item("p1", "dropped")] }))).toBe(false);
  });
});

describe("formatAgo", () => {
  it("reads 'just now' under a second, and for a clock that went backwards", () => {
    expect(formatAgo(0)).toBe("just now");
    expect(formatAgo(999)).toBe("just now");
    expect(formatAgo(-5_000)).toBe("just now");
  });

  it("counts whole seconds up to a minute", () => {
    expect(formatAgo(12_400)).toBe("12s ago");
    expect(formatAgo(59_999)).toBe("59s ago");
  });

  it("switches to minutes, then hours", () => {
    expect(formatAgo(60_000)).toBe("1m ago");
    expect(formatAgo(45 * 60_000)).toBe("45m ago");
    expect(formatAgo(60 * 60_000)).toBe("1h ago");
  });
});
