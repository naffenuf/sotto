/**
 * V3-007 on a simulated clock: what happens to a group that is going round in
 * circles.
 *
 * Almost all of this is about *not* offering — one at a time, one every ten
 * minutes, nothing when the ideas come back empty — because a stuck group
 * looks exactly like a group thinking hard, and the cost of being wrong is an
 * outsider talking over somebody's train of thought.
 */
import { describe, expect, it } from "vitest";
import { emptyBoard } from "../../shared/board.js";
import type { Candidate } from "../../shared/candidates.js";
import {
  MAX_STALL_IDEAS,
  STALL_OFFER_COOLDOWN_MS,
  type StallIdeas,
  type StallLogRecord,
} from "../../shared/stall.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import { StallOffers, stallIdeasCard, stallIdeasCardId } from "./StallOffers.js";
import { renderStallRequest } from "./stallIdeas.js";

const quiet = { log: () => {}, warn: () => {} };

function stall(id = "cand-1"): Candidate {
  return {
    id,
    type: "stall",
    headline: "Three names, all ruled out: what do we call it?",
    detail: "Meadow is taken, Tilde is unspellable, Parcel is unsayable.",
    whyNow: "they have just said they are stuck",
    evidenceTurnIds: ["0:14", "0:15"],
    relatedBoardItemIds: [],
    scores: { relevance: 0.9, novelty: 0.8, importance: 0.7, confidence: 0.8 },
    createdAtMs: 60_000,
    run: 4,
    evidence: [
      { turnId: "0:14", quote: "Meadow's gone, Tilde's unspellable, Parcel's unsayable.", speaker: "Craig" },
      { turnId: "0:15", quote: "We're stuck. That's what this is.", speaker: "EJ" },
    ],
  };
}

interface Harness {
  stalls: StallOffers;
  clock: SimulatedClock;
  offers: StallIdeas[];
  records: StallLogRecord[];
  /** Every request the writer was given, so "no call at all" is testable. */
  asked: string[];
}

function setup(options: {
  reply?: (nth: number) => Promise<unknown>;
  queued?: boolean;
  turns?: TurnUpdate[];
} = {}): Harness {
  const clock = new SimulatedClock(0);
  const offers: StallIdeas[] = [];
  const records: StallLogRecord[] = [];
  const asked: string[] = [];
  let calls = 0;
  const stalls = new StallOffers({
    clock,
    wallClock: clock,
    write: (input) => {
      asked.push(renderStallRequest(input));
      calls += 1;
      return (
        options.reply?.(calls) ??
        Promise.resolve({ topic: "the name", ideas: ["Try a word you can say twice"] })
      );
    },
    board: () => emptyBoard(),
    turns: () => options.turns ?? [],
    offer: (ideas) => {
      offers.push(ideas);
      return options.queued ?? true;
    },
    onRecord: (record) => records.push(record),
    logger: quiet,
  });
  return { stalls, clock, offers, records, asked };
}

