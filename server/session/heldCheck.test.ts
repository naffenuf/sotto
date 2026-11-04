/**
 * V3-017, after the review: which of the things Sotto is holding has the room
 * already answered by the time it says "go ahead"?
 */
import { describe, expect, it } from "vitest";
import type { TurnUpdate } from "../../shared/turns.js";
import { systemClock } from "../clock.js";
import type { JevLike, JevRequest, JevResponse } from "../model/JevClient.js";
import { HELD_ANSWERED_THRESHOLD, checkHeld, renderHeldState, turnsSince } from "./heldCheck.js";
import type { RaisedItem } from "./raisedHand.js";

function turn(turnId: string, text: string, speaker = "A"): TurnUpdate {
  return { turnId, speaker, speakerMappingUncertain: false, text, final: true, startMs: 0, endMs: 1_000 };
}

function item(cardId: string, line: string, sinceTurnId: string | null, atMs = 1_000): RaisedItem {
  return { cardId, atMs, line, offer: `I have ${cardId}. Want to hear it?`, sinceTurnId };
}

const turns = [
  turn("0:1", "We need the bus schedules from New York to Philadelphia."),
  turn("0:2", "And the hotel has to come in under 300."),
  turn("0:3", "Oh, I found the buses: Megabus every half hour, about two hours.", "B"),
  turn("0:4", "Great, so what about the hotel?"),
];

/** Answers every noul with the number its instructions' item number maps to. */
function jevSaying(byItem: Record<number, number>): JevLike & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    requests,
    systemOne: async (request) => {
      requests.push(request);
      const answers: JevResponse["answers"] = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const index = Number(/item (\d+)/.exec(question.instructions)?.[1] ?? "0");
        answers[id] = { type: "noul", noul: byItem[index] ?? 0 };
      }
      return { model: "jev-test", answers };
    },
  };
}

describe("turnsSince", () => {
  it("is the turns after the one the hand went up on, or all of them", () => {
    expect(turnsSince(turns, "0:2").map((one) => one.turnId)).toEqual(["0:3", "0:4"]);
    expect(turnsSince(turns, "0:4")).toEqual([]);
    expect(turnsSince(turns, null).map((one) => one.turnId)).toEqual(["0:1", "0:2", "0:3", "0:4"]);
    expect(turnsSince(turns, "gone").map((one) => one.turnId)).toEqual(["0:1", "0:2", "0:3", "0:4"]);
  });
});

describe("checkHeld", () => {
  it("drops what the room answered itself, in one call over every held item", async () => {
    const jev = jevSaying({ 1: 0.92, 2: 0.08 });
    const held = [
      item("research-idea-1", "Buses leave every half hour and take about two hours.", "0:1"),
      item("card-cand-1", "Will the hotel fit under 300 with dinner?", "0:2"),
    ];
    const result = await checkHeld(jev, { items: held, turns, speakers: { A: "Craig", B: "EJ" } }, systemClock);
    expect([...result.answered]).toEqual(["research-idea-1"]);
    expect(result.scores).toEqual({ "research-idea-1": 0.92, "card-cand-1": 0.08 });
    expect(result.skipped).toBeUndefined();
    expect(jev.requests).toHaveLength(1);
    const state = jev.requests[0]?.state ?? "";
    expect(state).toContain("1. Buses leave every half hour");
    expect(state).toContain("2. Will the hotel fit");
    // The turns since the oldest hand went up, with the room's names.
    expect(state).toContain("EJ: Oh, I found the buses");
    expect(state).not.toContain("We need the bus schedules");
    expect(Object.keys(jev.requests[0]?.questions ?? {})).toEqual(["research-idea-1", "card-cand-1"]);
  });

  it("asks nothing when nobody has spoken since any hand went up", async () => {
    const jev = jevSaying({ 1: 0.99 });
    const result = await checkHeld(jev, { items: [item("card-1", "a line", "0:4")], turns, speakers: {} }, systemClock);
    expect(result.answered.size).toBe(0);
    expect(result.skipped).toBe("nothing_since");
    expect(jev.requests).toEqual([]);
  });

  it("drops nothing without Jev, or when Jev does not answer", async () => {
    const held = [item("card-1", "a line", "0:1")];
    const without = await checkHeld(null, { items: held, turns, speakers: {} }, systemClock);
    expect(without).toMatchObject({ skipped: "no_jev" });
    expect(without.answered.size).toBe(0);
    const broken: JevLike = { systemOne: async () => { throw new Error("down"); } };
    const failed = await checkHeld(broken, { items: held, turns, speakers: {} }, systemClock);
    expect(failed).toMatchObject({ skipped: "no_answer" });
    expect(failed.answered.size).toBe(0);
  });

  it("holds the threshold where it says", async () => {
    const jev = jevSaying({ 1: HELD_ANSWERED_THRESHOLD, 2: HELD_ANSWERED_THRESHOLD - 0.01 });
    const held = [item("card-1", "one", "0:1"), item("card-2", "two", "0:1")];
    const result = await checkHeld(jev, { items: held, turns, speakers: {} }, systemClock);
    expect([...result.answered]).toEqual(["card-1"]);
  });

  it("renders the held lines numbered and the room's words since", () => {
    const state = renderHeldState({ items: [item("c", "The answer.", null)], turns, speakers: { A: "Craig" } }, turns.slice(2));
    expect(state).toContain("1. The answer.");
    expect(state).toContain("Craig: Great, so what about the hotel?");
  });
});
