import { describe, expect, it } from "vitest";
import type { StageCard } from "../../shared/index.js";
import {
  QUIET_TRAY_MS,
  arrangeCards,
  foldCard,
  nextTrayDueAt,
  raisedCards,
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

describe("foldCard", () => {
  const stage = [card("research-packet-1", "research", NOW - 60_000), card("card-ans-1", "answer", NOW - 1_000)];

  it("replaces a card in place, keeping where it is in the stack", () => {
    const folded = foldCard(stage, { ...stage[0] as StageCard, headline: "more of it" }, NOW, 50);
    expect(folded.map((one) => one.id)).toEqual(stage.map((one) => one.id));
    expect(folded[0]?.headline).toBe("more of it");
    expect(folded[0]?.receivedAtMs).toBe(NOW - 60_000);
  });

  it("stamps a card that arrives for the first time", () => {
    const folded = foldCard(stage, card("research-packet-2", "research", 0), NOW, 50);
    expect(folded).toHaveLength(3);
    expect(folded[2]?.receivedAtMs).toBe(NOW);
  });

  it("brings a card the room asked for back to the top (V2-015)", () => {
    const asked = { ...(stage[0] as StageCard), forward: true };
    const folded = foldCard(stage, asked, NOW, 50);
    expect(folded[0]?.receivedAtMs).toBe(NOW);
    expect(arrangeCards(folded, NOW).stack[0]?.id).toBe("research-packet-1");
  });

  it("drops the oldest card once the cap is reached", () => {
    const folded = foldCard(stage, card("card-ans-2", "answer", 0), NOW, 2);
    expect(folded.map((one) => one.id)).toEqual(["card-ans-1", "card-ans-2"]);
  });
});

/**
 * V3-017's count. The PRD's three ways of taking a hand down, one per test:
 * the reader opened it, the server said it, and it aged off the stage.
 */
describe("raisedCards", () => {
  const held = (id: string, variant: StageCard["variant"], receivedAtMs: number) => ({
    ...card(id, variant, receivedAtMs),
    raised: true,
  });
  const none = new Set<string>();

  it("counts only what Sotto is holding, newest first", () => {
    const cards = [
      held("card-1", "glow", NOW - 20_000),
      card("card-ans-1", "answer", NOW - 10_000),
      held("card-2", "interject", NOW - 5_000),
    ];
    expect(raisedCards(cards, none, NOW).map((one) => one.id)).toEqual(["card-2", "card-1"]);
  });

  it("stops counting a card the reader opened", () => {
    const cards = [held("card-1", "glow", NOW - 1_000), held("card-2", "interject", NOW)];
    expect(raisedCards(cards, new Set(["card-1"]), NOW).map((one) => one.id)).toEqual([
      "card-2",
    ]);
  });

  it("stops counting a card the server has said and republished", () => {
    const spoken = { ...card("card-1", "interject", NOW), raised: false };
    expect(raisedCards([spoken], none, NOW)).toEqual([]);
  });

  it("stops counting a glow that has aged into the tray", () => {
    const stale = held("card-1", "glow", NOW - QUIET_TRAY_MS - 1_000);
    expect(raisedCards([stale], none, NOW)).toEqual([]);
    // An interjection does not age off the stage, so its hand stays up.
    const kept = held("card-2", "interject", NOW - QUIET_TRAY_MS - 1_000);
    expect(raisedCards([kept], none, NOW).map((one) => one.id)).toEqual(["card-2"]);
  });

  it("is empty when Sotto is holding nothing", () => {
    expect(raisedCards([card("card-ans-1", "answer", NOW)], none, NOW)).toEqual([]);
    expect(raisedCards([], none, NOW)).toEqual([]);
  });
});
