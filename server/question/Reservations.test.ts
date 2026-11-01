/**
 * V3-015 on a simulated clock: when Sotto claims a question out loud, when it
 * stays quiet, and what happens when the search comes back with nothing.
 */
import { describe, expect, it } from "vitest";
import {
  FREQUENCY_LIMITS,
  type Boldness,
  type Frequency,
  type PolicySettings,
} from "../../shared/policy.js";
import {
  RESEARCH_NO_ANSWER,
  type ResearchIdea,
  type ResearchPacket,
} from "../../shared/research.js";
import type { StageCard } from "../../shared/cards.js";
import { SOTTO_SPEAKER, type PauseState, type TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import { Steering } from "../session/Steering.js";
import { PAUSE_MS, SPEAK_PAUSE_MS, type SpendVerdict } from "../interject/policy.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "../voice/voiceOut.js";
import type { StillCurrentState } from "./StillCurrentWatcher.js";
import { READBACK_EXPIRY_MS } from "../decision/readback.js";
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
  settings: { frequency: Frequency; boldness: Boldness };
  /** What the frequency's cooldown and allowance say right now. */
  spend: { verdict: SpendVerdict; spent: number };
  /** Somebody is talking. */
  speak: () => void;
  /** Everybody stops; the silence grows with the clock from here. */
  hush: () => void;
  /** Lets the voice's promises settle. */
  tick: () => Promise<void>;
  /** How many times the room was told it is hearing something unasked (V3-006). */
  sayings: () => number;
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
  // Mutable on purpose: the header can move either slider mid-conversation,
  // and V3-008's correction is only said while the boldness is still `bold`.
  const settings: { frequency: Frequency; boldness: Boldness } = {
    frequency: "normal",
    boldness: "normal",
    ...options.settings,
  };
  const spend = { verdict: options.verdict ?? ("ok" as SpendVerdict), spent: 0 };
  let sayings = 0;
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
    onSaying: () => {
      sayings += 1;
    },
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
    sayings: () => sayings,
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

describe("Reservations: telling the room it is hearing something unasked (V3-006)", () => {
  it("reports at the moment the words reach the voice", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.reservations.claim(idea, asked());
    expect(harness.sayings()).toBe(0);
    harness.clock.advanceBy(PAUSE_MS);
    await harness.tick();
    expect(harness.sayings()).toBe(1);
  });

  it("reports nothing for a line nobody could hear", async () => {
    const harness = setup(null);
    harness.reservations.claim(idea, asked());
    harness.clock.advanceBy(PAUSE_MS);
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({ spoken: false, reason: "unheard" });
    expect(harness.sayings()).toBe(0);
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

  /**
   * V3-006's two-yields rule against the records a real claim produces, so
   * the hint cannot drift from what `Reservations` actually writes down —
   * `SessionManager` hands every one of these to `Steering.observe`.
   */
  it("is the hint that two of turn the frequency down (V3-006)", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    let frequency: Frequency = "normal";
    const cards: StageCard[] = [];
    const steering = new Steering({
      clock: harness.clock,
      frequency: () => frequency,
      setFrequency: (next) => {
        frequency = next;
      },
      onCard: (card) => cards.push(card),
      logger: quiet,
    });
    for (const attempt of [0, 1]) {
      harness.reservations.claim({ ...idea, id: `idea-${attempt}` }, asked(harness.clock.now()));
      harness.clock.advanceBy(PAUSE_MS);
      await harness.tick();
      harness.reservations.yieldToHuman();
      await harness.reservations.flush();
      for (const record of harness.records.splice(0)) steering.observe(record);
      harness.hush();
    }
    expect(frequency).toBe("rare");
    expect(cards.map((card) => card.headline)).toEqual(["Sotto will speak up less"]);
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

describe("Reservations: Sotto's own correction (V3-008)", () => {
  const LINE = "Quick correction: Instagram launched in 2010, not 2014.";

  /** The correction, as `SessionManager`'s `onDeliver` hands it over. */
  function correction(harness: Harness): void {
    harness.reservations.correction({
      candidateId: "cand-7",
      turnId: "0:9",
      headline: "Instagram launched in 2010, not 2014",
      text: LINE,
    });
  }

  it("is said at the first real pause, under the answer's threshold", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { settings: { boldness: "bold" } });
    harness.speak();
    correction(harness);
    await harness.tick();
    expect(voice.opened).toBe(0);

    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS - 1);
    harness.reservations.acceptTurn(partial());
    await harness.tick();
    expect(voice.opened).toBe(0);

    harness.clock.advanceBy(1);
    harness.reservations.acceptTurn(partial());
    await harness.tick();
    expect(voice.opened).toBe(1);
    expect(voice.said).toEqual([LINE]);
  });

  it("spends nothing: the card it was delivered as already paid", async () => {
    const voice = new FakeVoice();
    // The policy pushed an interject the instant it delivered the card, so
    // the frequency's cooldown is spent by the time this is said. Charging it
    // again would mean a bold session could never say one.
    const harness = setup(voice, { settings: { boldness: "bold" }, verdict: "cooldown" });
    correction(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(voice.said).toEqual([LINE]);
    expect(harness.spend.spent).toBe(0);
  });

  it("records the wait and the candidate it is about", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { settings: { boldness: "bold" } });
    harness.speak();
    correction(harness);
    harness.clock.advanceBy(3_000);
    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({
      stage: "spoken_contribution",
      kind: "correction",
      candidateId: "cand-7",
      ideaId: "cand-7",
      turnId: "0:9",
      topic: "Instagram launched in 2010, not 2014",
      spoken: true,
      text: LINE,
      pauseWaitMs: 3_450,
      yielded: false,
    });
    // Nothing was asked, so there is no question to measure from.
    expect(harness.records[0]).not.toHaveProperty("questionToReserveMs");
    expect(harness.records[0]).not.toHaveProperty("questionToSpeechMs");
    // And it is Sotto's line in the transcript, like everything else said.
    expect(harness.spoken[0]?.text).toBe(LINE);
  });

  it("yields to a voice in the room and tries once more, then gives up", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { settings: { boldness: "bold" } });
    correction(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    harness.reservations.yieldToHuman();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({
      kind: "correction", spoken: true, yielded: true, yields: 1, retrying: true,
    });

    harness.speak();
    harness.clock.advanceBy(2_000);
    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(2);
    harness.reservations.yieldToHuman();
    await harness.reservations.flush();
    expect(harness.records.at(-1)).toMatchObject({
      kind: "correction", spoken: false, reason: "yielded", yields: 2,
    });
  });

  it("is a card only when the room moved on from the claim", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, {
      settings: { boldness: "bold" },
      stillCurrent: () => movedOn,
    });
    correction(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({
      kind: "correction", spoken: false, reason: "moved_on",
    });
  });

  it("is a card only when somebody in the room corrected it themselves", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, {
      settings: { boldness: "bold" },
      stillCurrent: () => confirmed,
    });
    correction(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({
      kind: "correction", spoken: false, reason: "answered",
    });
  });

  it("gives up after ninety seconds, or six turns, without a pause", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { settings: { boldness: "bold" } });
    harness.speak();
    correction(harness);
    harness.clock.advanceBy(ANSWER_STALE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({
      kind: "correction", spoken: false, reason: "expired", pauseWaitMs: ANSWER_STALE_MS,
    });

    const turns = setup(new FakeVoice(), { settings: { boldness: "bold" } });
    turns.speak();
    correction(turns);
    for (let index = 0; index < ANSWER_STALE_TURNS; index += 1) {
      turns.reservations.acceptTurn(final(`0:${20 + index}`));
    }
    await turns.tick();
    expect(turns.records[0]).toMatchObject({ kind: "correction", reason: "expired" });
  });

  it("is not said once the room has turned the boldness back down", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { settings: { boldness: "bold" } });
    harness.speak();
    correction(harness);
    // The header moves the slider while the correction waits for a gap.
    harness.settings.boldness = "normal";
    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({
      kind: "correction", spoken: false, reason: "boldness",
    });

    const cautious = setup(new FakeVoice(), { settings: { boldness: "cautious" } });
    correction(cautious);
    cautious.clock.advanceBy(SPEAK_PAUSE_MS);
    await cautious.tick();
    expect(cautious.records[0]).toMatchObject({ reason: "boldness" });
  });

  it("is a card only when nobody can hear it", async () => {
    const harness = setup(new FakeVoice("muted"), { settings: { boldness: "bold" } });
    correction(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(harness.records[0]).toMatchObject({
      kind: "correction", spoken: false, reason: "unheard",
    });
  });

  it("says one correction per candidate, and nothing for an empty one", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { settings: { boldness: "bold" } });
    correction(harness);
    correction(harness);
    harness.reservations.correction({
      candidateId: "cand-8",
      turnId: "0:9",
      headline: "  ",
      text: "  ",
    });
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(voice.opened).toBe(1);
    expect(harness.records).toHaveLength(1);
  });
});

