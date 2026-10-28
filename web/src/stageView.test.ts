import { describe, expect, it } from "vitest";
import type { StageCard } from "../../shared/index.js";
import {
  QUIET_TRAY_MS,
  arrangeCards,
  nextTrayDueAt,
  trayLabel,
  type StageCardView,
} from "./stageView.js";

function card(
  id: string,
  variant: StageCard["variant"],
  receivedAtMs: number,
): StageCardView {
  return {
    id,
    variant,
    state: "ready",
    headline: id,
    createdAtMs: receivedAtMs,
    receivedAtMs,
  };
}

const NOW = 1_000_000;

describe("arrangeCards", () => {
  it("stacks newest on top", () => {
    const cards = [
      card("old", "answer", NOW - 30_000),
      card("new", "interject", NOW - 1_000),
      card("middle", "answer", NOW - 10_000),
    ];
    expect(arrangeCards(cards, NOW).stack.map((one) => one.id)).toEqual([
      "new",
      "middle",
      "old",
    ]);
  });

  it("leaves a fresh glow on the stage", () => {
    const cards = [card("g", "glow", NOW - QUIET_TRAY_MS + 1)];
    const { stack, tray } = arrangeCards(cards, NOW);
    expect(stack.map((one) => one.id)).toEqual(["g"]);
    expect(tray).toEqual([]);
  });

  it("folds a glow into the tray once it is two minutes old", () => {
    const cards = [card("g", "glow", NOW - QUIET_TRAY_MS)];
    const { stack, tray } = arrangeCards(cards, NOW);
    expect(stack).toEqual([]);
    expect(tray.map((one) => one.id)).toEqual(["g"]);
  });

  it("never trays an answer or an interjection, however old", () => {
    const cards = [
      card("a", "answer", NOW - 10 * QUIET_TRAY_MS),
      card("i", "interject", NOW - 10 * QUIET_TRAY_MS),
    ];
    const { stack, tray } = arrangeCards(cards, NOW);
    expect(stack).toHaveLength(2);
    expect(tray).toEqual([]);
  });

  it("keeps the tray newest first too", () => {
    const cards = [
      card("older", "glow", NOW - QUIET_TRAY_MS - 60_000),
      card("newer", "glow", NOW - QUIET_TRAY_MS - 1_000),
    ];
    expect(arrangeCards(cards, NOW).tray.map((one) => one.id)).toEqual(["newer", "older"]);
  });

  it("does not touch the array it was given", () => {
    const cards = [card("a", "answer", NOW - 1), card("b", "answer", NOW - 2)];
    arrangeCards(cards, NOW);
    expect(cards.map((one) => one.id)).toEqual(["a", "b"]);
  });
});

describe("trayLabel", () => {
  it("counts one thought singly", () => {
    expect(trayLabel(1)).toBe("1 quiet thought");
    expect(trayLabel(4)).toBe("4 quiet thoughts");
  });
});

describe("nextTrayDueAt", () => {
  it("has nothing to wait for without a glow", () => {
    expect(nextTrayDueAt([card("a", "answer", NOW)], NOW)).toBeNull();
  });

  it("waits for the glow that collapses soonest", () => {
    const cards = [
      card("later", "glow", NOW - 10_000),
      card("sooner", "glow", NOW - 90_000),
    ];
    expect(nextTrayDueAt(cards, NOW)).toBe(NOW - 90_000 + QUIET_TRAY_MS);
  });

  it("ignores glows that are already past due, so the timer never spins", () => {
    const cards = [card("gone", "glow", NOW - QUIET_TRAY_MS - 1)];
    expect(nextTrayDueAt(cards, NOW)).toBeNull();
  });
});
