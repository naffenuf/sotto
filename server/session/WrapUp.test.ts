/**
 * V2-018 out loud: what "Sotto, wrap us up" does when it can be heard, when
 * it cannot, and when somebody cuts it off.
 */
import { describe, expect, it } from "vitest";
import type { StageCard } from "../../shared/cards.js";
import { SOTTO_SPEAKER, type TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "../voice/voiceOut.js";
import type { DigestSpoken } from "./digest.js";
import { WRAP_UP_HEADLINE, WrapUp } from "./WrapUp.js";

const quiet = { log: () => {}, warn: () => {} };

/**
 * Lets the utterance open. Not `clock.settle()`: an utterance nobody has
 * played yet is a task the clock is tracking, so settling on it would wait
 * for the thing the test is about to do.
 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const SUMMARY = "Here's where we got to. You decided one thing: Thursday is the day.";

/** A voice that records what it was told to say and when it was cut off. */
class FakeVoice implements VoiceOut {
  said: string[] = [];
  opened = 0;
  cancelled = 0;
  private resolve: ((spoken: VoiceSpoken) => void) | undefined;

  constructor(private readonly behaviour: "speaks" | "muted" | "broken" = "speaks") {}

  async begin(): Promise<VoiceUtterance | null> {
    if (this.behaviour === "muted") return null;
    if (this.behaviour === "broken") throw new Error("no ElevenLabs key");
    this.opened += 1;
    const finished = new Promise<VoiceSpoken>((resolve) => {
      this.resolve = resolve;
    });
    return {
      id: `voice-${this.opened}`,
      append: (text: string) => this.said.push(text),
      finish: () => finished,
      firstAudioMs: () => 300,
      cancel: () => {
        this.cancelled += 1;
        this.resolve?.({
          reason: "cancelled",
          text: this.said.join(" "),
          spokenSoFar: "Here's where we got to.",
          firstAudioMs: 300,
        });
      },
    };
  }

  /** The page has played all of it. */
  played(): void {
    this.resolve?.({
      reason: "complete",
      text: this.said.join(" "),
      spokenSoFar: this.said.join(" "),
      firstAudioMs: 300,
    });
  }
}

interface Harness {
  clock: SimulatedClock;
  wrapUp: WrapUp;
  cards: StageCard[];
  spoken: TurnUpdate[];
  said: DigestSpoken[];
  timing: Record<string, unknown>[];
}

function setup(voice: VoiceOut | null, summary = SUMMARY): Harness {
  const clock = new SimulatedClock(0);
  const cards: StageCard[] = [];
  const spoken: TurnUpdate[] = [];
  const said: DigestSpoken[] = [];
  const timing: Record<string, unknown>[] = [];
  const wrapUp = new WrapUp({
    clock,
    voice,
    // A live session's stream runs ahead of the clock's origin (V2-008a).
    streamNow: () => clock.now() + 60_000,
    summary: () => summary,
    onCard: (card) => cards.push(card),
    onSpoken: (turn) => spoken.push(turn),
    onSaid: (entry) => said.push(entry),
    onTiming: (record) => timing.push(record),
    logger: quiet,
  });
  return { clock, wrapUp, cards, spoken, said, timing };
}

const asked = { question: "wrap us up", askedBy: "Craig", turnId: "s:12" };

describe("WrapUp (V2-018)", () => {
  it("says the summary out loud and writes Sotto's line where playback began", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.wrapUp.ask(asked);
    await tick();
    expect(voice.said).toEqual([SUMMARY]);
    voice.played();
    await harness.wrapUp.flush();
    expect(harness.cards).toEqual([]);
    expect(harness.spoken).toHaveLength(1);
    expect(harness.spoken[0]).toMatchObject({
      speaker: SOTTO_SPEAKER,
      sotto: true,
      final: true,
      text: SUMMARY,
      startMs: 60_000,
    });
    expect(harness.spoken[0]?.interrupted).toBeUndefined();
    expect(harness.said[0]).toMatchObject({
      question: "wrap us up",
      askedBy: "Craig",
      headline: WRAP_UP_HEADLINE,
      interrupted: false,
    });
    expect(harness.timing.map((record) => record["stage"])).toEqual(["wrap_up", "wrap_up_spoken"]);
  });

  it("shows it instead when there is nothing to play it", async () => {
    const harness = setup(new FakeVoice("muted"));
    harness.wrapUp.ask(asked);
    await harness.wrapUp.flush();
    expect(harness.cards).toHaveLength(1);
    expect(harness.cards[0]).toMatchObject({
      variant: "notice",
      state: "ready",
      headline: WRAP_UP_HEADLINE,
      detailMd: SUMMARY,
    });
    // Spoken or shown, never both: the card is the record of it.
    expect(harness.spoken).toEqual([]);
    expect(harness.said[0]?.spoken).toBe(SUMMARY);
  });

  it("shows it when the voice was there and broke", async () => {
    const harness = setup(new FakeVoice("broken"));
    harness.wrapUp.ask(asked);
    await harness.wrapUp.flush();
    expect(harness.cards).toHaveLength(1);
  });

  it("writes down only what the room heard when somebody cuts it off", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.wrapUp.ask(asked);
    await tick();
    harness.wrapUp.stop();
    await harness.wrapUp.flush();
    expect(voice.cancelled).toBe(1);
    expect(harness.spoken[0]).toMatchObject({
      text: "Here's where we got to.",
      interrupted: true,
    });
    expect(harness.said[0]?.interrupted).toBe(true);
  });

  it("says the second request rather than two at once", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.wrapUp.ask(asked);
    await tick();
    harness.wrapUp.ask({ ...asked, question: "sum it up again" });
    await tick();
    voice.played();
    await harness.wrapUp.flush();
    expect(voice.opened).toBe(2);
    expect(harness.said.map((entry) => entry.question)).toEqual(["wrap us up", "sum it up again"]);
  });

  it("says nothing once the session has ended", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.wrapUp.stop();
    harness.wrapUp.ask(asked);
    await harness.wrapUp.flush();
    expect(voice.opened).toBe(0);
    expect(harness.cards).toEqual([]);
  });
});
