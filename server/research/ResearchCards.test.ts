import { describe, expect, it } from "vitest";
import type { StageCard } from "../../shared/cards.js";
import {
  MAX_RESEARCH_CARDS_PER_WINDOW,
  RESEARCH_CARD_COOLDOWN_MS,
  RESEARCH_CARD_WINDOW_MS,
  RESEARCH_NO_ANSWER,
  type ResearchCardRecord,
  type ResearchIdea,
  type ResearchPendingRecord,
  type ResearchPacket,
} from "../../shared/research.js";
import { FREQUENCY_LIMITS } from "../../shared/policy.js";
import type { PauseState, TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import { PAUSE_MS } from "../interject/policy.js";
import { ResearchCards, cardForPacket, type ResearchCardsOptions } from "./ResearchCards.js";

const quiet = { log: () => {}, warn: () => {} };

function packet(overrides: Partial<ResearchPacket> = {}): ResearchPacket {
  return {
    id: "packet-1",
    ideaId: "idea-1",
    title: "Otter and Fireflies charge $8–19 a seat",
    teaser: "All three publish per-seat pricing, and two charge extra for analytics.",
    keyPoints: ["Otter Business is $20 a seat, $16 annually", "Granola is $10 a seat"],
    sources: [{ url: "https://otter.ai/pricing", title: "Otter.ai — Pricing" }],
    createdAtMs: 10_000,
    latencyMs: 14_000,
    ...overrides,
  };
}

/** A turn snapshot: the cards only read it as "look again". */
const snapshot: TurnUpdate = {
  turnId: "0:1",
  speaker: "A",
  speakerMappingUncertain: false,
  text: "line",
  final: false,
  startMs: 0,
  endMs: null,
};

interface Harness {
  clock: SimulatedClock;
  cards: ResearchCards;
  delivered: StageCard[];
  records: ResearchCardRecord[];
  /** The `pending` lines a question's thinking card wrote (V3-003). */
  pendings: ResearchPendingRecord[];
  /** Somebody starts talking. */
  speak: () => void;
  /** Everybody stops; the silence grows with the clock from here. */
  hush: () => void;
}

/**
 * Cards over a pause the clock decides, which is the real thing: silence is
 * measured off the stream rather than announced, so a timer firing into a
 * still-quiet room sees a longer pause than the one that armed it.
 */
function harness(options: Partial<ResearchCardsOptions> = {}): Harness {
  const clock = new SimulatedClock(0);
  const delivered: StageCard[] = [];
  const records: ResearchCardRecord[] = [];
  const pendings: ResearchPendingRecord[] = [];
  const state = { speaking: true, quietSince: 0 };
  const pauseState = (): PauseState =>
    state.speaking
      ? { speaking: true, silentForMs: 0 }
      : { speaking: false, silentForMs: clock.now() - state.quietSince };
  const cards = new ResearchCards({
    clock,
    pauseState,
    onDeliver: (card) => delivered.push(card),
    onRecord: (record) => {
      if (record.kind === "pending") pendings.push(record);
      else records.push(record);
    },
    logger: quiet,
    ...options,
  });
  return {
    clock,
    cards,
    delivered,
    records,
    pendings,
    speak: () => {
      state.speaking = true;
      cards.acceptTurn(snapshot);
    },
    hush: () => {
      state.speaking = false;
      state.quietSince = clock.now();
      cards.acceptTurn(snapshot);
    },
  };
}

describe("cardForPacket", () => {
  it("lays a packet out as the PRD's compact card", () => {
    const card = cardForPacket(packet(), 12_345);
    expect(card).toEqual({
      id: "research-packet-1",
      variant: "research",
      state: "ready",
      createdAtMs: 12_345,
      headline: "Research ready: Otter and Fireflies charge $8–19 a seat",
      teaser: "All three publish per-seat pricing, and two charge extra for analytics.",
      // V3-017: a finding Sotto has not said out loud is one of the things
      // the room can call on it for.
      raised: true,
      detailMd: "- Otter Business is $20 a seat, $16 annually\n- Granola is $10 a seat",
      citations: [{ url: "https://otter.ai/pricing", title: "Otter.ai — Pricing" }],
    });
  });

  it("puts the visual in the frame an answer's artifact uses", () => {
    const card = cardForPacket(
      packet({
        visual: { title: "Per-seat pricing", url: "/api/sessions/s1/artifacts/01-pricing.html", path: "artifacts/01-pricing.html" },
      }),
      1,
    );
    expect(card.artifacts).toEqual([
      { title: "Per-seat pricing", url: "/api/sessions/s1/artifacts/01-pricing.html" },
    ]);
  });

  it("leaves out what a packet does not have", () => {
    const card = cardForPacket(packet({ keyPoints: [], sources: [] }), 1);
    expect(card.detailMd).toBeUndefined();
    expect(card.citations).toBeUndefined();
    expect(card.artifacts).toBeUndefined();
  });
});

describe("ResearchCards", () => {
  it("holds a packet while somebody is talking and shows it in the pause", () => {
    const h = harness();
    h.speak();
    h.cards.accept(packet());
    expect(h.delivered).toHaveLength(0);
    expect(h.cards.waitingCount()).toBe(1);

    h.hush();
    h.clock.advanceBy(PAUSE_MS);
    expect(h.delivered.map((card) => card.id)).toEqual(["research-packet-1"]);
    expect(h.cards.waitingCount()).toBe(0);
  });

  it("waits out the rest of a pause that is still too short", () => {
    const h = harness();
    h.hush();
    h.clock.advanceBy(200);
    h.cards.accept(packet());
    expect(h.delivered).toHaveLength(0);

    // Nothing arrives to say the room went on being quiet, so the timer does.
    h.clock.advanceBy(PAUSE_MS - 200 - 1);
    expect(h.delivered).toHaveLength(0);
    h.clock.advanceBy(1);
    expect(h.delivered).toHaveLength(1);
  });

  it("shows a packet that arrives during a pause straight away", () => {
    const h = harness();
    h.hush();
    h.clock.advanceBy(5_000);
    h.cards.accept(packet());
    expect(h.delivered).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      kind: "card",
      packetId: "packet-1",
      ideaId: "idea-1",
      heldForMs: 0,
      waiting: 0,
      shownInWindow: 1,
    });
    expect(h.records[0]?.atSessionEnd).toBeUndefined();
  });

  it("keeps two packets out of the same pause, and shows the second one after the cooldown", () => {
    const h = harness();
    h.hush();
    h.clock.advanceBy(5_000);
    h.cards.accept(packet());
    h.cards.accept(packet({ id: "packet-2", ideaId: "idea-2" }));
    expect(h.delivered.map((card) => card.id)).toEqual(["research-packet-1"]);

    // Still quiet, still inside the cooldown.
    h.clock.advanceBy(RESEARCH_CARD_COOLDOWN_MS - 1);
    expect(h.delivered).toHaveLength(1);
    h.clock.advanceBy(2);
    expect(h.delivered.map((card) => card.id)).toEqual([
      "research-packet-1",
      "research-packet-2",
    ]);
    expect(h.records[1]).toMatchObject({
      packetId: "packet-2",
      heldForMs: RESEARCH_CARD_COOLDOWN_MS,
    });
  });

  it("takes its cooldown and cap from the frequency setting (V2-017)", () => {
    const h = harness({ limits: FREQUENCY_LIMITS.rare });
    h.hush();
    h.clock.advanceBy(PAUSE_MS);
    h.cards.accept(packet({ id: "packet-1" }));
    h.cards.accept(packet({ id: "packet-2" }));
    // `rare`'s two-minute cooldown holds the second one back where `normal`'s
    // minute would have let it through by now.
    h.clock.advanceBy(FREQUENCY_LIMITS.normal.researchCardCooldownMs);
    expect(h.delivered.map((card) => card.id)).toEqual(["research-packet-1"]);

    // Turning the frequency up releases it on the spot, as the policy does.
    h.cards.setLimits(FREQUENCY_LIMITS.often);
    expect(h.delivered.map((card) => card.id)).toEqual([
      "research-packet-1",
      "research-packet-2",
    ]);
  });

  it("is a budget of its own: the cap per window holds the next card back", () => {
    const h = harness({
      limits: {
        ...FREQUENCY_LIMITS.normal,
        researchCardCooldownMs: 0,
        maxResearchCardsPerWindow: 2,
      },
      windowMs: 10_000,
    });
    h.hush();
    h.clock.advanceBy(5_000);
    h.cards.accept(packet({ id: "packet-1" }));
    h.cards.accept(packet({ id: "packet-2" }));
    h.cards.accept(packet({ id: "packet-3" }));
    expect(h.delivered.map((card) => card.id)).toEqual([
      "research-packet-1",
      "research-packet-2",
    ]);
    expect(h.cards.waitingCount()).toBe(1);

    // The window frees with the clock, and nothing arrives to say so.
    h.clock.advanceBy(10_001);
    expect(h.delivered.map((card) => card.id)).toEqual([
      "research-packet-1",
      "research-packet-2",
      "research-packet-3",
    ]);
  });

  it("shows what is still waiting when the conversation ends, pause or no pause", () => {
    const h = harness();
    h.speak();
    h.cards.accept(packet({ id: "packet-1" }));
    h.cards.accept(packet({ id: "packet-2" }));
    expect(h.delivered).toHaveLength(0);

    h.cards.flush();
    expect(h.delivered.map((card) => card.id)).toEqual([
      "research-packet-1",
      "research-packet-2",
    ]);
    expect(h.records.every((record) => record.atSessionEnd === true)).toBe(true);
  });

  it("stops for good", () => {
    const h = harness();
    h.cards.stop();
    h.cards.accept(packet());
    h.hush();
    h.clock.advanceBy(5_000);
    h.cards.flush();
    expect(h.delivered).toHaveLength(0);
  });

  it("reconsiders when playback ends without a turn arriving", () => {
    const state = { playing: true };
    const clock = new SimulatedClock(0);
    const delivered: StageCard[] = [];
    const cards = new ResearchCards({
      clock,
      // What `SessionTranscription.pauseState` does with playback (V2-006).
      pauseState: () =>
        state.playing ? { speaking: true, silentForMs: 0 } : { speaking: false, silentForMs: 5_000 },
      onDeliver: (card) => delivered.push(card),
      onRecord: () => {},
      logger: quiet,
    });
    cards.accept(packet());
    expect(delivered).toHaveLength(0);

    state.playing = false;
    cards.playbackChanged();
    expect(delivered).toHaveLength(1);
  });

  it("brings a card already on the stage forward, open, when it is asked for", () => {
    const h = harness();
    h.hush();
    h.clock.advanceBy(PAUSE_MS);
    h.cards.accept(packet());
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.forward).toBeUndefined();

    h.clock.advanceBy(5_000);
    h.cards.bringForward([packet()]);
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.id).toBe("research-packet-1");
    expect(h.delivered[1]?.forward).toBe(true);
    const record = h.records.at(-1);
    expect(record?.broughtForward).toBe(true);
    expect(record?.atMs).toBe(PAUSE_MS + 5_000);
  });

  it("shows a packet nobody has seen yet the moment it is asked for, mid-sentence", () => {
    const h = harness();
    h.speak();
    h.cards.accept(packet());
    expect(h.delivered).toHaveLength(0);

    h.cards.bringForward([packet()]);
    expect(h.delivered.map((card) => card.forward)).toEqual([true]);
    expect(h.records.at(-1)?.heldForMs).toBe(0);
    // Taken out of the queue, so it cannot appear again later as though new.
    expect(h.cards.waitingCount()).toBe(0);
    h.hush();
    h.clock.advanceBy(RESEARCH_CARD_WINDOW_MS);
    expect(h.delivered).toHaveLength(1);
  });

  it("spends none of the unsolicited budget on a card the group asked for", () => {
    const h = harness();
    h.cards.bringForward([packet(), packet({ id: "packet-2" })]);
    expect(h.delivered).toHaveLength(2);
    expect(h.cards.shown()).toEqual([]);

    // The next finding of its own still goes out at once: nothing is on cooldown.
    h.hush();
    h.clock.advanceBy(PAUSE_MS);
    h.cards.accept(packet({ id: "packet-3" }));
    expect(h.delivered.map((card) => card.id).at(-1)).toBe("research-packet-3");
  });

  it("says nothing once the session is over", () => {
    const h = harness();
    h.cards.stop();
    h.cards.bringForward([packet()]);
    expect(h.delivered).toHaveLength(0);
  });

  it("keeps the shipped budget separate from the interjection one", () => {
    expect(RESEARCH_CARD_COOLDOWN_MS).toBeLessThan(RESEARCH_CARD_WINDOW_MS);
    expect(MAX_RESEARCH_CARDS_PER_WINDOW).toBeGreaterThan(0);
  });
});

