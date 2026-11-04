/**
 * V3-005 on a simulated clock: what the turn after an offer does about it.
 *
 * Everything here leans one way, as the window itself does: a yes is the only
 * verdict that says anything, and a reply nobody could read is not permission
 * to read research out to a group that did not ask for it.
 */
import { describe, expect, it } from "vitest";
import type { ResearchPacket } from "../../shared/research.js";
import { sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import {
  OFFER_TIMEOUT_CALL_MS,
  OFFER_WINDOW_MS,
  OfferWindow,
  offerSubjectId,
} from "./OfferWindow.js";
import type { OfferReplyResult } from "./offerReply.js";

function turn(text: string, id = "0:9", speaker: string | null = "A"): TurnUpdate {
  return {
    turnId: id, speaker, text, final: true, startMs: 0, endMs: 1_000,
    speakerMappingUncertain: false,
  };
}

const packet: ResearchPacket = {
  id: "packet-1",
  ideaId: "idea-3",
  title: "What the three nearest competitors charge",
  teaser: "All three are between £29 and £49 a seat, with the cheapest capping integrations.",
  keyPoints: ["Cheapest is £29 a seat", "Two of the three cap integrations"],
  spokenAnswer: "They're all between twenty-nine and forty-nine pounds a seat.",
  sources: [{ title: "Pricing page", url: "https://example.com/pricing" }],
  createdAtMs: 40_000,
  latencyMs: 15_000,
};

const offered = {
  subject: { kind: "research", packet } as const,
  topic: "competitor pricing",
  title: packet.title,
  spokenText: "There's a quick rundown on competitor pricing on screen if you want it.",
};

const yes: OfferReplyResult = { kind: "yes" };
const no: OfferReplyResult = { kind: "no" };
const unrelated: OfferReplyResult = { kind: "unrelated" };

interface Harness {
  window: OfferWindow;
  clock: SimulatedClock;
  /** Every turn the classifier was given, so "no call at all" is testable. */
  asked: string[];
  briefed: { packetId: string; turnId: string; topic: string }[];
  timing: Record<string, unknown>[];
}

/** A window whose classifier answers from a queue, so nothing is awaited. */
function windowFor(replies: readonly (OfferReplyResult | Error | "hold")[]): Harness {
  const clock = new SimulatedClock(0);
  const asked: string[] = [];
  const briefed: { packetId: string; turnId: string; topic: string }[] = [];
  const timing: Record<string, unknown>[] = [];
  let next = 0;
  const window = new OfferWindow({
    clock,
    wallClock: clock,
    classify: async (input) => {
      asked.push(input.turn.text);
      const reply = replies[next++];
      if (reply === undefined || reply === "hold") {
        return new Promise(() => {
          // Held for ever: the real timeout is what ends this.
        });
      }
      if (reply instanceof Error) throw reply;
      return reply;
    },
    speakers: () => ({ A: "Craig", B: "EJ" }),
    onAccepted: (taken, asker) =>
      briefed.push({ packetId: offerSubjectId(taken), turnId: asker.turnId, topic: asker.topic }),
    onTiming: (record) => timing.push(record),
  });
  return { window, clock, asked, briefed, timing };
}

/** Lets the serialized classification chain reach its first `await`. */
async function tick(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function outcome(timing: readonly Record<string, unknown>[]): unknown {
  return timing
    .filter((one) => one["stage"] === "offer_window" && one["event"] === "closed")
    .at(-1)?.["outcome"];
}

describe("OfferWindow, told how each offer ended", () => {
  it("reports a no on a held card, which is what moves a go-ahead on to the next", async () => {
    const clock = new SimulatedClock(0);
    const closed: [string, string][] = [];
    const accepted: string[] = [];
    const item = { cardId: "card-2", atMs: 1_000, line: "Nobody has said who writes the copy.", offer: "I have a note. Want to hear it?", sinceTurnId: null };
    const queue = [{ ...item, cardId: "card-1" }];
    const window = new OfferWindow({
      clock,
      wallClock: clock,
      classify: async () => no,
      speakers: () => ({}),
      onAccepted: (taken) => accepted.push(offerSubjectId(taken)),
      onClosed: (taken, outcome) => closed.push([offerSubjectId(taken), outcome]),
      onTiming: () => {},
    });
    window.offered({ subject: { kind: "held", item, queue }, topic: "card-2", title: item.offer, spokenText: item.offer });
    clock.advanceTo(2_000);
    window.acceptTurn(turn(" No, not that one. ", "0:9", "B"));
    await window.flush();
    expect(closed).toEqual([["card-2", "no"]]);
    expect(accepted).toEqual([]);
    expect(window.isOpen()).toBe(false);
  });
});

describe("OfferWindow", () => {
  it("briefs the room from that packet when somebody says go on", async () => {
    const { window, clock, briefed, timing } = windowFor([yes]);
    expect(window.isOpen()).toBe(false);
    clock.advanceTo(40_000);
    window.offered(offered);
    expect(window.isOpen()).toBe(true);

    clock.advanceTo(43_000);
    window.acceptTurn(turn(" Yeah go on then. ", "0:9", "B"));
    await window.flush();
    expect(briefed).toEqual([
      { packetId: "packet-1", turnId: "0:9", topic: "competitor pricing" },
    ]);
    // One turn only: the offer was about the sentence that followed it.
    expect(window.isOpen()).toBe(false);
    expect(timing.filter((one) => one["stage"] === "offer_reply")).toEqual([
      {
        stage: "offer_reply", atMs: 43_000, offer: "research", offerId: "packet-1", turnId: "0:9",
        kind: "yes", latencyMs: 0,
      },
    ]);
    expect(outcome(timing)).toBe("yes");
  });

  it("says nothing more when the offer is declined", async () => {
    const { window, briefed, timing, asked } = windowFor([no]);
    window.offered(offered);
    window.acceptTurn(turn(" Not now, let's finish the budget. "));
    await window.flush();
    expect(asked).toHaveLength(1);
    expect(briefed).toEqual([]);
    expect(window.isOpen()).toBe(false);
    expect(outcome(timing)).toBe("no");
  });

  it("says nothing more when the room simply carried on", async () => {
    const { window, briefed, timing } = windowFor([unrelated]);
    window.offered(offered);
    window.acceptTurn(turn(" Yeah, and the deposit is due on the Friday. "));
    await window.flush();
    expect(briefed).toEqual([]);
    expect(outcome(timing)).toBe("unrelated");
  });

  it("closes after ten seconds of nobody saying anything", async () => {
    const { window, clock, asked, briefed, timing } = windowFor([yes]);
    window.offered(offered);
    clock.advanceBy(OFFER_WINDOW_MS - 1);
    expect(window.isOpen()).toBe(true);
    clock.advanceBy(1);
    expect(window.isOpen()).toBe(false);
    expect(outcome(timing)).toBe("timeout");

    // A yes after the window has closed is a question of its own, and the
    // address path is what answers one.
    clock.advanceBy(1_000);
    window.acceptTurn(turn(" Go on then. "));
    await tick();
    expect(asked).toEqual([]);
    expect(briefed).toEqual([]);
  });

  it("leaves a turn that says Sotto's name to the address path, with no call", async () => {
    const { window, asked, briefed, timing } = windowFor([yes]);
    window.offered(offered);
    window.acceptTurn(turn(" Sotto, go ahead. "));
    await window.flush();
    expect(asked).toEqual([]);
    expect(briefed).toEqual([]);
    expect(outcome(timing)).toBe("addressed");
  });

  it("treats a verdict it could not read as no reply at all", async () => {
    const { window, briefed, timing } = windowFor([new Error("no model")]);
    window.offered(offered);
    window.acceptTurn(turn(" Hmm. "));
    await window.flush();
    expect(briefed).toEqual([]);
    expect(outcome(timing)).toBe("unsure");
    expect(
      timing.find((one) => one["stage"] === "offer_reply")?.["fallback"],
    ).toBe(true);
  });

  it("gives up on a classification that never comes back", async () => {
    const { window, clock, briefed, timing } = windowFor(["hold"]);
    window.offered(offered);
    window.acceptTurn(turn(" Sure, why not. "));
    await tick();
    expect(briefed).toEqual([]);
    clock.advanceBy(OFFER_TIMEOUT_CALL_MS);
    await window.flush();
    expect(briefed).toEqual([]);
    expect(outcome(timing)).toBe("unsure");
  });

  it("never reads its own voice as a reply, and never a partial", async () => {
    const { window, asked } = windowFor([yes]);
    window.offered(offered);
    window.acceptTurn(sottoTurn({
      utteranceId: "offer-idea-3",
      text: offered.spokenText,
      startMs: 0,
      interrupted: false,
    }));
    window.acceptTurn({ ...turn(" Go on. ", "0:9"), final: false });
    await tick();
    expect(asked).toEqual([]);
    expect(window.isOpen()).toBe(true);
  });

  it("ignores an echo, and forgets nothing it was told to remember", async () => {
    const { window, asked, briefed } = windowFor([yes]);
    window.offered(offered);
    window.ignoreTurn("0:9");
    window.acceptTurn(turn(" There's a quick rundown on competitor pricing. ", "0:9"));
    await window.flush();
    expect(asked).toEqual([]);
    expect(briefed).toEqual([]);
    expect(window.isOpen()).toBe(true);
  });

  it("hands back a set of ideas as happily as a packet (V3-007)", async () => {
    const { window, clock, briefed, timing, asked } = windowFor([yes]);
    clock.advanceTo(70_000);
    window.offered({
      subject: {
        kind: "stall",
        ideas: {
          id: "stall-1",
          candidateId: "cand-4",
          topic: "the name",
          stuckOn: "Three names, all ruled out: what do we call it?",
          ideas: ["Pick the one you'd mind least in five years"],
          turnId: "0:15",
          createdAtMs: 69_000,
        },
      },
      topic: "the name",
      title: "a few ideas on the name",
      spokenText: "I've got a few ideas on the name if they'd help.",
    });
    clock.advanceTo(72_000);
    window.acceptTurn(turn(" Go on then. Anything. ", "0:17", "B"));
    await window.flush();

    expect(briefed).toEqual([{ packetId: "stall-1", turnId: "0:17", topic: "the name" }]);
    expect(timing.filter((one) => one["stage"] === "offer_reply")).toEqual([
      {
        stage: "offer_reply", atMs: 72_000, offer: "stall", offerId: "stall-1",
        turnId: "0:17", kind: "yes", latencyMs: 0,
      },
    ]);
    // The classifier is told what Sotto has in hand, whichever kind it is.
    expect(asked).toEqual([" Go on then. Anything. "]);
  });

  it("abandons an open offer when the session stops", async () => {
    const { window, asked, timing } = windowFor([yes]);
    window.offered(offered);
    window.stop();
    expect(window.isOpen()).toBe(false);
    expect(outcome(timing)).toBe("session_ended");
    window.acceptTurn(turn(" Go on. "));
    await tick();
    expect(asked).toEqual([]);
  });
});
