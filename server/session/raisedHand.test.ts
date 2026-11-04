/**
 * V3-017: the queue of things Sotto is holding, and the sentence each would
 * be read out in.
 */
import { describe, expect, it } from "vitest";
import type { StageCard } from "../../shared/cards.js";
import type { ResearchPacket } from "../../shared/research.js";
import {
  NOTHING_RAISED_LINE,
  RaisedHand,
  calledOnCardLine,
  calledOnPacketLine,
  heldOfferLine,
} from "./raisedHand.js";

function card(id: string, over: Partial<StageCard> = {}): StageCard {
  return {
    id,
    variant: "interject",
    state: "ready",
    createdAtMs: 1_000,
    headline: "Before six gardens: what if only one signs up?",
    raised: true,
    ...over,
  };
}

function packet(over: Partial<ResearchPacket> = {}): ResearchPacket {
  return {
    id: "packet-1",
    ideaId: "idea-1",
    title: "The drive is about two hours",
    teaser: "Two routes, both around two hours outside rush hour.",
    keyPoints: ["The M1 is 2h05 off peak", "The A-road is 2h20"],
    sources: [{ url: "https://example.com/route", title: "Route planner" }],
    createdAtMs: 2_000,
    latencyMs: 15_000,
    ...over,
  };
}

describe("the line one raised card is read out in", () => {
  it("says an interjection's headline and its detail", () => {
    expect(
      calledOnCardLine(card("card-1", { detailMd: "Six associations, one shed each." })),
    ).toBe(
      "Before six gardens: what if only one signs up? Six associations, one shed each.",
    );
  });

  it("reads a late answer in the half that was written to be heard", () => {
    expect(
      calledOnCardLine(
        card("card-ans-1", {
          variant: "answer",
          headline: "Buses leave hourly from 7",
          detailMd: "- Hourly 07:00–22:00\n- $18 one way",
          spokenText: "Buses run hourly from seven in the morning, and a one-way ticket is about eighteen dollars.",
        }),
      ),
    ).toBe("Buses run hourly from seven in the morning, and a one-way ticket is about eighteen dollars.");
  });

  it("says the headline alone when there is no detail", () => {
    expect(calledOnCardLine(card("card-1"))).toBe(
      "Before six gardens: what if only one signs up?",
    );
  });

  it("reads a bulleted detail as sentences and drops the URLs", () => {
    const line = calledOnCardLine(
      card("card-1", {
        headline: "The churn figure is the 2019 one",
        detailMd: "- It was **9%** in 2019\n- See https://example.com/churn for 2024",
      }),
    );
    expect(line).toBe(
      "The churn figure is the 2019 one. It was 9% in 2019 See for 2024.",
    );
    expect(line).not.toContain("http");
    expect(line).not.toContain("*");
  });

  it("ends a clipped headline on a stop rather than an ellipsis", () => {
    expect(calledOnCardLine(card("card-1", { headline: "A $12 solo tier does not fit…" })))
      .toBe("A $12 solo tier does not fit.");
  });

  it("says a packet's own spoken line where the search wrote one", () => {
    expect(calledOnPacketLine(packet({ spokenAnswer: "About two hours fifteen" }))).toBe(
      "About two hours fifteen.",
    );
  });

  it("falls back to a briefing off the title and the teaser", () => {
    expect(calledOnPacketLine(packet())).toBe(
      "On The drive is about two hours: Two routes, both around two hours outside rush hour.",
    );
  });
});

