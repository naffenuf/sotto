/**
 * V3-006 on the simulated clock: both ways the room steers the frequency, and
 * the two things that must *not* move it — a stop about an answer somebody
 * asked for, and a single yield.
 */
import { describe, expect, it } from "vitest";
import type { StageCard } from "../../shared/cards.js";
import type { Frequency } from "../../shared/policy.js";
import { SimulatedClock } from "../clock.js";
import { STEER_WINDOW_MS, Steering, YIELD_WINDOW_MS } from "./Steering.js";

function setup(frequency: Frequency = "normal") {
  const clock = new SimulatedClock(0);
  let current = frequency;
  const cards: StageCard[] = [];
  const timing: Record<string, unknown>[] = [];
  const steering = new Steering({
    clock,
    frequency: () => current,
    setFrequency: (next) => {
      current = next;
    },
    onCard: (card) => cards.push(card),
    onTiming: (record) => timing.push(record),
    logger: { log: () => {}, warn: () => {} },
  });
  return { clock, steering, cards, timing, frequency: () => current };
}

describe("steering the frequency by talking to Sotto", () => {
  it("lowers it one step on quieter, with a note that says what changed", () => {
    const t = setup();
    t.steering.commanded("quieter", "turn-7");
    expect(t.frequency()).toBe("rare");
    expect(t.cards).toHaveLength(1);
    expect(t.cards[0]).toMatchObject({
      id: "notice-steering-1",
      variant: "notice",
      state: "ready",
      headline: "Sotto will speak up less",
    });
    expect(t.cards[0]?.detailMd).toContain("rare");
    expect(t.timing[0]).toMatchObject({
      stage: "steering", source: "quieter", direction: "quieter",
      from: "normal", to: "rare", applied: true, turnId: "turn-7",
    });
  });

  it("raises it one step on louder", () => {
    const t = setup();
    t.steering.commanded("louder");
    expect(t.frequency()).toBe("often");
    expect(t.cards[0]?.headline).toBe("Sotto will speak up more");
  });

  it("numbers each note, so turning down and back up shows both", () => {
    const t = setup();
    t.steering.commanded("quieter");
    t.steering.commanded("louder");
    expect(t.frequency()).toBe("normal");
    expect(t.cards.map((card) => card.id)).toEqual([
      "notice-steering-1",
      "notice-steering-2",
    ]);
  });

  it("says nothing when there is nowhere further to go", () => {
    const t = setup("rare");
    t.steering.commanded("quieter");
    expect(t.frequency()).toBe("rare");
    expect(t.cards).toEqual([]);
    expect(t.timing[0]).toMatchObject({ applied: false, reason: "at_limit" });
  });
});

describe("a stop, which depends on what Sotto was doing", () => {
  it("counts as quieter during an unprompted contribution", () => {
    const t = setup();
    t.steering.noteContribution();
    t.clock.advanceBy(2_000);
    t.steering.commanded("stop", "turn-3");
    expect(t.frequency()).toBe("rare");
    expect(t.timing[0]).toMatchObject({ source: "stop", direction: "quieter", applied: true });
  });

  it("still counts at the edge of the window, and not past it", () => {
    const t = setup();
    t.steering.noteContribution();
    t.clock.advanceBy(STEER_WINDOW_MS);
    t.steering.commanded("stop");
    expect(t.frequency()).toBe("rare");

    const later = setup();
    later.steering.noteContribution();
    later.clock.advanceBy(STEER_WINDOW_MS + 1);
    later.steering.commanded("stop");
    expect(later.frequency()).toBe("normal");
    expect(later.cards).toEqual([]);
    expect(later.timing[0]).toMatchObject({ applied: false, reason: "not_unprompted" });
  });

  it("changes nothing during an answer to a direct question", () => {
    const t = setup();
    t.steering.commanded("stop", "turn-1");
    expect(t.frequency()).toBe("normal");
    expect(t.cards).toEqual([]);
  });

  it("does not stop quieter and louder from applying outside the window", () => {
    const t = setup();
    t.steering.commanded("quieter");
    expect(t.frequency()).toBe("rare");
  });
});

describe("being talked over is a hint", () => {
  it("takes two yields inside ten minutes", () => {
    const t = setup();
    t.steering.noteYield("turn-1");
    expect(t.frequency()).toBe("normal");
    expect(t.cards).toEqual([]);
    expect(t.timing[0]).toMatchObject({ source: "yields", applied: false, reason: "below_hint", yields: 1 });
    t.clock.advanceBy(60_000);
    t.steering.noteYield("turn-9");
    expect(t.frequency()).toBe("rare");
    expect(t.cards[0]?.headline).toBe("Sotto will speak up less");
    expect(t.timing[1]).toMatchObject({ source: "yields", direction: "quieter", applied: true, yields: 2 });
  });

  it("forgets a yield older than the window", () => {
    const t = setup();
    t.steering.noteYield();
    t.clock.advanceBy(YIELD_WINDOW_MS);
    t.steering.noteYield();
    expect(t.frequency()).toBe("normal");
    expect(t.steering.yields()).toBe(1);
  });

  it("costs one step per run of yields, not one per yield", () => {
    const t = setup("often");
    t.steering.noteYield();
    t.steering.noteYield();
    expect(t.frequency()).toBe("normal");
    t.steering.noteYield();
    expect(t.frequency()).toBe("normal");
    t.steering.noteYield();
    expect(t.frequency()).toBe("rare");
    expect(t.cards).toHaveLength(2);
  });
});

describe("the end of the session", () => {
  it("ignores a command classified after the conversation stopped", () => {
    const t = setup();
    t.steering.noteContribution();
    t.steering.stop();
    t.steering.commanded("quieter");
    t.steering.noteYield();
    t.steering.noteYield();
    expect(t.frequency()).toBe("normal");
    expect(t.cards).toEqual([]);
    expect(t.timing).toEqual([]);
  });
});
