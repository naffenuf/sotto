/**
 * V3-015 on a simulated clock: when Sotto claims a question out loud, when it
 * stays quiet, and what happens when the search comes back with nothing.
 */
import { describe, expect, it } from "vitest";
import { FREQUENCY_LIMITS, type PolicySettings } from "../../shared/policy.js";
import { RESEARCH_NO_ANSWER, type ResearchIdea } from "../../shared/research.js";
import { SOTTO_SPEAKER, type PauseState, type TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import { PAUSE_MS, type SpendVerdict } from "../interject/policy.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "../voice/voiceOut.js";
import {
  RESERVE_WINDOW_MS,
  Reservations,
  noAnswerLine,
  reserveLine,
  reserveUtteranceId,
  type SpokenContributionRecord,
} from "./Reservations.js";

const quiet = { log: () => {}, warn: () => {} };

/** A voice that records what it was told to say, and when it was cut off. */
class FakeVoice implements VoiceOut {
  said: string[] = [];
  opened = 0;
  cancelled = 0;
  private resolve: ((spoken: VoiceSpoken) => void) | undefined;
  private text = "";

  constructor(private readonly behaviour: "speaks" | "muted" | "broken" = "speaks") {}

  async begin(): Promise<VoiceUtterance | null> {
    if (this.behaviour === "muted") return null;
    if (this.behaviour === "broken") throw new Error("no ElevenLabs key");
    this.opened += 1;
    this.text = "";
    const finished = new Promise<VoiceSpoken>((resolve) => {
      this.resolve = resolve;
    });
    return {
      id: `voice-${this.opened}`,
      append: (text: string) => {
        this.text = text;
        this.said.push(text);
      },
      finish: () => finished,
      firstAudioMs: () => 300,
      cancel: () => {
        this.cancelled += 1;
        // Half of it was heard before the room took the floor back.
        this.resolve?.({
          reason: "cancelled",
          text: this.text,
          spokenSoFar: this.text.slice(0, 7),
          firstAudioMs: 300,
        });
      },
    };
  }

  /** The page played all of it. */
  played(): void {
    this.resolve?.({
      reason: "complete",
      text: this.text,
      spokenSoFar: this.text,
      firstAudioMs: 300,
    });
  }
}

interface Harness {
  clock: SimulatedClock;
  reservations: Reservations;
  records: SpokenContributionRecord[];
  spoken: TurnUpdate[];
  settings: PolicySettings;
  /** What the frequency's cooldown and allowance say right now. */
  spend: { verdict: SpendVerdict; spent: number };
  /** Somebody is talking. */
  speak: () => void;
  /** Everybody stops; the silence grows with the clock from here. */
  hush: () => void;
  /** Lets the voice's promises settle. */
  tick: () => Promise<void>;
}

function setup(
  voice: VoiceOut | null,
  options: {
    settings?: Partial<PolicySettings>;
    verdict?: SpendVerdict;
    answering?: () => boolean;
    isCurrent?: (ideaId: string) => boolean;
    streamOffsetMs?: number;
  } = {},
): Harness {
  const clock = new SimulatedClock(0);
  const records: SpokenContributionRecord[] = [];
  const spoken: TurnUpdate[] = [];
  const settings: PolicySettings = {
    frequency: "normal",
    boldness: "normal",
    ...options.settings,
  };
  const spend = { verdict: options.verdict ?? ("ok" as SpendVerdict), spent: 0 };
  // The room is quiet when the session opens, and the silence grows with the
  // clock — exactly what the assembler's pause state does.
  const state: { quietSince: number | null } = { quietSince: 0 };
  const pauseState = (): PauseState =>
    state.quietSince === null
      ? { speaking: true, silentForMs: 0 }
      : { speaking: false, silentForMs: clock.now() - state.quietSince };
  const reservations = new Reservations({
    clock,
    voice,
    pauseState,
    streamNow: () => (options.streamOffsetMs ?? 0) + clock.now(),
    settings: () => settings,
    allowed: () => spend.verdict,
    noteContribution: () => {
      spend.spent += 1;
    },
    onSpoken: (turn) => spoken.push(turn),
    onRecord: (record) => records.push(record),
    ...(options.answering === undefined ? {} : { answering: options.answering }),
    ...(options.isCurrent === undefined ? {} : { isCurrent: options.isCurrent }),
    logger: quiet,
  });
  return {
    clock,
    reservations,
    records,
    spoken,
    settings,
    spend,
    speak: () => {
      state.quietSince = null;
      reservations.acceptTurn(partial());
    },
    hush: () => {
      state.quietSince = clock.now();
      reservations.acceptTurn(partial());
    },
    tick: async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/** A turn snapshot: the reservations only read it as "look again". */
function partial(): TurnUpdate {
  return {
    turnId: "0:1",
    speaker: "A",
    speakerMappingUncertain: false,
    text: "line",
    final: false,
    startMs: 0,
    endMs: null,
  };
}

const idea: ResearchIdea = {
  id: "idea-1",
  topic: "drive time",
  question: "How long is the drive from the city to the farmhouse?",
  why: "They are picking a departure time.",
  sourceTurnIds: ["0:4"],
  askedAtMs: 0,
};

/** The question, as `SessionManager.noticeQuestion` hands it over. */
function asked(atMs = 0): { turnId: string; topic: string; askedAtMs: number } {
  return { turnId: "0:4", topic: "drive time", askedAtMs: atMs };
}

describe("Reservations: the line", () => {
  it("writes the claim and the closing line from the topic", () => {
    expect(reserveLine("drive time")).toBe("I'll check the drive time.");
    expect(noAnswerLine("drive time")).toBe("Nothing solid on the drive time, sorry.");
  });

  it("leaves a name or a determiner alone, and never says 'the the'", () => {
    expect(reserveLine("Loom pricing")).toBe("I'll check Loom pricing.");
    expect(reserveLine("the UK market size")).toBe("I'll check the UK market size.");
    expect(reserveLine("whether they open on Thursdays")).toBe(
      "I'll check whether they open on Thursdays.",
    );
    expect(reserveLine("  drive time?  ")).toBe("I'll check the drive time.");
    expect(reserveLine("")).toBe("I'll check that.");
  });

  it("says nothing a listener has to read: no markdown and no URL", () => {
    const line = reserveLine("competitor pricing");
    expect(line).not.toMatch(/[*#_[\]`]|https?:/);
  });
});

describe("Reservations: claiming a question", () => {
  it("speaks at the first gap after the question", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    // Somebody is still talking when the verdict arrives.
    harness.speak();
    harness.reservations.claim(idea, asked());
    await harness.tick();
    expect(voice.opened).toBe(0);

    harness.clock.advanceBy(500);
    harness.hush();
    await harness.tick();
    // The room has only just stopped: not a gap yet.
    expect(voice.opened).toBe(0);

    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(1);
    expect(voice.said).toEqual(["I'll check the drive time."]);
  });

  it("is the contribution for budget purposes, spent once", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(harness.spend.spent).toBe(1);
  });

  it("records the claim with its latency and no yield", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.clock.advanceBy(2_000);
    harness.reservations.claim(idea, asked(0));
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    const record = harness.records[0]!;
    expect(record).toMatchObject({
      stage: "spoken_contribution",
      kind: "reserve",
      ideaId: "idea-1",
      turnId: "0:4",
      topic: "drive time",
      spoken: true,
      text: "I'll check the drive time.",
      questionToReserveMs: 2_000,
      yielded: false,
    });
  });

  it("writes what was said as a Sotto turn on the stream timeline", async () => {
    const voice = new FakeVoice();
    // A live session's clock counts from the start of the process (V2-008a).
    const harness = setup(voice, { streamOffsetMs: 600_000 });
    harness.clock.advanceBy(4_000);
    harness.reservations.claim(idea, asked());
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(harness.spoken).toHaveLength(1);
    const line = harness.spoken[0]!;
    expect(line.speaker).toBe(SOTTO_SPEAKER);
    expect(line.sotto).toBe(true);
    expect(line.final).toBe(true);
    expect(line.turnId).toContain(reserveUtteranceId("reserve", "idea-1"));
    expect(line.text).toBe("I'll check the drive time.");
    expect(line.startMs).toBe(604_000);
    expect(line.interrupted).toBeUndefined();
  });

  it("says nothing when no gap arrives inside the window", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.speak();
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(RESERVE_WINDOW_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records).toHaveLength(1);
    expect(harness.records[0]).toMatchObject({ spoken: false, reason: "no_gap" });
    // And it is not said in the pause that comes afterwards either.
    harness.hush();
    harness.clock.advanceBy(10_000);
    await harness.tick();
    expect(voice.opened).toBe(0);
  });

  it("stays quiet while Sotto is already answering somebody", async () => {
    const voice = new FakeVoice();
    const answering = { now: true };
    const harness = setup(voice, { answering: () => answering.now });
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    answering.now = false;
    harness.reservations.acceptTurn(partial());
    await harness.tick();
    expect(voice.opened).toBe(1);
  });

  it("says nothing when the frequency's budget is spent", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { verdict: "budget" });
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.spend.spent).toBe(0);
    expect(harness.records[0]).toMatchObject({ spoken: false, reason: "budget" });
  });

  it("says nothing inside the frequency's cooldown", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { verdict: "cooldown" });
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({ spoken: false, reason: "cooldown" });
    // The numbers are the frequency's, not this module's.
    expect(FREQUENCY_LIMITS.normal.cooldownMs).toBeGreaterThan(RESERVE_WINDOW_MS);
  });

  it("says nothing at boldness cautious", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { settings: { boldness: "cautious" } });
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.spend.spent).toBe(0);
    expect(harness.records[0]).toMatchObject({ spoken: false, reason: "boldness" });
  });

  it("spends nothing when nobody could hear it", async () => {
    const harness = setup(new FakeVoice("muted"));
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    await harness.reservations.flush();
    expect(harness.spend.spent).toBe(0);
    expect(harness.spoken).toEqual([]);
    expect(harness.records[0]).toMatchObject({ spoken: false, reason: "unheard" });
  });

  it("survives a voice that was there and broke", async () => {
    const harness = setup(new FakeVoice("broken"));
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({ spoken: false, reason: "unheard" });
  });

  it("says one claim at a time", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.reservations.claim(idea, asked());
    harness.reservations.claim({ ...idea, id: "idea-2" }, { ...asked(), topic: "ferry times" });
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(1);
    voice.played();
    await harness.tick();
    // The second one is still inside its window, and the room is still quiet.
    expect(voice.opened).toBe(2);
    expect(voice.said[1]).toBe("I'll check the ferry times.");
  });
});