describe("StallOffers", () => {
  it("writes the ideas and offers them", async () => {
    const { stalls, clock, offers, records } = setup({
      reply: () =>
        Promise.resolve({
          topic: "the name",
          ideas: [
            "Pick the one you'd mind least in five years",
            "Swap the ending of the two syllables you both liked",
          ],
        }),
    });
    clock.advanceTo(70_000);
    stalls.accept(stall());
    await stalls.flush();

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      id: "stall-1",
      candidateId: "cand-1",
      topic: "the name",
      stuckOn: "Three names, all ruled out: what do we call it?",
      // The turn it was last heard in, so the log can find the moment.
      turnId: "0:15",
      createdAtMs: 70_000,
    });
    expect(offers[0]?.ideas).toHaveLength(2);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      stage: "stall",
      atMs: 70_000,
      candidateId: "cand-1",
      stallId: "stall-1",
      outcome: "offered",
      topic: "the name",
    });
    expect(stalls.offered()).toBe(1);
    expect(stalls.ideasFor("stall-1")).toBe(offers[0]);
  });

  it("writes the ideas against what has already been ruled out", async () => {
    const { stalls, asked } = setup();
    stalls.accept(stall());
    await stalls.flush();

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("already been tried or ruled out");
    expect(asked[0]).toContain("Meadow is taken");
    // And in their own words, which is what stops an idea being handed back.
    expect(asked[0]).toContain("We're stuck. That's what this is.");
  });

  it("offers nothing for ten minutes after one offer", async () => {
    const { stalls, clock, offers, records } = setup();
    stalls.accept(stall("cand-1"));
    await stalls.flush();
    expect(offers).toHaveLength(1);

    clock.advanceTo(STALL_OFFER_COOLDOWN_MS - 1_000);
    stalls.accept(stall("cand-2"));
    await stalls.flush();
    expect(offers).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ candidateId: "cand-2", outcome: "cooldown" });
    // And no model call was made for it: the limit is in front of the call.
    expect(stalls.offered()).toBe(1);

    clock.advanceTo(STALL_OFFER_COOLDOWN_MS + 1_000);
    stalls.accept(stall("cand-3"));
    await stalls.flush();
    expect(offers).toHaveLength(2);
    expect(offers[1]?.id).toBe("stall-2");
  });

  it("writes one set of ideas at a time", async () => {
    let release = (): void => {};
    const { stalls, offers, records, asked } = setup({
      reply: (nth) =>
        nth === 1
          ? new Promise((resolve) => {
              release = () => resolve({ topic: "the name", ideas: ["one"] });
            })
          : Promise.resolve({ topic: "the name", ideas: ["two"] }),
    });
    stalls.accept(stall("cand-1"));
    await Promise.resolve();
    stalls.accept(stall("cand-2"));
    await Promise.resolve();

    expect(asked).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ candidateId: "cand-2", outcome: "offer_open" });
    release();
    await stalls.flush();
    expect(offers).toHaveLength(1);
  });

  it("says nothing when the ideas come back empty, and does not spend the ten minutes", async () => {
    const { stalls, clock, offers, records } = setup({
      reply: (nth) =>
        nth === 1
          ? Promise.resolve({ topic: "the name", ideas: [] })
          : Promise.resolve({ topic: "the name", ideas: ["something new"] }),
    });
    stalls.accept(stall("cand-1"));
    await stalls.flush();
    expect(offers).toHaveLength(0);
    expect(records[0]).toMatchObject({ outcome: "no_ideas", topic: "the name" });

    // Nothing was offered, so the next stall is not rationed against it.
    clock.advanceTo(30_000);
    stalls.accept(stall("cand-2"));
    await stalls.flush();
    expect(offers).toHaveLength(1);
  });

  it("records a call that did not come back, and never throws", async () => {
    const { stalls, offers, records } = setup({
      reply: () => Promise.reject(new Error("model said no")),
    });
    stalls.accept(stall());
    await stalls.flush();

    expect(offers).toHaveLength(0);
    expect(records[0]).toMatchObject({ outcome: "failed", error: "model said no" });
  });

  it("records a reply the room has no session left to hear", async () => {
    let release = (): void => {};
    const { stalls, offers, records } = setup({
      reply: () =>
        new Promise((resolve) => {
          release = () => resolve({ topic: "the name", ideas: ["one"] });
        }),
    });
    stalls.accept(stall());
    await Promise.resolve();
    stalls.stop();
    release();
    await stalls.flush();

    expect(offers).toHaveLength(0);
    expect(records[0]).toMatchObject({ outcome: "session_ended" });
  });

  it("writes down an offer the reservations refused, and keeps the cooldown free", async () => {
    const { stalls, offers, records } = setup({ queued: false });
    stalls.accept(stall("cand-1"));
    await stalls.flush();
    expect(offers).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "offer_open", stallId: "stall-1" });

    // The offer never happened, so the ten minutes have not started.
    stalls.accept(stall("cand-2"));
    await stalls.flush();
    expect(offers).toHaveLength(2);
  });

  it("stays quiet once the session has stopped", async () => {
    const { stalls, asked } = setup();
    stalls.stop();
    stalls.accept(stall());
    await stalls.flush();
    expect(asked).toHaveLength(0);
  });
});

describe("stallIdeasCard", () => {
  const ideas: StallIdeas = {
    id: "stall-1",
    candidateId: "cand-1",
    topic: "the name",
    stuckOn: "Three names, all ruled out: what do we call it?",
    ideas: ["Pick the one you'd mind least in five years", "Ask the two users you have"],
    turnId: "0:15",
    createdAtMs: 70_000,
  };

  it("is a plain notice whose ideas are the card", () => {
    const card = stallIdeasCard(ideas, 71_000);
    expect(card).toMatchObject({
      id: stallIdeasCardId("stall-1"),
      variant: "notice",
      state: "ready",
      createdAtMs: 71_000,
      headline: "A few ideas on the name",
    });
    expect(card.detailMd).toBe(
      "- Pick the one you'd mind least in five years\n- Ask the two users you have",
    );
    // A suggestion of Sotto's own is not a decision the policy took, so there
    // is nothing for the group to file a verdict on (V2-009's rule).
    expect(card.evidence).toBeUndefined();
    expect(card.citations).toBeUndefined();
  });

  it("has an id derived from the set, so pushing it twice replaces it", () => {
    expect(stallIdeasCardId("stall-2")).toBe("notice-ideas-stall-2");
    expect(stallIdeasCard(ideas, 1).id).toBe(stallIdeasCard(ideas, 2).id);
  });

  it("shows no more ideas than were ever offered", () => {
    expect(ideas.ideas.length).toBeLessThanOrEqual(MAX_STALL_IDEAS);
  });
});
