/**
 * V3-015 on a simulated clock: when Sotto claims a question out loud, when it
 * stays quiet, and what happens when the search comes back with nothing.
 */
import { describe, expect, it } from "vitest";
import { FREQUENCY_LIMITS, type PolicySettings } from "../../shared/policy.js";
import {
  RESEARCH_NO_ANSWER,
  type ResearchIdea,
  type ResearchPacket,
} from "../../shared/research.js";
import { SOTTO_SPEAKER, type PauseState, type TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import { PAUSE_MS, SPEAK_PAUSE_MS, type SpendVerdict } from "../interject/policy.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "../voice/voiceOut.js";
import type { StillCurrentState } from "./StillCurrentWatcher.js";
import {
  ANSWER_STALE_MS,
  ANSWER_STALE_TURNS,
  RESERVE_WINDOW_MS,
  Reservations,
  answerLine,
  noAnswerLine,
  reserveLine,
  reserveUtteranceId,
  type SpokenContributionRecord,
} from "./Reservations.js";

const quiet = { log: () => {}, warn: () => {} };

/** The three cached verdicts V3-004 reads, as the watcher hands them over. */
const current: StillCurrentState = {
  verdict: "current", agrees: false, latencyMs: 1_800, fallback: false, turns: 3,
};
const movedOn: StillCurrentState = { ...current, verdict: "moved_on" };
const confirmed: StillCurrentState = { ...current, verdict: "answered", agrees: true };
const contradicted: StillCurrentState = { ...current, verdict: "answered", agrees: false };

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
    stillCurrent?: (ideaId: string) => StillCurrentState | undefined;
    onAnswered?: (ideaId: string, state: StillCurrentState) => void;
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
    ...(options.stillCurrent === undefined ? {} : { stillCurrent: options.stillCurrent }),
    ...(options.onAnswered === undefined ? {} : { onAnswered: options.onAnswered }),
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

/** A final turn, which is one of the six an answer may wait through (V3-004). */
function final(turnId: string): TurnUpdate {
  return { ...partial(), turnId, final: true, endMs: 1_000 };
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
    const harness = setup(voice, { stillCurrent: () => movedOn });
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

describe("Reservations: speaking the answer (V3-004)", () => {
  /** One sourced packet, as `ResearchRunner` hands it to `answer()`. */
  function packet(overrides: Partial<ResearchPacket> = {}): ResearchPacket {
    return {
      id: "packet-1",
      ideaId: idea.id,
      title: "About two hours fifteen",
      teaser: "The quickest route is two hours ten without traffic.",
      keyPoints: ["Two hours ten via the motorway"],
      spokenAnswer: "about two hours fifteen from the city",
      sources: [{ url: "https://maps.example.com/route", title: "Route" }],
      createdAtMs: 0,
      latencyMs: 18_000,
      ...overrides,
    };
  }

  /** The question is known, and no claim was made: this is V3-004 on its own. */
  function asking(harness: Harness): void {
    harness.reservations.noteQuestion(idea, asked(0));
  }

  it("addresses the room and names the topic, never the asker", () => {
    expect(answerLine("drive time", "about two hours fifteen from the city")).toBe(
      "On the drive time: about two hours fifteen from the city.",
    );
    expect(answerLine("Loom pricing", "It is fifteen dollars a seat.")).toBe(
      "On Loom pricing: It is fifteen dollars a seat.",
    );
    // Nothing a listener has to read, and nobody named.
    expect(answerLine("drive time", "Two hours.")).not.toMatch(/[*#_[\]`]|https?:/);
    expect(answerLine("", "Two hours.")).toBe("Two hours.");
    expect(answerLine("drive time", "  ")).toBe("");
  });

  it("waits for a real pause, and takes the first one it gets", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => current });
    asking(harness);
    harness.speak();
    harness.reservations.answer(packet());
    await harness.tick();
    expect(voice.opened).toBe(0);

    // The room stops, but not for long enough yet.
    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS - 1);
    harness.reservations.acceptTurn(partial());
    await harness.tick();
    expect(voice.opened).toBe(0);

    harness.clock.advanceBy(1);
    harness.reservations.acceptTurn(partial());
    await harness.tick();
    expect(voice.opened).toBe(1);
    expect(voice.said).toEqual(["On the drive time: about two hours fifteen from the city."]);
  });

  it("asks nothing between the pause and the first word: the verdict is cached", async () => {
    const voice = new FakeVoice();
    let reads = 0;
    const harness = setup(voice, {
      stillCurrent: () => {
        reads += 1;
        return current;
      },
    });
    asking(harness);
    harness.reservations.answer(packet());
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(1);
    // Read synchronously, every time, and never awaited: the whole point of
    // the watcher keeping a verdict is that this costs no model call.
    expect(reads).toBeGreaterThan(0);
  });

  it("records the latency, the wait and the verdict it decided on", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => current });
    asking(harness);
    harness.clock.advanceBy(20_000);
    // Somebody is mid-sentence when the search comes back.
    harness.speak();
    harness.reservations.answer(packet());
    harness.clock.advanceBy(3_000);
    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({
      stage: "spoken_contribution",
      kind: "answer",
      ideaId: "idea-1",
      spoken: true,
      questionToSpeechMs: 23_450,
      pauseWaitMs: 3_450,
      stillCurrent: current,
      yielded: false,
    });
    expect(harness.spoken[0]?.text).toBe(
      "On the drive time: about two hours fifteen from the city.",
    );
  });

  it("yields to a voice in the room and tries once more, then gives up", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => current });
    asking(harness);
    harness.reservations.answer(packet());
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(1);

    // Mid-utterance: a human partial the echo filter let through.
    harness.reservations.yieldToHuman();
    await harness.reservations.flush();
    expect(voice.cancelled).toBe(1);
    expect(harness.records[0]).toMatchObject({
      kind: "answer", spoken: true, yielded: true, yields: 1, retrying: true,
    });
    // Only what the room heard of it goes into the transcript.
    expect(harness.spoken[0]?.interrupted).toBe(true);

    // The next pause gets the answer again.
    harness.speak();
    harness.clock.advanceBy(2_000);
    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(2);

    // Cut off a second time: the room has said what it wants.
    harness.reservations.yieldToHuman();
    await harness.reservations.flush();
    expect(harness.records.at(-1)).toMatchObject({
      kind: "answer", spoken: false, reason: "yielded", yields: 2,
    });
    harness.speak();
    harness.clock.advanceBy(2_000);
    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(2);
  });

  it("records a barge-in as the barge-in's doing (V2-007 on top)", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => current });
    asking(harness);
    harness.reservations.answer(packet());
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    harness.reservations.interrupt();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({ yielded: true, bargedIn: true });
  });

  it("says nothing when the room has moved on; the card is the only sign", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => movedOn });
    asking(harness);
    harness.reservations.answer(packet());
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({
      kind: "answer", spoken: false, reason: "moved_on",
    });
  });

  it("marks the card confirmed when somebody answered it and the search agrees", async () => {
    const voice = new FakeVoice();
    const answered: { ideaId: string; agrees: boolean }[] = [];
    const harness = setup(voice, {
      stillCurrent: () => confirmed,
      onAnswered: (ideaId, state) => answered.push({ ideaId, agrees: state.agrees }),
    });
    asking(harness);
    harness.reservations.answer(packet());
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(answered).toEqual([{ ideaId: "idea-1", agrees: true }]);
    expect(harness.records[0]).toMatchObject({
      kind: "answer", spoken: false, reason: "answered",
    });
  });

  it("puts the correction on screen when the search disagrees with the room", async () => {
    const voice = new FakeVoice();
    const answered: boolean[] = [];
    const harness = setup(voice, {
      stillCurrent: () => contradicted,
      onAnswered: (_ideaId, state) => answered.push(state.agrees),
    });
    asking(harness);
    harness.reservations.answer(packet());
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(answered).toEqual([false]);
    expect(harness.records[0]).toMatchObject({
      kind: "answer", spoken: false, reason: "disagrees",
    });
  });

  it("gives up after ninety seconds without a pause", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => current });
    asking(harness);
    harness.speak();
    harness.reservations.answer(packet());
    harness.clock.advanceBy(ANSWER_STALE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({
      kind: "answer", spoken: false, reason: "expired", pauseWaitMs: ANSWER_STALE_MS,
    });
    // And not in the pause that follows either: the moment has gone.
    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
  });

  it("gives up after six more final turns, which is the faster of the two", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => current });
    asking(harness);
    harness.speak();
    harness.reservations.answer(packet());
    for (let index = 0; index < ANSWER_STALE_TURNS; index += 1) {
      harness.reservations.acceptTurn(final(`0:${10 + index}`));
    }
    await harness.tick();
    expect(harness.records[0]).toMatchObject({
      kind: "answer", spoken: false, reason: "expired",
    });
    // Sotto's own lines are not the room moving on (V2-008a).
    expect(voice.opened).toBe(0);
  });

  it("spends the frequency's allowance, and is turned down by it", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => current, verdict: "cooldown" });
    asking(harness);
    harness.reservations.answer(packet());
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({ reason: "cooldown" });

    // With room in the budget it is said, and charged for once.
    const second = setup(new FakeVoice(), { stillCurrent: () => current });
    second.reservations.noteQuestion(idea, asked(0));
    second.reservations.answer(packet());
    second.clock.advanceBy(SPEAK_PAUSE_MS);
    await second.tick();
    expect(second.spend.spent).toBe(1);
  });

  it("spends nothing when the claim already did: one contribution, two lines", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => current });
    harness.reservations.claim(idea, asked(0));
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(harness.spend.spent).toBe(1);

    // The answer lands twenty seconds later; it is the claim's completion.
    harness.spend.verdict = "budget";
    harness.clock.advanceBy(20_000);
    harness.reservations.answer(packet());
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(voice.said.at(-1)).toBe(
      "On the drive time: about two hours fifteen from the city.",
    );
    expect(harness.spend.spent).toBe(1);
  });

  it("waits behind the claim on its own question", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => current });
    harness.speak();
    harness.reservations.claim(idea, asked(0));
    // The search comes back while somebody is still talking — which is every
    // time in a `max` replay, where simulated time stands still in a call.
    harness.reservations.answer(packet());
    harness.hush();
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    // The claim is over, so the gap it took is the answer's now.
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(voice.said[0]).toBe("I'll check the drive time.");
    expect(voice.said[1]).toBe("On the drive time: about two hours fifteen from the city.");
  });

  it("shows but does not speak with the voice muted", async () => {
    const voice = new FakeVoice("muted");
    const harness = setup(voice, { stillCurrent: () => current });
    asking(harness);
    harness.reservations.answer(packet());
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({
      kind: "answer", spoken: false, reason: "unheard",
    });
    expect(harness.spoken).toEqual([]);
    // Nothing was heard, so nothing was spent.
    expect(harness.spend.spent).toBe(0);
  });

  it("says nothing at all when the boldness is cautious", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, {
      stillCurrent: () => current,
      settings: { boldness: "cautious" },
    });
    asking(harness);
    harness.reservations.answer(packet());
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({
      kind: "answer", spoken: false, reason: "boldness",
    });
  });

  it("says nothing for a packet nobody wondered aloud about, or one with no spoken line", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => current });
    // The planner's and the observer's ideas are research cards (V2-014).
    harness.reservations.answer(packet({ ideaId: "idea-9" }));
    asking(harness);
    harness.reservations.answer(packet({ spokenAnswer: "  " }));
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records).toEqual([]);
  });

  it("says one answer per packet, however many times it arrives", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => current });
    asking(harness);
    harness.reservations.answer(packet());
    harness.reservations.answer(packet());
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(voice.opened).toBe(1);
  });
});
