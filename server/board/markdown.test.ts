import { describe, expect, it } from "vitest";
import { emptyBoard, type BoardOp } from "../../shared/board.js";
import { applyOps } from "./applyOps.js";
import { renderBoardMarkdown } from "./markdown.js";

const ops: BoardOp[] = [
  { op: "set_summary", text: "The group is scoping a pilot." },
  { op: "add_constraint", text: "under $20k", sourceTurnIds: ["0:1"] },
  { op: "add_point", text: "start with the mobile app", sourceTurnIds: ["0:2"] },
  { op: "add_point", text: "rewrite the onboarding", sourceTurnIds: ["0:3"] },
  { op: "add_question", text: "who signs this off?", sourceTurnIds: ["0:4"] },
  { op: "add_decision", text: "ship the pilot in March", sourceTurnIds: ["0:5"] },
  { op: "set_status", id: "q1", status: "covered" },
  { op: "set_status", id: "p2", status: "dropped" },
];

describe("renderBoardMarkdown", () => {
  it("writes every section as a checklist", () => {
    const { board } = applyOps(emptyBoard(), ops, 0);
    expect(renderBoardMarkdown(board)).toBe(
      `# Board

## Summary

The group is scoping a pilot.

## Constraints

- [ ] under $20k

## Points

- [ ] start with the mobile app
- [ ] ~~rewrite the onboarding~~

## Open Questions

- [x] who signs this off?

## Decisions

- [ ] ship the pilot in March
`,
    );
  });

  it("keeps the sections when there is nothing on the board", () => {
    expect(renderBoardMarkdown(emptyBoard())).toBe(
      `# Board

## Summary

_nothing yet_

## Constraints

_nothing yet_

## Points

_nothing yet_

## Open Questions

_nothing yet_

## Decisions

_nothing yet_
`,
    );
  });
});