/**
 * V3-003: the card for a question the room wondered aloud, which goes up
 * before the search has started and fills in when it comes back.
 */
describe("the card a question puts up (V3-003)", () => {
  const idea: ResearchIdea = {
    id: "idea-1",
    topic: "the drive time",
    question: "How long is the drive from the city to the farmhouse venue?",
    why: "Craig wondered this aloud and nobody in the room knew.",
    sourceTurnIds: ["0:12"],
    askedAtMs: 4_000,
  };

  it("goes up at once, mid-sentence, with a thinking indicator", () => {
    const h = harness();
    // Deliberately while somebody is talking: the room asked, so there is
    // nothing unsolicited here to wait for a pause with.
    const cardId = h.cards.pending(idea);

    expect(cardId).toBe("research-idea-1");
    expect(h.delivered).toEqual([
      {
        id: "research-idea-1",
        variant: "research",
        state: "thinking",
        createdAtMs: 0,
        headline: "Looking up: How long is the drive from the city to the farmhouse venue?",
      },
    ]);
    expect(h.pendings[0]).toEqual({
      kind: "pending",
      atMs: 0,
      ideaId: "idea-1",
      cardId: "research-idea-1",
      question: idea.question,
    });
    // Nothing was spent: it is not an unsolicited card.
    expect(h.cards.shown()).toEqual([]);
  });

  it("fills the same card in when the packet lands, without waiting for a pause", () => {
    const h = harness();
    h.cards.pending(idea);
    h.clock.advanceBy(21_000);
    h.cards.accept(packet());

    expect(h.delivered).toHaveLength(2);
    const filled = h.delivered[1] as StageCard;
    expect(filled.id).toBe("research-idea-1");
    expect(filled.state).toBe("ready");
    expect(filled.headline).toBe("Research ready: Otter and Fireflies charge $8–19 a seat");
    expect(h.cards.waitingCount()).toBe(0);
    expect(h.records[0]).toMatchObject({
      kind: "card",
      packetId: "packet-1",
      ideaId: "idea-1",
      cardId: "research-idea-1",
      // Measured from the question, which is the wait the room really had.
      heldForMs: 21_000,
      filledIn: true,
    });
    expect(h.cards.shown()).toEqual([]);
  });

  it("leaves a packet nobody asked for to the pause rule", () => {
    const h = harness();
    h.cards.pending(idea);
    h.cards.accept(packet({ id: "packet-2", ideaId: "idea-9" }));
    expect(h.delivered.map((card) => card.id)).toEqual(["research-idea-1"]);
    expect(h.cards.waitingCount()).toBe(1);
  });

  it("stops the spinner when the search comes back with nothing", () => {
    const h = harness();
    h.cards.pending(idea);
    h.cards.failed("idea-1");

    const said = h.delivered[1] as StageCard;
    expect(said.id).toBe("research-idea-1");
    expect(said.state).toBe("error");
    expect(said.message).toBe(RESEARCH_NO_ANSWER);
    // And a packet arriving afterwards is an ordinary one again.
    h.cards.failed("idea-1");
    expect(h.delivered).toHaveLength(2);
  });

  it("answers a repeated question from the packet already on the stage", () => {
    const h = harness();
    const first = packet();
    h.cards.reuse({ ...idea, id: "idea-2" }, first);

    expect(h.pendings[0]).toMatchObject({
      ideaId: "idea-2",
      cardId: "research-packet-1",
      reusedPacketId: "packet-1",
    });
    const shown = h.delivered[0] as StageCard;
    expect(shown.id).toBe("research-packet-1");
    expect(shown.state).toBe("ready");
    expect(shown.forward).toBe(true);
    expect(h.cards.shown()).toEqual([]);
  });

  it("says nothing once the session is over", () => {
    const h = harness();
    h.cards.stop();
    h.cards.pending(idea);
    h.cards.reuse(idea, packet());
    h.cards.failed("idea-1");
    expect(h.delivered).toHaveLength(0);
  });
});

