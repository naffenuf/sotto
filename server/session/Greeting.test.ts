/**
 * V2-009, on a simulated clock: what the hello does when it can be heard,
 * what it does when it cannot, and the one nudge for names.
 */
import { describe, expect, it } from "vitest";
import { SOTTO_SPEAKER, type PauseState, type TurnUpdate } from "../../shared/turns.js";
import type { StageCard } from "../../shared/cards.js";
import { SimulatedClock } from "../clock.js";
import { PAUSE_MS } from "../interject/policy.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "../voice/voiceOut.js";
import { Greeting, HELLO_UTTERANCE_ID, NAME_NUDGE_AFTER_MS, NAME_NUDGE_TEXT } from "./Greeting.js";

const quiet = { log: () => {}, warn: () => {} };

/** A voice that records what it was told to say and when it was cut off. */
class FakeVoice implements VoiceOut {
  said: string[] = [];
  opened = 0;
  cancelled = false;
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
      id: "voice-1",
      append: (text: string) => this.said.push(text),
      finish: () => finished,
      firstAudioMs: () => 300,
      cancel: () => {
        this.cancelled = true;
        this.resolve?.({
          reason: "cancelled",
          text: this.said.join(" "),
          spokenSoFar: "Hi, I'm Sotto.",
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
  greeting: Greeting;
  cards: StageCard[];
  spoken: TurnUpdate[];
  timing: Record<string, unknown>[];
  names: Record<string, string>;
  /** One final turn, after which the room is quiet from now. */
  speak(turnId: string, speaker: string, text: string): void;
  /** Somebody starts talking again. */
  talkOver(): void;
}

function setup(voice: VoiceOut | null, streamOffsetMs = 0): Harness {
  const clock = new SimulatedClock(0);
  const cards: StageCard[] = [];
  const spoken: TurnUpdate[] = [];
  const timing: Record<string, unknown>[] = [];
  const names: Record<string, string> = {};
  // The pause is derived from the clock, as the assembler's is: a session
  // starts in a quiet room, and a turn closing is what starts the next pause.
  const state: { quietSince: number | null } = { quietSince: 0 };
  const pauseState = (): PauseState =>
    state.quietSince === null
      ? { speaking: true, silentForMs: 0 }
      : { speaking: false, silentForMs: clock.now() - state.quietSince };
  const greeting = new Greeting({
    clock,
    voice,
    streamNow: () => streamOffsetMs + clock.now(),
    pauseState,
    names: () => names,
    onCard: (card) => cards.push(card),
    onSpoken: (turn) => spoken.push(turn),
    onTiming: (record) => timing.push(record),
    logger: quiet,
  });
  return {
    clock,
    greeting,
    cards,
    spoken,
    timing,
    names,
    speak: (turnId, speaker, text) => {
      state.quietSince = clock.now();
      greeting.acceptTurn(turn(turnId, speaker, text));
    },
    talkOver: () => {
      state.quietSince = null;
    },
  };
}

/** One final turn from a person. */
function turn(turnId: string, speaker: string, text: string): TurnUpdate {
  return {
    turnId,
    speaker,
    text,
    final: true,
    startMs: 0,
    endMs: 1_000,
    speakerMappingUncertain: false,
  };
}

describe("Greeting: the hello", () => {
  it("says the words in hello.md out loud, once", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.greeting.start();
    harness.greeting.start();
    await Promise.resolve();
    expect(voice.opened).toBe(1);
    expect(voice.said).toEqual([loadPrompt(PROMPTS.hello)]);
    // Spoken, so there is nothing on the stage to read.
    expect(harness.cards).toEqual([]);
  });

  it("introduces itself, says how to be addressed and asks for names", () => {
    const text = loadPrompt(PROMPTS.hello);
    expect(text).toMatch(/Sotto/);
    expect(text).toMatch(/listening/i);
    expect(text).toMatch(/just say "Sotto"/);
    expect(text).toMatch(/name/i);
    // Said out loud, so nothing in it is markdown or a URL.
    expect(text).not.toMatch(/[*#_[\]`]|https?:/);
  });

  it("writes what was said as a Sotto turn on the stream timeline", async () => {
    const voice = new FakeVoice();
    // A live session's clock counts from the start of the process, so the two
    // timelines are offset (V2-008a).
    const harness = setup(voice, 600_000);
    harness.clock.advanceBy(4_000);
    harness.greeting.start();
    await Promise.resolve();
    voice.played();
    await harness.greeting.flush();
    expect(harness.spoken).toHaveLength(1);
    const line = harness.spoken[0]!;
    expect(line.speaker).toBe(SOTTO_SPEAKER);
    expect(line.sotto).toBe(true);
    expect(line.final).toBe(true);
    expect(line.turnId).toContain(HELLO_UTTERANCE_ID);
    expect(line.text).toBe(loadPrompt(PROMPTS.hello));
    expect(line.startMs).toBe(604_000);
    expect(line.interrupted).toBeUndefined();
  });

  it("records only what the room heard when it was cut off", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.greeting.start();
    await Promise.resolve();
    harness.greeting.stop();
    await harness.greeting.flush();
    expect(voice.cancelled).toBe(true);
    expect(harness.spoken).toHaveLength(1);
    expect(harness.spoken[0]!.text).toBe("Hi, I'm Sotto.");
    expect(harness.spoken[0]!.interrupted).toBe(true);
  });

  it("shows a card instead when the voice is muted, and no transcript line", async () => {
    const voice = new FakeVoice("muted");
    const harness = setup(voice);
    harness.greeting.start();
    await harness.greeting.flush();
    expect(harness.cards).toHaveLength(1);
    expect(harness.cards[0]).toMatchObject({
      id: "notice-hello",
      variant: "notice",
      state: "ready",
      headline: loadPrompt(PROMPTS.hello),
    });
    // Nothing was heard, so nothing is written down (V2-008a).
    expect(harness.spoken).toEqual([]);
  });

  it("shows a card when there is no voice at all", async () => {
    const harness = setup(null);
    harness.greeting.start();
    await harness.greeting.flush();
    expect(harness.cards.map((card) => card.variant)).toEqual(["notice"]);
  });

  it("shows a card when the voice was there and failed", async () => {
    const harness = setup(new FakeVoice("broken"));
    harness.greeting.start();
    await harness.greeting.flush();
    expect(harness.cards.map((card) => card.id)).toEqual(["notice-hello"]);
  });

  it("says nothing at all once the session has been stopped", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.greeting.stop();
    harness.greeting.start();
    await harness.greeting.flush();
    expect(voice.opened).toBe(0);
    expect(harness.cards).toEqual([]);
  });
});

describe("Greeting: the name nudge", () => {
  /** Started, with one unnamed speaker having said something. */
  function talking(): Harness {
    const harness = setup(new FakeVoice("muted"));
    harness.greeting.start();
    harness.speak("s:1", "A", "So where are we on pricing?");
    return harness;
  }

  function nudges(harness: Harness): StageCard[] {
    return harness.cards.filter((card) => card.id === "notice-names");
  }

  it("waits two minutes, and then for a pause", () => {
    const harness = talking();
    harness.talkOver();
    harness.clock.advanceBy(NAME_NUDGE_AFTER_MS - 1);
    expect(nudges(harness)).toEqual([]);
    // Two minutes in, but somebody is mid-sentence: nothing yet.
    harness.clock.advanceBy(1);
    expect(nudges(harness)).toEqual([]);
    // The turn closes. The room has not been quiet long enough.
    harness.speak("s:2", "A", "…which we never settled.");
    expect(nudges(harness)).toEqual([]);
    harness.clock.advanceBy(PAUSE_MS - 1);
    expect(nudges(harness)).toEqual([]);
    // The pause reaches the policy's own threshold.
    harness.clock.advanceBy(1);
    expect(nudges(harness)).toHaveLength(1);
    expect(nudges(harness)[0]).toMatchObject({
      variant: "notice",
      state: "ready",
      headline: NAME_NUDGE_TEXT,
    });
  });

  it("asks at once when the deadline passes in a pause", () => {
    const harness = talking();
    harness.clock.advanceBy(NAME_NUDGE_AFTER_MS);
    expect(nudges(harness)).toHaveLength(1);
    expect(nudges(harness)[0]!.createdAtMs).toBe(NAME_NUDGE_AFTER_MS);
  });

  it("never asks twice", () => {
    const harness = talking();
    harness.clock.advanceBy(NAME_NUDGE_AFTER_MS);
    expect(nudges(harness)).toHaveLength(1);
    // More conversation, more pauses: still one.
    harness.speak("s:3", "B", "Sorry, where were we?");
    harness.clock.advanceBy(60_000);
    harness.speak("s:4", "B", "Right.");
    harness.clock.advanceBy(60_000);
    expect(nudges(harness)).toHaveLength(1);
  });

  it("does not ask when everybody who spoke has a name", () => {
    const harness = talking();
    harness.names["A"] = "Craig";
    harness.clock.advanceBy(NAME_NUDGE_AFTER_MS);
    expect(nudges(harness)).toEqual([]);
  });

  it("does not ask when nobody has spoken at all", () => {
    const harness = setup(new FakeVoice("muted"));
    harness.greeting.start();
    harness.clock.advanceBy(NAME_NUDGE_AFTER_MS);
    expect(nudges(harness)).toEqual([]);
  });

  it("stands down for good if the name arrives while it waits for a pause", () => {
    const harness = talking();
    harness.talkOver();
    harness.clock.advanceBy(NAME_NUDGE_AFTER_MS);
    expect(nudges(harness)).toEqual([]);
    harness.names["A"] = "Craig";
    harness.speak("s:2", "A", "…anyway.");
    harness.clock.advanceBy(PAUSE_MS);
    expect(nudges(harness)).toEqual([]);
    // Even if a second, still-unnamed speaker turns up later: the PRD's check
    // is at two minutes, once.
    harness.speak("s:3", "B", "Hello?");
    harness.clock.advanceBy(60_000);
    expect(nudges(harness)).toEqual([]);
  });

  it("asks about a second speaker who never gave a name", () => {
    const harness = talking();
    harness.names["A"] = "Craig";
    harness.speak("s:2", "B", "Two weeks, maybe three.");
    harness.clock.advanceBy(NAME_NUDGE_AFTER_MS);
    expect(nudges(harness)).toHaveLength(1);
    const nudge = harness.timing.find((record) => record["stage"] === "name_nudge");
    expect(nudge?.["unnamed"]).toEqual(["B"]);
  });

  it("does not count Sotto as somebody with no name", () => {
    const harness = setup(new FakeVoice("muted"));
    harness.greeting.start();
    harness.greeting.acceptTurn({
      turnId: "sotto:hello",
      speaker: SOTTO_SPEAKER,
      text: "Hi, I'm Sotto.",
      final: true,
      startMs: 0,
      endMs: 0,
      speakerMappingUncertain: false,
      sotto: true,
    });
    harness.clock.advanceBy(NAME_NUDGE_AFTER_MS);
    expect(nudges(harness)).toEqual([]);
  });

  it("stops asking when the session ends", () => {
    const harness = talking();
    harness.talkOver();
    harness.clock.advanceBy(NAME_NUDGE_AFTER_MS);
    harness.greeting.stop();
    harness.speak("s:2", "A", "…done.");
    harness.clock.advanceBy(PAUSE_MS);
    expect(nudges(harness)).toEqual([]);
  });
});
