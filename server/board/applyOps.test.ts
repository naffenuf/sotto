import { describe, expect, it } from "vitest";
import { emptyBoard, type Board, type BoardOp } from "../../shared/board.js";
import { applyOps } from "./applyOps.js";

/** Applies ops to a fresh board and hands back just the board. */
function board(ops: BoardOp[], nowMs = 1_000): Board {
  return applyOps(emptyBoard(), ops, nowMs).board;
}

const add = (op: BoardOp["op"], text: string, sourceTurnIds: string[] = ["0:1"]) =>
  ({ op, text, sourceTurnIds }) as BoardOp;

/** One of each kind of item, so the later tests have ids to aim at. */
const starter: BoardOp[] = [
  add("add_constraint", "under $20k"),
  add("add_point", "start with the mobile app"),
  add("add_question", "who signs this off?"),
  add("add_decision", "ship the pilot in March"),
];

describe("applyOps", () => {
  it("adds an item to each section with a stable id and timestamps", () => {
    const result = applyOps(emptyBoard(), starter, 5_000);
    expect(result.board.constraints[0]).toEqual({
      id: "c1",
      text: "under $20k",
      status: "open",
      sourceTurnIds: ["0:1"],
      createdAtMs: 5_000,
      updatedAtMs: 5_000,
    });
    expect(result.board.points[0]!.id).toBe("p1");
    expect(result.board.questions[0]!.id).toBe("q1");
    expect(result.board.decisions[0]!.id).toBe("d1");
    expect(result.changedIds).toEqual(["c1", "p1", "q1", "d1"]);
    expect(result.ignored).toEqual([]);
  });

  it("numbers each section independently and keeps counting across updates", () => {
    const first = applyOps(emptyBoard(), [add("add_point", "one"), add("add_point", "two")], 0);
    const second = applyOps(first.board, [add("add_point", "three"), add("add_question", "why?")], 10);
    expect(second.board.points.map((item) => item.id)).toEqual(["p1", "p2", "p3"]);
    expect(second.board.questions.map((item) => item.id)).toEqual(["q1"]);
  });

  it("never reuses the id of a dropped item", () => {
    const added = applyOps(emptyBoard(), [add("add_point", "one"), add("add_point", "two")], 0);
    const dropped = applyOps(added.board, [{ op: "set_status", id: "p2", status: "dropped" }], 10);
    const again = applyOps(dropped.board, [add("add_point", "three")], 20);
    expect(again.board.points.map((item) => item.id)).toEqual(["p1", "p2", "p3"]);
    expect(again.board.points[1]!.text).toBe("two");
  });

  it("collapses whitespace and drops blank adds", () => {
    const result = applyOps(emptyBoard(), [add("add_point", "  two   lines\nhere "), add("add_point", "   ")], 0);
    expect(result.board.points).toHaveLength(1);
    expect(result.board.points[0]!.text).toBe("two lines here");
    expect(result.ignored).toEqual([{ op: add("add_point", "   "), reason: "blank text" }]);
  });

  it("deduplicates and trims source turn ids", () => {
    const result = board([add("add_point", "one", ["0:1", " 0:1 ", "", "0:2"])]);
    expect(result.points[0]!.sourceTurnIds).toEqual(["0:1", "0:2"]);
  });

  it("sets a status without deleting anything", () => {
    const base = applyOps(emptyBoard(), starter, 0).board;
    const result = applyOps(base, [
      { op: "set_status", id: "q1", status: "covered" },
      { op: "set_status", id: "p1", status: "dropped" },
    ], 7_000);
    expect(result.board.questions[0]!.status).toBe("covered");
    expect(result.board.questions[0]!.updatedAtMs).toBe(7_000);
    expect(result.board.questions[0]!.createdAtMs).toBe(0);
    expect(result.board.points).toHaveLength(1);
    expect(result.board.points[0]!.status).toBe("dropped");
    expect(result.changedIds).toEqual(["q1", "p1"]);
  });

  it("edits text in place", () => {
    const base = applyOps(emptyBoard(), starter, 0).board;
    const result = applyOps(base, [{ op: "edit_text", id: "p1", text: "  start with mobile " }], 9_000);
    expect(result.board.points[0]).toEqual({
      id: "p1",
      text: "start with mobile",
      status: "open",
      sourceTurnIds: ["0:1"],
      createdAtMs: 0,
      updatedAtMs: 9_000,
    });
    expect(result.changedIds).toEqual(["p1"]);
  });

  it("sets the summary", () => {
    const result = applyOps(emptyBoard(), [{ op: "set_summary", text: " Scoping  a pilot. " }], 0);
    expect(result.board.summary).toBe("Scoping a pilot.");
    expect(result.summaryChanged).toBe(true);
    expect(result.changedIds).toEqual([]);
  });

  it("applies operations in order, so an item can be added and covered at once", () => {
    const result = applyOps(emptyBoard(), [
      add("add_question", "who signs this off?"),
      { op: "set_status", id: "q1", status: "covered" },
    ], 100);
    expect(result.board.questions[0]!.status).toBe("covered");
    expect(result.changedIds).toEqual(["q1"]);
  });

  it("ignores and reports unknown ids, and keeps the good operations beside them", () => {
    const base = applyOps(emptyBoard(), starter, 0).board;
    const result = applyOps(base, [
      { op: "set_status", id: "p9", status: "covered" },
      { op: "edit_text", id: "nonsense", text: "rewritten" },
      { op: "edit_text", id: "p1", text: "kept" },
    ], 500);
    expect(result.ignored).toEqual([
      { op: { op: "set_status", id: "p9", status: "covered" }, reason: "unknown id", id: "p9" },
      { op: { op: "edit_text", id: "nonsense", text: "rewritten" }, reason: "unknown id", id: "nonsense" },
    ]);
    expect(result.board.points[0]!.text).toBe("kept");
    expect(result.changedIds).toEqual(["p1"]);
    expect(result.board.points).toHaveLength(1);
  });

  it("reports a blank edit without clearing the item", () => {
    const base = applyOps(emptyBoard(), starter, 0).board;
    const result = applyOps(base, [{ op: "edit_text", id: "p1", text: " " }], 500);
    expect(result.board.points[0]!.text).toBe("start with the mobile app");
    expect(result.ignored).toEqual([
      { op: { op: "edit_text", id: "p1", text: " " }, reason: "blank text", id: "p1" },
    ]);
  });

  it("does not touch an item an operation leaves as it was", () => {
    const base = applyOps(emptyBoard(), starter, 0).board;
    const result = applyOps(base, [
      { op: "set_status", id: "p1", status: "open" },
      { op: "edit_text", id: "p1", text: "start with the mobile app" },
      { op: "set_summary", text: "" },
    ], 500);
    expect(result.board.points[0]!.updatedAtMs).toBe(0);
    expect(result.changedIds).toEqual([]);
    expect(result.summaryChanged).toBe(false);
    expect(result.ignored.map((entry) => entry.reason)).toEqual([
      "unchanged",
      "unchanged",
      "blank text",
    ]);
  });

  it("leaves the board it was given alone", () => {
    const base = applyOps(emptyBoard(), starter, 0).board;
    const snapshot = structuredClone(base);
    applyOps(base, [
      add("add_point", "another"),
      { op: "set_status", id: "p1", status: "dropped" },
      { op: "edit_text", id: "c1", text: "under $25k" },
      { op: "set_summary", text: "Changed." },
    ], 1_000);
    expect(base).toEqual(snapshot);
  });

  it("returns the same board for no operations", () => {
    const result = applyOps(emptyBoard(), [], 0);
    expect(result).toEqual({
      board: emptyBoard(),
      changedIds: [],
      summaryChanged: false,
      ignored: [],
    });
  });
});