describe("Reservations: reading a decision back (V3-013)", () => {
  const BARE = "Got it: six sheds.";
  const WITH_QUESTION =
    "Got it: six sheds. EJ asked, what if only one of them signs. Did that get settled?";

  /** The read-back, as `ReadBacks` hands it over. */
  function readBack(
    harness: Harness,
    attached: "group" | "own" | null = "group",
    text = WITH_QUESTION,
    alreadyDelivered = false,
  ): void {
    harness.reservations.readBack({
      id: "decision-0:9",
      turnId: "0:9",
      decision: "six sheds",
      attached,
      candidateId: attached === null ? null : "cand-4",
      text,
      bareText: BARE,
      alreadyDelivered,
    });
  }

  it("is said at the first real pause, with the group's question on it", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.speak();
    readBack(harness);
    await harness.tick();
    expect(voice.opened).toBe(0);

    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS - 1);
    harness.reservations.acceptTurn(partial());
    await harness.tick();
    expect(voice.opened).toBe(0);

    harness.clock.advanceBy(1);
    harness.reservations.acceptTurn(partial());
    await harness.tick();
    expect(voice.said).toEqual([WITH_QUESTION]);
  });

  it("records what was settled, what was attached and the candidate", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.speak();
    readBack(harness);
    harness.clock.advanceBy(2_000);
    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({
      stage: "spoken_contribution",
      kind: "readback",
      ideaId: "decision-0:9",
      turnId: "0:9",
      decision: "six sheds",
      attached: "group",
      candidateId: "cand-4",
      spoken: true,
      text: WITH_QUESTION,
      pauseWaitMs: 2_450,
    });
    expect(harness.spoken[0]?.text).toBe(WITH_QUESTION);
  });

  it("spends the frequency's allowance, like any unprompted line", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    readBack(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(harness.spend.spent).toBe(1);
  });

  /**
   * V3-013, following V3-008's rule: the card the question is already on
   * spent the contribution when the policy delivered it, so saying it beside
   * the decision costs nothing more. Without this the cooldown that card
   * spent would silence every read-back that had something to say.
   */
  it("spends nothing when the question is already on the stage", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { verdict: "cooldown" });
    readBack(harness, "group", WITH_QUESTION, true);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(voice.said).toEqual([WITH_QUESTION]);
    expect(harness.spend.spent).toBe(0);
  });

  it("says nothing when the budget says no", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { verdict: "budget" });
    readBack(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({ kind: "readback", spoken: false, reason: "budget" });
  });

  it("says nothing at all at boldness cautious", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { settings: { boldness: "cautious" } });
    readBack(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({ kind: "readback", reason: "boldness" });
  });

  it("is card only when muted: nothing was heard", async () => {
    const harness = setup(new FakeVoice("muted"));
    readBack(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({ kind: "readback", spoken: false, reason: "unheard" });
    expect(harness.spend.spent).toBe(0);
  });

  it("says a bare read-back only at frequency often", async () => {
    const quietVoice = new FakeVoice();
    const normal = setup(quietVoice);
    readBack(normal, null, BARE);
    normal.clock.advanceBy(SPEAK_PAUSE_MS);
    await normal.tick();
    expect(quietVoice.opened).toBe(0);
    expect(normal.records[0]).toMatchObject({
      kind: "readback", attached: null, spoken: false, reason: "frequency",
    });

    const loudVoice = new FakeVoice();
    const often = setup(loudVoice, { settings: { frequency: "often" } });
    readBack(often, null, BARE);
    often.clock.advanceBy(SPEAK_PAUSE_MS);
    await often.tick();
    expect(loudVoice.said).toEqual([BARE]);
  });

  /**
   * V3-008's rule, kept here: one of Sotto's own corrections is pinned to the
   * stage and said out loud only at boldness `bold`. The boldness is read at
   * the pause, so a header turned down mid-wait loses the attachment rather
   * than the read-back.
   */
  it("drops Sotto's own question from the line unless the session is bold", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { settings: { frequency: "often" } });
    readBack(harness, "own", "Got it: six sheds. What about the fourteen hundred ceiling?");
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.said).toEqual([BARE]);
    voice.played();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({ kind: "readback", attached: null, spoken: true });
  });

  it("says Sotto's own question at boldness bold", async () => {
    const voice = new FakeVoice();
    const line = "Got it: six sheds. What about the fourteen hundred ceiling?";
    const harness = setup(voice, { settings: { boldness: "bold" } });
    readBack(harness, "own", line);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.said).toEqual([line]);
    voice.played();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({ kind: "readback", attached: "own", spoken: true });
  });

  it("gives up after twenty seconds without a pause", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    harness.speak();
    readBack(harness);
    harness.clock.advanceBy(READBACK_EXPIRY_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({ kind: "readback", spoken: false, reason: "expired" });
  });

  it("yields to a voice in the room and tries once more", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    readBack(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    harness.reservations.yieldToHuman();
    await harness.reservations.flush();
    expect(harness.records[0]).toMatchObject({
      kind: "readback", spoken: true, yielded: true, yields: 1, retrying: true,
    });
    harness.speak();
    harness.clock.advanceBy(1_000);
    harness.hush();
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(2);
  });

  it("is not said when the room has moved on (V3-004's verdict)", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice, { stillCurrent: () => movedOn });
    readBack(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    expect(voice.opened).toBe(0);
    expect(harness.records[0]).toMatchObject({ kind: "readback", reason: "moved_on" });
  });

  it("reads one decision back once, however often it arrives", async () => {
    const voice = new FakeVoice();
    const harness = setup(voice);
    readBack(harness);
    readBack(harness);
    harness.clock.advanceBy(SPEAK_PAUSE_MS);
    await harness.tick();
    voice.played();
    await harness.reservations.flush();
    expect(voice.opened).toBe(1);
    expect(harness.records).toHaveLength(1);
  });
});
