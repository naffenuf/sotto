import { describe, expect, it } from "vitest";
import type { StageCard } from "../../shared/cards.js";
import {
  MAX_RESEARCH_CARDS_PER_WINDOW,
  RESEARCH_CARD_COOLDOWN_MS,
  RESEARCH_CARD_WINDOW_MS,
  type ResearchCardRecord,
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
  const state = { speaking: true, quietSince: 0 };
  const pauseState = (): PauseState =>
    state.speaking
      ? { speaking: true, silentForMs: 0 }
      : { speaking: false, silentForMs: clock.now() - state.quietSince };
  const cards = new ResearchCards({
    clock,
    pauseState,
    onDeliver: (card) => delivered.push(card),
    onRecord: (record) => records.push(record),
    logger: quiet,
    ...options,
  });
  return {
    clock,
    cards,
    delivered,
    records,
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