describe("RaisedHand", () => {
  it("counts what Sotto is holding and reads out the newest", () => {
    const hand = new RaisedHand();
    expect(hand.count()).toBe(0);
    expect(hand.latest()).toBeNull();

    hand.observe(card("card-1"), "the first thing", 1_000);
    hand.observe(card("card-2"), "the second thing", 2_000);

    expect(hand.count()).toBe(2);
    expect(hand.latest()).toMatchObject({ cardId: "card-2", line: "the second thing" });
    expect(hand.held().map((item) => item.cardId)).toEqual(["card-1", "card-2"]);
  });

  it("takes the hand down for a card that is no longer raised", () => {
    const hand = new RaisedHand();
    hand.observe(card("card-1"), "a line", 1_000);
    // Said out loud: the server republishes the card without the flag.
    hand.observe(card("card-1", { raised: false }), "a line", 2_000);

    expect(hand.count()).toBe(0);
    expect(hand.latest()).toBeNull();
  });

  it("never raises a hand it could not honour", () => {
    const hand = new RaisedHand();
    // A thinking research card: raised, but with nothing to say yet.
    hand.observe(card("card-1"), "   ", 1_000);
    expect(hand.count()).toBe(0);
  });

  it("refreshes a card published again rather than doubling it", () => {
    const hand = new RaisedHand();
    hand.observe(card("card-1"), "the old line", 1_000);
    hand.observe(card("card-2"), "the newer thing", 2_000);
    // Pinned beside a decision (V3-013): republished, and now the newest.
    hand.observe(card("card-1"), "the new line", 3_000);

    expect(hand.count()).toBe(2);
    expect(hand.latest()).toMatchObject({ cardId: "card-1", line: "the new line" });
  });

  it("lowers one card and clears the lot", () => {
    const hand = new RaisedHand();
    hand.observe(card("card-1"), "one", 1_000);
    hand.observe(card("card-2"), "two", 2_000);

    expect(hand.lower("card-2")).toBe(true);
    expect(hand.lower("card-2")).toBe(false);
    expect(hand.latest()).toMatchObject({ cardId: "card-1" });

    hand.clear();
    expect(hand.count()).toBe(0);
  });

  it("has a short answer for a call with nothing raised", () => {
    expect(NOTHING_RAISED_LINE).toBe("Nothing right now.");
  });

  it("goes through what it holds newest first, last published first on a tie", () => {
    const hand = new RaisedHand();
    hand.observe(card("card-1"), "one", 1_000);
    hand.observe(card("card-2"), "two", 2_000);
    hand.observe(card("card-3"), "three", 2_000);
    expect(hand.newestFirst().map((item) => item.cardId)).toEqual(["card-3", "card-2", "card-1"]);
  });

  it("remembers which turn each card was raised after, and keeps it on a republish", () => {
    let latest: string | null = null;
    const hand = new RaisedHand({ latestTurnId: () => latest });
    hand.observe(card("card-1"), "one", 1_000);
    latest = "0:3";
    hand.observe(card("card-2"), "two", 2_000);
    latest = "0:5";
    // Pinned beside a decision (V3-013): the room has not asked about it since.
    hand.observe(card("card-1"), "one, pinned", 3_000);
    expect(hand.held().map((item) => [item.cardId, item.sinceTurnId])).toEqual([
      ["card-2", "0:3"],
      ["card-1", null],
    ]);
    // Lowered and raised again: it is raised after whatever is newest now.
    hand.lower("card-1");
    hand.observe(card("card-1"), "one, again", 4_000);
    expect(hand.held().at(-1)?.sinceTurnId).toBe("0:5");
  });
});

describe("heldOfferLine", () => {
  it("offers a research card by what was looked up", () => {
    const research = card("research-idea-1", { variant: "research", headline: "NYC to Philly buses: 40 Greyhound runs" });
    expect(heldOfferLine(research, "the cheapest Sunday bus from New York to Philadelphia")).toBe(
      "I looked up the cheapest Sunday bus from New York to Philadelphia. Want to hear it?",
    );
    // No topic: the packet's title stands in.
    expect(heldOfferLine(research)).toBe("I looked up NYC to Philly buses: 40 Greyhound runs. Want to hear it?");
  });

  it("offers an answer by the question it answers", () => {
    const answer = card("card-ans-1", { variant: "answer", question: "How long does the bus take?" });
    expect(heldOfferLine(answer)).toBe("I have an answer on How long does the bus take. Want to hear it?");
  });

  it("offers anything Sotto noticed by its headline", () => {
    expect(heldOfferLine(card("card-cand-1"))).toBe(
      "I have a note: Before six gardens: what if only one signs up. Want to hear it?",
    );
  });

  it("is what a card is held with unless told otherwise", () => {
    const hand = new RaisedHand();
    hand.observe(card("card-1"), "the line", 1_000);
    expect(hand.latest()?.offer).toBe(heldOfferLine(card("card-1")));
    hand.observe(card("card-2", { variant: "research", headline: "Buses" }), "the line", 2_000, "I looked up the buses. Want to hear it?");
    expect(hand.latest()?.offer).toBe("I looked up the buses. Want to hear it?");
  });
});