describe("offering a finding nobody asked for (V3-005)", () => {
  const idea: ResearchIdea = {
    id: "idea-1",
    topic: "the drive time",
    question: "How long is the drive from the city to the farmhouse venue?",
    why: "Craig wondered this aloud and nobody in the room knew.",
    sourceTurnIds: ["0:12"],
    askedAtMs: 4_000,
  };

  /** Every packet whose card came with an offer, and the card it came with. */
  function offering(): { offered: { id: string; cardId: string }[]; h: Harness } {
    const offered: { id: string; cardId: string }[] = [];
    const h = harness({ onOffer: (one, cardId) => offered.push({ id: one.id, cardId }) });
    return { offered, h };
  }

  it("offers the card the pause let through", () => {
    const { offered, h } = offering();
    h.cards.accept(packet());
    h.hush();
    h.clock.advanceBy(PAUSE_MS);
    h.cards.acceptTurn(snapshot);

    expect(h.delivered).toHaveLength(1);
    expect(offered).toEqual([{ id: "packet-1", cardId: "research-packet-1" }]);
  });

  it("does not offer a question's own card: V3-004 speaks the answer instead", () => {
    const { offered, h } = offering();
    h.cards.pending(idea);
    h.cards.accept(packet());

    expect(h.delivered).toHaveLength(2);
    expect(offered).toEqual([]);
  });

  it("does not offer a card the room asked for: it is already being read out", () => {
    const { offered, h } = offering();
    h.cards.bringForward([packet()]);

    expect(h.delivered).toHaveLength(1);
    expect(offered).toEqual([]);
  });

  it("does not offer what the end of the session pushed out", () => {
    const { offered, h } = offering();
    h.cards.accept(packet());
    h.cards.flush();

    expect(h.delivered).toHaveLength(1);
    expect(offered).toEqual([]);
  });
});