describe("Reservations: yielding", () => {
  it("stops the moment a human voice arrives, and keeps what was heard", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(1);

    harness.reservations.yieldToHuman();
    await harness.reservations.flush();
    expect(voice.cancelled).toBe(1);
    const record = harness.records[0]!;
    expect(record).toMatchObject({ kind: "reserve", spoken: true, yielded: true });
    expect(record.heard).toBe("I'll ch");
    const line = harness.spoken[0]!;
    expect(line.text).toBe("I'll ch");
    expect(line.interrupted).toBe(true);
  });

  it("is never retried", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    harness.reservations.yieldToHuman();
    await harness.reservations.flush();
    harness.clock.advanceBy(1_000);
    harness.hush();
    harness.clock.advanceBy(10_000);
    await harness.tick();
    expect(voice.opened).toBe(1);
  });

  it("ignores a voice when Sotto is not saying anything", () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.reservations.yieldToHuman();
    expect(voice.cancelled).toBe(0);
  });

  it("does not count a stopped session as a yield", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    harness.reservations.stop();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({ kind: "reserve", yielded: false });
  });
});

describe("Reservations: nothing came back", () => {
  /** A claim the room heard, which is what a closing line needs. */
  async function claimed(voice: FakeVoice, harness: Harness): Promise<void> {
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    harness.records.length = 0;
    harness.spoken.length = 0;
  }

  it("closes the loop at the next real pause", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    await claimed(voice, harness);
    // The search comes back with nothing, mid-sentence.
    harness.speak();
    harness.clock.advanceBy(20_000);
    harness.reservations.noAnswer(idea.id);
    await harness.tick();
    expect(voice.opened).toBe(1);

    harness.hush();
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.said.at(-1)).toBe("Nothing solid on the drive time, sorry.");
    voice.played();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({
      kind: "no_answer",
      spoken: true,
      text: "Nothing solid on the drive time, sorry.",
    });
    expect(harness.spoken[0]!.text).toBe("Nothing solid on the drive time, sorry.");
  });

  it("spends no second contribution: it is the claim's completion", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { verdict: "ok" });
    await claimed(voice, harness);
    harness.spend.verdict = "cooldown";
    harness.reservations.noAnswer(idea.id);
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({ kind: "no_answer", spoken: true });
    expect(harness.spend.spent).toBe(1);
  });

  it("says nothing when the room has moved on", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { isCurrent: () => false });
    await claimed(voice, harness);
    harness.reservations.noAnswer(idea.id);
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(1);
    expect(harness.records[0]).toMatchObject({
      kind: "no_answer",
      spoken: false,
      reason: "moved_on",
    });
  });

  it("drops a claim the search got in front of", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.speak();
    harness.reservations.claim(idea, asked());
    // The search fails before a gap ever arrived, so there is nothing left to
    // claim — and nothing to take back either.
    harness.reservations.noAnswer(idea.id);
    harness.hush();
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records).toHaveLength(1);
    expect(harness.records[0]).toMatchObject({
      kind: "reserve",
      spoken: false,
      reason: "overtaken",
    });
  });

  it("says nothing when the room never heard the claim", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { verdict: "budget" });
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    harness.records.length = 0;
    harness.reservations.noAnswer(idea.id);
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records).toEqual([]);
  });

  it("uses the reason the search gave, when there is one", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    await claimed(voice, harness);
    harness.reservations.noAnswer(idea.id, RESEARCH_NO_ANSWER);
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(voice.said.at(-1)).toBe(noAnswerLine("drive time"));
  });

  it("writes a line still waiting for a pause down as the session ends", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    await claimed(voice, harness);
    harness.speak();
    harness.reservations.noAnswer(idea.id);
    harness.reservations.stop();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({
      kind: "no_answer",
      spoken: false,
      reason: "session_ended",
    });
  });
});
