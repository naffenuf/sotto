import { describe, expect, it } from "vitest";
import { ANSWER_LATE_MS, type Answer, type AnswerLogRecord } from "../../shared/answers.js";
import { emptyBoard, type Board } from "../../shared/board.js";
import type { StageCard } from "../../shared/cards.js";
import type { SpeakerNames } from "../../shared/events.js";
import {
  BRIEFING_OPENER,
  BRIEFING_OPENER_MANY,
  type ResearchPacket,
} from "../../shared/research.js";
import { SOTTO_SPEAKER, type TurnUpdate } from "../../shared/turns.js";
import type { Artifact, ShowHtmlArgs } from "../../shared/artifacts.js";
import { SimulatedClock } from "../clock.js";
import type { SpeechEndReason } from "../voice/Speaker.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "../voice/voiceOut.js";
import { ACK_SEARCH } from "./ack.js";
import type { ProseCall, ProseReply, ModelClient, StructuredCall } from "../model/client.js";
import { FIRST_LINE_LABEL } from "./firstLine.js";
import {
  ANSWER_ITEM_PREFIX,
  ANSWER_MAX_TOKENS,
  FIRST_LINE_CONTEXT_WAIT_MS,
  ANSWER_TRACK_LABEL,
  AnswerAgent,
  cardForAnswer,
  recentTurns,
  sameQuestion,
  renderAnswerRequest,
  screenFromSpoken,
} from "./AnswerAgent.js";

/** The answer item's id, which is the only one a headline is taken from. */
const ANSWER_ITEM = `${ANSWER_ITEM_PREFIX}-01`;

/** A prose reply, with everything a test does not care about defaulted. */
function reply(overrides: Partial<ProseReply> & { text: string }): ProseReply {
  return { citations: [], searchedUrls: [], searched: true, functionCalls: 0, ...overrides };
}

/** A model whose prose calls are answered from a script. */
class FakeModel implements ModelClient {
  readonly calls: ProseCall[] = [];
  readonly commands: unknown[] = [];
  readonly classifications: StructuredCall[] = [];
  /** The holding-line calls (V2-008c), kept apart from the classifications. */
  readonly firstLineCalls: StructuredCall[] = [];
  /** What each holding-line call answers; empty means "nothing worth saying". */
  readonly firstLines: (() => Promise<string>)[] = [];

  constructor(readonly replies: ((call: ProseCall) => Promise<ProseReply>)[]) {}

  async structured(call: StructuredCall): Promise<unknown> {
    if (call.label === FIRST_LINE_LABEL) {
      this.firstLineCalls.push(call);
      const next = this.firstLines.shift();
      return { line: next === undefined ? "" : await next() };
    }
    this.classifications.push(call);
    if (this.commands.length === 0) throw new Error("unexpected structured call");
    return this.commands.shift();
  }

  /** A holding line that only arrives when the test says so. */
  heldFirstLine(): { write: (line: string) => void } {
    const gate = { write: (_line: string) => {} };
    this.firstLines.push(
      () =>
        new Promise<string>((resolve) => {
          gate.write = resolve;
        }),
    );
    return gate;
  }

  async grounded(): Promise<never> {
    throw new Error("the answer agent asks for prose, not JSON");
  }

  async prose(call: ProseCall): Promise<ProseReply> {
    this.calls.push(call);
    const next = this.replies.shift();
    if (next === undefined) throw new Error(`unexpected prose call ${this.calls.length}`);
    return next(call);
  }

  /** A reply that only arrives when the test says so. */
  held(): { answer: (value: ProseReply) => void; call: () => ProseCall | undefined } {
    const gate = {
      answer: (_value: ProseReply) => {},
      call: (): ProseCall | undefined => undefined,
    };
    this.replies.push((call) => {
      gate.call = () => call;
      return new Promise<ProseReply>((resolve) => {
        gate.answer = resolve;
      });
    });
    return gate;
  }
}

/** One utterance, remembering everything it was handed. */
class FakeUtterance implements VoiceUtterance {
  readonly said: string[] = [];
  reason: SpeechEndReason = "complete";
  heard = "";
  finished = false;

  constructor(
    readonly id: string,
    private readonly toFirstAudioMs: number | null,
  ) {}

  append(text: string): void {
    this.said.push(text);
  }

  firstAudioMs(): number | null {
    return this.said.length === 0 ? null : this.toFirstAudioMs;
  }

  /** Speech synthesized so far: a tenth of a second per character, flat. */
  audioMs(): number {
    return this.said.join(" ").length * 100;
  }

  cancel(): void {
    if (this.finished) return;
    this.reason = "cancelled";
  }

  finish(): Promise<VoiceSpoken> {
    this.finished = true;
    return Promise.resolve({
      reason: this.reason,
      text: this.said.join(" "),
      spokenSoFar: this.reason === "cancelled" ? this.heard : this.said.join(" "),
      firstAudioMs: this.firstAudioMs(),
    });
  }

  /** Everything it was handed, as one line. */
  text(): string {
    return this.said.join(" ");
  }
}

/**
 * A voice that records rather than speaks. Each `begin()` moves the wall clock
 * on by a second, so the latencies a test reads back are distinguishable.
 */
class FakeVoice implements VoiceOut {
  readonly utterances: FakeUtterance[] = [];
  /** Null means "nothing would be heard" — muted, or no page attached. */
  available = true;
  /** Set to throw from `begin()`, as a bad ElevenLabs key would. */
  failure: Error | undefined;

  constructor(
    private readonly wall: SimulatedClock,
    private readonly toFirstAudioMs: number | null = 300,
  ) {}

  async begin(): Promise<VoiceUtterance | null> {
    if (this.failure !== undefined) throw this.failure;
    if (!this.available) return null;
    this.wall.advanceBy(1_000);
    // A new utterance stops the last one, as the real hub does.
    this.utterances.at(-1)?.cancel();
    const utterance = new FakeUtterance(`u${this.utterances.length + 1}`, this.toFirstAudioMs);
    this.utterances.push(utterance);
    return utterance;
  }
}

interface Harness {
  clock: SimulatedClock;
  model: FakeModel;
  agent: AnswerAgent;
  /** Every card pushed to the stage, in order. */
  cards: StageCard[];
  /** The answer beside each card, in the same order. */
  pushes: Answer[];
  /** The lines written to `answers.jsonl`. */
  records: AnswerLogRecord[];
  /** The courtesy hook, in order. */
  thinking: boolean[];
  states: [state: string, detail: string][];
  warnings: string[];
  /** Real time, which is what the voice latencies are measured on. */
  wall: SimulatedClock;
  /** Present only when the harness was given one. */
  voice: FakeVoice | undefined;
  /** Sotto's own transcript lines, in order (V2-008a). */
  spokenTurns: TurnUpdate[];
  /** The lines written to `timing.jsonl`. */
  timing: Record<string, unknown>[];
  /** The packets each briefing brought forward, in order (V2-015). */
  briefings: string[][];
  /** Every steering command the room gave, in order (V3-006). */
  steers: [command: string, turnId: string | null][];
  /** Turns whose `continue` had nothing to continue (V3-017). */
  callOns: (string | null)[];
}

function harness(
  replies: ((call: ProseCall) => Promise<ProseReply>)[] = [],
  options: {
    speakers?: SpeakerNames;
    board?: Board;
    turns?: TurnUpdate[];
    /** Absent means `show_html` is never offered (US-020). */
    onArtifact?: (artifact: ShowHtmlArgs) => Artifact | null;
    /** Absent means the answer is never spoken (V2-005). */
    voice?: FakeVoice;
    /** The real-time clock the voice latencies are read off. */
    wall?: SimulatedClock;
    /** Where "now" is on the transcription stream's timeline (V2-008a). */
    streamNow?: () => number;
    /** The research this session has done (V2-015). */
    packets?: ResearchPacket[];
  } = {},
): Harness {
  const clock = new SimulatedClock(0);
  const wall = options.wall ?? new SimulatedClock(0);
  const model = new FakeModel(replies);
  const cards: StageCard[] = [];
  const pushes: Answer[] = [];
  const records: AnswerLogRecord[] = [];
  const thinking: boolean[] = [];
  const states: [string, string][] = [];
  const warnings: string[] = [];
  const spokenTurns: TurnUpdate[] = [];
  const timing: Record<string, unknown>[] = [];
  const briefings: string[][] = [];
  const steers: [string, string | null][] = [];
  const callOns: (string | null)[] = [];
  const agent = new AnswerAgent({
    clock,
    model,
    board: () => options.board ?? emptyBoard(),
    transcript: () => options.turns ?? [],
    speakers: () => options.speakers ?? {},
    packets: () => options.packets ?? [],
    onBriefing: (briefed) => briefings.push(briefed.map((one) => one.id)),
    onCard: (card, answer) => {
      cards.push(card);
      pushes.push(answer);
    },
    onRecord: (record) => records.push(record),
    onTiming: (event) => timing.push(event),
    ...(options.onArtifact === undefined ? {} : { onArtifact: options.onArtifact }),
    wallClock: wall,
    ...(options.streamNow === undefined ? {} : { streamNow: options.streamNow }),
    onSpoken: (turn) => spokenTurns.push(turn),
    ...(options.voice === undefined ? {} : { voice: options.voice }),
    onThinking: (value) => thinking.push(value),
    onSteer: (command, turnId) => steers.push([command, turnId]),
    onCallOn: (turnId) => callOns.push(turnId),
    onModelState: (state, detail) => states.push([state, detail]),
    logger: {
      log: () => {},
      warn: (line: string) => warnings.push(line),
    },
  });
  return {
    clock,
    model,
    agent,
    cards,
    pushes,
    records,
    thinking,
    states,
    warnings,
    wall,
    voice: options.voice,
    spokenTurns,
    timing,
    briefings,
    steers,
    callOns,
  };
}

/** Lets everything already queued as a microtask run, and nothing else. */
async function microtasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function turn(overrides: Partial<TurnUpdate> & { turnId: string }): TurnUpdate {
  return {
    speaker: "A",
    text: "something was said",
    final: true,
    startMs: 0,
    endMs: 1_000,
    speakerMappingUncertain: false,
    ...overrides,
  };
}

/** The spoken half of {@link STREAM}, which is what the voice is handed. */
const SAID = "They charge five to twenty-five dollars a seat.";

/**
 * One answer arriving the way the real stream delivers it: the spoken half
 * sentence by sentence, then the screen heading, then the headline, then the
 * detail. Each entry is the whole text so far, as `onText` reports it.
 */
const STREAM = [
  "Say this:\nThey charge five to twenty",
  `Say this:\n${SAID}`,
  `Say this:\n${SAID}\n`,
  `Say this:\n${SAID}\n\nShow this:\nRivals charge $5-$25 a seat`,
  `Say this:\n${SAID}\n\nShow this:\nRivals charge $5-$25 a seat\n\n- Notion $12`,
];

describe("AnswerAgent", () => {
  it("puts a thinking card up before the call goes out", () => {
    const h = harness([() => new Promise<ProseReply>(() => {})]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "B", turnId: "0:4" });

    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]).toMatchObject({
      id: "card-ans-1",
      variant: "answer",
      state: "thinking",
      headline: "",
      question: "what do rivals charge?",
      askedBy: "B",
    });
    expect(h.thinking).toEqual([true]);
    expect(h.states[0]?.[0]).toBe("connecting");
    expect(h.agent.pending()).toBe(1);
  });

  it("calls whoever asked by the name the group gave their label", () => {
    const h = harness([() => new Promise<ProseReply>(() => {})], {
      speakers: { B: "Jordan" },
    });
    h.agent.ask({ question: "how long would that take?", askedBy: "B", turnId: "0:4" });
    expect(h.cards[0]?.askedBy).toBe("Jordan");
  });

  it("files a typed question under 'typed'", () => {
    const h = harness([() => new Promise<ProseReply>(() => {})]);
    h.agent.ask({ question: "anything", askedBy: null, turnId: null });
    expect(h.cards[0]?.askedBy).toBe("typed");
  });

  it("ignores a question with nothing in it", () => {
    const h = harness();
    h.agent.ask({ question: "   ", askedBy: "A", turnId: "0:1" });
    expect(h.cards).toHaveLength(0);
    expect(h.agent.pending()).toBe(0);
  });

  it("sends the prompt, the board and the question, and asks for enough room", async () => {
    const board = emptyBoard();
    board.summary = "A team note-taking app, priced per seat.";
    const h = harness(
      [async () => reply({ text: "Answer\n\nDetail" })],
      { board, turns: [turn({ turnId: "0:1", text: "we need a price" })] },
    );
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    const call = h.model.calls[0];
    expect(call?.label).toBe(ANSWER_TRACK_LABEL);
    expect(call?.maxTokens).toBe(ANSWER_MAX_TOKENS);
    expect(call?.system).toContain("headline");
    expect(call?.user).toContain("A team note-taking app, priced per seat.");
    expect(call?.user).toContain("we need a price");
    expect(call?.user).toContain("what do rivals charge?");
  });

  it("pushes the spoken half a sentence at a time and the headline when it is whole", async () => {
    const h = harness([
      async (call) => {
        // The model narrates first, in items of its own (measured).
        call.onText?.({ itemId: "rs_01", text: "I'll look up current pricing." });
        call.onText?.({ itemId: "rs_01", text: "I'll look up current pricing.\nthen read it" });
        // Then the answer, a piece at a time: the spoken half first.
        for (const text of STREAM) call.onText?.({ itemId: ANSWER_ITEM, text });
        return reply({ text: STREAM.at(-1) as string });
      },
    ]);
    h.clock.advanceBy(1_500);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.cards.map((card) => [card.state, card.headline])).toEqual([
      ["thinking", ""],
      // A finished sentence of the spoken half, before any headline exists.
      ["thinking", ""],
      ["thinking", "Rivals charge $5-$25 a seat"],
      ["ready", "Rivals charge $5-$25 a seat"],
    ]);
    // One card id throughout, so the stage replaces it rather than stacking.
    expect(new Set(h.cards.map((card) => card.id))).toEqual(new Set(["card-ans-1"]));
    expect(h.cards[1]?.spokenText).toBe(SAID);
    expect(h.cards[3]?.detailMd).toBe("- Notion $12");
    expect(h.cards[3]?.spokenText).toBe(SAID);
    expect(h.pushes[0]?.createdAtMs).toBe(1_500);
  });

  it("deduplicates the sources, annotations first, listed ones resolved", async () => {
    const h = harness([
      async () =>
        reply({
          text: [
            "Rivals charge $5-$25 a seat",
            "",
            "- Notion $12",
            "",
            "Sources:",
            "- Notion pricing - https://example.com/notion",
            "- Confluence - https://confluence.example.com/cloud",
            "- Imagined - https://nowhere.example/made-up",
          ].join("\n"),
          citations: [{ url: "https://example.com/notion", title: "Notion Pricing 2026" }],
          searchedUrls: [
            "https://example.com/notion",
            "https://confluence.example.com/cloud/pricing",
          ],
        }),
    ]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    const card = h.cards.at(-1);
    expect(card?.citations).toEqual([
      // The annotation wins on title: it is the API's own record.
      { url: "https://example.com/notion", title: "Notion Pricing 2026" },
      // Not the exact URL the search returned, but the same page from a host
      // it really did return: resolved to what the search gave.
      { url: "https://confluence.example.com/cloud/pricing", title: "Confluence" },
    ]);
    expect(h.warnings.join(" ")).toContain("nowhere.example");
  });

  it("writes one line to answers.jsonl, with the turn the question was asked in", async () => {
    const h = harness([async () => reply({ text: "Rivals charge $5-$25\n\n- Notion $12" })]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "B", turnId: "0:7" });
    await h.clock.settle();

    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      kind: "answer",
      id: "ans-1",
      question: "what do rivals charge?",
      askedBy: "B",
      headline: "Rivals charge $5-$25",
      detailMd: "- Notion $12",
      status: "done",
      turnId: "0:7",
    });
  });

  it("holds the policy back while it is writing, and lets go when it is done", async () => {
    const h = harness([async () => reply({ text: "Answer\n\nDetail" })]);
    h.agent.ask({ question: "anything?", askedBy: "A", turnId: "0:1" });
    expect(h.thinking).toEqual([true]);
    await h.clock.settle();
    expect(h.thinking).toEqual([true, false]);
    expect(h.states.at(-1)).toEqual(["active", "model client ready"]);
  });

  it("turns a failed call into an error card and keeps answering", async () => {
    const h = harness([
      async () => {
        throw new Error("the response came back incomplete");
      },
      async () => reply({ text: "The second one worked\n\nDetail" }),
    ]);
    h.agent.ask({ question: "first?", askedBy: "A", turnId: "0:1" });
    await h.clock.settle();

    const failed = h.cards.at(-1);
    expect(failed?.state).toBe("error");
    expect(failed?.message).toContain("incomplete");
    expect(h.records[0]).toMatchObject({ id: "ans-1", status: "error" });
    expect(h.states.some(([state]) => state === "error")).toBe(true);
    // The dot keeps the reason rather than being painted over with "ready".
    expect(h.states.at(-1)?.[0]).toBe("error");
    expect(h.thinking).toEqual([true, false]);

    h.agent.ask({ question: "second?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();
    expect(h.cards.at(-1)).toMatchObject({
      id: "card-ans-2",
      state: "ready",
      headline: "The second one worked",
    });
  });

  it("answers two questions one at a time, oldest first", async () => {
    const h = harness();
    const first = h.model.held();
    const second = h.model.held();

    h.agent.ask({ question: "first?", askedBy: "A", turnId: "0:1" });
    h.agent.ask({ question: "second?", askedBy: "B", turnId: "0:2" });
    expect(h.agent.pending()).toBe(2);
    // Both cards are already on the stage; only one call has gone out.
    expect(h.cards.map((card) => card.id)).toEqual(["card-ans-1", "card-ans-2"]);
    expect(h.model.calls).toHaveLength(1);
    expect(second.call()).toBeUndefined();

    first.answer(reply({ text: "First answer\n\nDetail" }));
    // Not `settle()`: the second call is held, so nothing would ever settle.
    await microtasks();
    expect(h.model.calls).toHaveLength(2);
    expect(second.call()?.user).toContain("second?");

    second.answer(reply({ text: "Second answer\n\nDetail" }));
    await h.agent.flush();
    expect(h.agent.pending()).toBe(0);
    expect(h.agent.answers()).toBe(2);
    expect(h.thinking).toEqual([true, false]);
  });

  it("waits for the answer in flight on flush, and takes no new questions after stop", async () => {
    const h = harness();
    const held = h.model.held();
    h.agent.ask({ question: "first?", askedBy: "A", turnId: "0:1" });
    h.agent.stop();
    h.agent.ask({ question: "too late?", askedBy: "A", turnId: "0:2" });
    expect(h.cards).toHaveLength(1);

    held.answer(reply({ text: "Answer\n\nDetail" }));
    await h.agent.flush();
    expect(h.agent.answers()).toBe(1);
  });
});

describe("AnswerAgent out loud (V2-005)", () => {
  /** A harness with a voice, and the fake voice beside it. */
  function spoken(
    replies: ((call: ProseCall) => Promise<ProseReply>)[],
    streamNow?: () => number,
  ) {
    const wall = new SimulatedClock(0);
    const voice = new FakeVoice(wall);
    const h = harness(replies, {
      voice,
      wall,
      ...(streamNow === undefined ? {} : { streamNow }),
    });
    return { h, voice };
  }

  it("stops during the acknowledgment and never opens the answer's voice afterwards", async () => {
    const { h, voice } = spoken([]);
    const held = h.model.held();
    h.agent.ask({ question: "What do rivals charge?", askedBy: "A", turnId: "0:1" });
    await microtasks();
    expect(voice.utterances).toHaveLength(1);
    await h.agent.interrupt();
    h.model.commands.push({ command: "stop", question: "" });
    h.agent.command({ question: "thanks Sotto", askedBy: "B", turnId: "0:2" });
    held.answer(reply({ text: STREAM.at(-1) as string }));
    await h.clock.settle();
    expect(voice.utterances).toHaveLength(1);
    expect(h.records[0]?.spokenSoFar).toBe("");
    expect(h.model.classifications[0]?.label).toBe("voice_command");
    expect(h.model.calls).toHaveLength(1);
  });

  it.each(["continue", "new_question"])(
    "uses the flushed heard prefix for %s after an interrupted answer", async (command) => {
      const { h, voice } = spoken([]);
      const held = h.model.held();
      h.agent.ask({ question: "What do rivals charge?", askedBy: "A", turnId: "0:1" });
      // The searched call goes out behind the holding line (V2-008c), so it
      // is not in flight until the microtasks around that have run.
      await microtasks();
      held.call()?.onText?.({ itemId: ANSWER_ITEM, text: STREAM[3] as string });
      await microtasks();
      const utterance = voice.utterances.at(-1)!;
      utterance.heard = "They charge five to twenty";
      await h.agent.interrupt();
      h.model.commands.push({ command, question: command === "new_question" ? "What about annually?" : "" });
      h.model.replies.push(async () => reply({ text: "Say this:\nMore detail.\nShow this:\nDetail" }));
      h.agent.command({
        question: command === "continue" ? "Sotto go on" : "Sotto, what about annually?",
        askedBy: "B", turnId: "0:2",
      });
      held.answer(reply({ text: STREAM.at(-1) as string }));
      await h.clock.settle();
      expect(h.records[0]?.spokenSoFar).toBe("They charge five to twenty");
      expect(h.model.calls[1]?.user).toContain('"spokenSoFar":"They charge five to twenty"');
      expect(h.model.calls[1]?.user).toContain("previous answer was cut off");
      if (command === "continue") {
        expect(h.model.calls[1]?.user).toContain("Do not repeat what was heard");
        expect(voice.utterances).toHaveLength(3);
      }
    },
  );

  it("accepts a new question after stop, without resuming the stopped speech", async () => {
    const { h, voice } = spoken([]);
    const held = h.model.held();
    h.agent.ask({ question: "What do rivals charge?", askedBy: "A", turnId: "0:1" });
    await microtasks();
    // The fake acknowledgment is already finished. Stop must also work in
    // the silent gap before the model has produced its first sentence.
    h.model.commands.push({ command: "stop", question: "" });
    h.agent.command({ question: "Sotto stop", askedBy: "A", turnId: "0:2" });
    held.answer(reply({ text: STREAM.at(-1) as string }));
    await h.clock.settle();
    expect(voice.utterances).toHaveLength(1);
    h.model.commands.push({ command: "new_question", question: "How about annual pricing?" });
    h.model.replies.push(async () => reply({ text: "Say this:\nAnnual pricing.\nShow this:\nAnnual" }));
    h.agent.command({ question: "Sotto how about annual pricing?", askedBy: "A", turnId: "0:3" });
    await h.clock.settle();
    expect(h.records.map((record) => record.question)).toEqual([
      "What do rivals charge?", "How about annual pricing?",
    ]);
  });

  it("answers a question-shaped turn itself when the command classifier fails", async () => {
    // 2026-11-03_0915-mic: a slow API held one command for 102 s. The fake
    // model throws on an unexpected structured call, which is the same path
    // the deadline takes; the lexical fallback reads the yes/no question.
    const { h, voice } = spoken([]);
    const held = h.model.held();
    h.agent.ask({ question: "What do rivals charge?", askedBy: "A", turnId: "0:1" });
    await microtasks();
    await h.agent.interrupt();
    h.model.replies.push(async () => reply({ text: "Say this:\nBuses run hourly.\nShow this:\nHourly" }));
    h.agent.command({ question: "Sotto did you look up the bus times", askedBy: "A", turnId: "0:2" });
    held.answer(reply({ text: STREAM.at(-1) as string }));
    await h.clock.settle();
    expect(h.timing).toContainEqual(
      expect.objectContaining({ stage: "voice_command", command: "new_question", fallback: true }),
    );
    expect(h.records.map((record) => record.question)).toEqual([
      "What do rivals charge?", "did you look up the bus times",
    ]);
    expect(voice.utterances.length).toBeGreaterThanOrEqual(1);
  });

  it.each(["quieter", "louder"])(
    "hands %s to the room's steering instead of answering it (V3-006)",
    async (command) => {
      const { h, voice } = spoken([]);
      h.model.commands.push({ command, question: "" });
      h.agent.command({ question: "Sotto, not now", askedBy: "A", turnId: "0:2" });
      await h.clock.settle();
      expect(h.steers).toEqual([[command, "0:2"]]);
      expect(voice.utterances).toEqual([]);
      expect(h.records).toEqual([]);
    },
  );

  it("reports a stop too, leaving what it was about to the caller (V3-006)", async () => {
    const h = harness();
    h.model.commands.push({ command: "stop", question: "" });
    h.agent.command({ question: "Sotto stop", askedBy: "A", turnId: "0:4" });
    await h.clock.settle();
    expect(h.steers).toEqual([["stop", "0:4"]]);
  });

  it("stays silent on invalid classification or continue with no interrupted answer", async () => {
    const { h, voice } = spoken([]);
    h.model.commands.push({ command: "continue", question: "" });
    h.agent.command({ question: "Sotto go on", askedBy: "A", turnId: "0:1" });
    await h.clock.settle();
    // Nothing to continue: the room is calling on the hand (V3-017).
    expect(h.callOns).toEqual(["0:1"]);
    h.model.commands.push({ command: "invented" });
    h.agent.command({ question: "Sotto stop", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();
    expect(voice.utterances).toEqual([]);
    expect(h.records).toEqual([]);
    expect(h.warnings).toHaveLength(1);
  });

  it("acknowledges the question before the answer exists, then says it sentence by sentence", async () => {
    const { h, voice } = spoken([
      async (call) => {
        // The acknowledgment is already out: it was queued before the call.
        await microtasks();
        expect(voice.utterances[0]?.text()).toBe(ACK_SEARCH);
        for (const text of STREAM) call.onText?.({ itemId: ANSWER_ITEM, text });
        return reply({ text: STREAM.at(-1) as string });
      },
    ]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    // Two utterances: the acknowledgment, then the answer itself. The answer
    // is a second utterance rather than more text on the first, which is what
    // makes opening it stop the acknowledgment mid-word.
    expect(voice.utterances.map((one) => one.text())).toEqual([ACK_SEARCH, SAID]);
    // The screen half is never spoken: no headline, no detail, no URL.
    expect(voice.utterances[1]?.text()).not.toContain("$5-$25");
  });

  it("records what it said, when the room first heard it, and how long the ack took", async () => {
    const { h } = spoken([
      async (call) => {
        for (const text of STREAM) call.onText?.({ itemId: ANSWER_ITEM, text });
        return reply({ text: STREAM.at(-1) as string });
      },
    ]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    const record = h.records[0];
    expect(record?.spokenText).toBe(SAID);
    // The acknowledgment was asked for the moment the question landed and
    // took 300 ms to be heard; the answer's own utterance opened a second
    // later, once its first sentence existed.
    expect(record?.ackMs).toBe(300);
    expect(record?.firstAudioMs).toBe(1_300);
    // Nothing cut it off, so there is no partial to record.
    expect(record?.spokenSoFar).toBeUndefined();
    // And the card carries the spoken half for "transcript of answer".
    expect(h.cards.at(-1)?.spokenText).toBe(SAID);
  });

  it("answers a question that reaches it late on the screen only, hand raised", async () => {
    const { h, voice } = spoken([
      async (call) => {
        for (const text of STREAM) call.onText?.({ itemId: ANSWER_ITEM, text });
        return reply({ text: STREAM.at(-1) as string });
      },
    ]);
    // The question ended at 0 and the address check only let it through
    // eleven seconds later (a slow classifier): a voice starting up now would
    // be an interruption, so the answer is a card with the hand up instead.
    h.wall.advanceBy(ANSWER_LATE_MS + 1_000);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2", heardAtMs: 0 });
    await h.clock.settle();

    expect(voice.utterances).toEqual([]);
    expect(h.timing).toContainEqual(expect.objectContaining({ stage: "answer_late", answerId: "ans-1" }));
    const last = h.cards.at(-1);
    expect(last).toMatchObject({ variant: "answer", state: "ready", raised: true });
    // Still written to be heard, which is what "Sotto, go ahead" reads out.
    expect(last?.spokenText ?? "").not.toBe("");
    // A hand up for a card that only says "thinking" would be asking the room
    // to wait on it: the first push is not raised.
    expect(h.cards[0]?.raised).toBeUndefined();
    expect(h.records[0]).toMatchObject({ late: true, ackMs: null, firstAudioMs: null });
  });

  it("speaks a question that reaches it in time, however it was classified", async () => {
    const { h, voice } = spoken([
      async (call) => {
        for (const text of STREAM) call.onText?.({ itemId: ANSWER_ITEM, text });
        return reply({ text: STREAM.at(-1) as string });
      },
    ]);
    h.wall.advanceBy(ANSWER_LATE_MS - 1_000);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2", heardAtMs: 0 });
    await h.clock.settle();
    expect(voice.utterances.length).toBeGreaterThan(0);
    expect(h.cards.at(-1)?.raised).toBeUndefined();
  });

  it("logs what the room waited from the end of the question to the first sound", async () => {
    const { h } = spoken([
      async (call) => {
        for (const text of STREAM) call.onText?.({ itemId: ANSWER_ITEM, text });
        return reply({ text: STREAM.at(-1) as string });
      },
    ]);
    // `speechEnd` reached the server 800 ms before the address check let the
    // question through, and that wait is part of what the room felt (V2-008b).
    h.wall.advanceBy(800);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2", heardAtMs: 0 });
    await h.clock.settle();

    expect(h.timing).toContainEqual(expect.objectContaining({
      stage: "answer_voice", answerId: "ans-1", ackMs: 300,
      speechEndToAskMs: 800, speechEndToAckMs: 1_100, speechEndToAnswerMs: 2_100,
    }));
  });

  it("leaves the latency unmeasured when nothing saw the question end", async () => {
    const { h } = spoken([
      async (call) => {
        for (const text of STREAM) call.onText?.({ itemId: ANSWER_ITEM, text });
        return reply({ text: STREAM.at(-1) as string });
      },
    ]);
    // Typed (US-019): there was no end of speech, so there is no number.
    h.agent.ask({ question: "what do rivals charge?", askedBy: null, turnId: null });
    await h.clock.settle();

    expect(h.timing).toContainEqual(expect.objectContaining({
      stage: "answer_voice", ackMs: 300, speechEndToAckMs: null,
    }));
  });

  it("records what the room actually heard when speech was cut off", async () => {
    const { h, voice } = spoken([
      async (call) => {
        call.onText?.({ itemId: ANSWER_ITEM, text: STREAM[3] as string });
        await microtasks();
        const spoke = voice.utterances[1];
        if (spoke === undefined) throw new Error("the answer was never spoken");
        // The Stop button, mid-sentence.
        spoke.heard = "They charge five to twenty";
        spoke.cancel();
        return reply({ text: STREAM.at(-1) as string });
      },
    ]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    const record = h.records[0];
    expect(record?.spokenText).toBe(SAID);
    expect(record?.spokenSoFar).toBe("They charge five to twenty");
    // Still a finished answer on the stage: only the sound stopped.
    expect(record?.status).toBe("done");
  });

  it("says each sentence exactly once, however the stream is chopped up", async () => {
    const whole = STREAM.at(-1) as string;
    const { h, voice } = spoken([
      async (call) => {
        // One character at a time, which is the worst case the parser sees.
        for (let at = 1; at <= whole.length; at += 1) {
          call.onText?.({ itemId: ANSWER_ITEM, text: whole.slice(0, at) });
        }
        return reply({ text: whole });
      },
    ]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(voice.utterances[1]?.text()).toBe(SAID);
    expect(h.records[0]?.spokenText).toBe(SAID);
  });

  it("answers on screen only when nothing would be heard", async () => {
    const { h, voice } = spoken([async () => reply({ text: STREAM.at(-1) as string })]);
    voice.available = false;
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(voice.utterances).toHaveLength(0);
    const record = h.records[0];
    // The card is exactly the card the core build showed.
    expect(record?.status).toBe("done");
    expect(record?.headline).toBe("Rivals charge $5-$25 a seat");
    expect(record?.detailMd).toBe("- Notion $12");
    // The words it would have said are still written down.
    expect(record?.spokenText).toBe(SAID);
    expect(record?.ackMs).toBeNull();
    expect(record?.firstAudioMs).toBeNull();
  });

  it("still answers when the voice itself fails, and says so in the log", async () => {
    const { h, voice } = spoken([async () => reply({ text: STREAM.at(-1) as string })]);
    voice.failure = new Error("voice handshake was refused with HTTP 401");
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.records[0]?.status).toBe("done");
    expect(h.records[0]?.firstAudioMs).toBeNull();
    expect(h.warnings.join(" ")).toContain("401");
  });

  it("keeps the sentences it had already said when the call fails", async () => {
    const { h, voice } = spoken([
      async (call) => {
        call.onText?.({ itemId: ANSWER_ITEM, text: STREAM[3] as string });
        await microtasks();
        throw new Error("the response came back incomplete");
      },
    ]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(voice.utterances[1]?.text()).toBe(SAID);
    expect(h.records[0]).toMatchObject({ status: "error", spokenText: SAID });
  });

  it("speaks the full case even when it exceeds the screen detail budget", async () => {
    const fullCase = "The bull case depends on durable demand and distribution. ".repeat(30) +
      "The bear case depends on costs and competition. ".repeat(30);
    const { h, voice } = spoken([async (call) => {
      const text = `Say this:\n${fullCase}\n\nShow this:\nDemand versus costs\n\n${fullCase}`;
      call.onText?.({ itemId: ANSWER_ITEM, text });
      return reply({ text });
    }]);
    h.agent.ask({ question: "Give me the full bull and bear case for X", askedBy: "A", turnId: "0:1" });
    await h.agent.flush();
    expect(h.records[0]?.spokenText).toBe(fullCase.trim());
    expect(voice.utterances.at(-1)?.text()).toBe(fullCase.trim());
    // The prompt caps speech at about eighty words, except when the room
    // asked for the full case — which it just did.
    expect(h.model.calls[0]?.system).toContain("under about eighty words");
    expect(h.model.calls[0]?.system).toContain("asked for a full case");
  });

  it("takes its headline from the first spoken sentence when no screen half arrives", async () => {
    const { h, voice } = spoken([
      async () =>
        reply({ text: "Say this:\nThey charge $12 a seat. Evernote is $25." }),
    ]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.records[0]?.headline).toBe("They charge $12 a seat.");
    expect(h.records[0]?.detailMd).toBe("Evernote is $25.");
    expect(voice.utterances[1]?.text()).toBe("They charge $12 a seat. Evernote is $25.");
  });

  describe("the first line while it searches (V2-008c)", () => {
    const FIRST_LINE =
      "You're asking what the other meeting tools charge. Let me pull the actual numbers.";

    /** Everything the room hears, which is the line and then the answer. */
    const BOTH = `${FIRST_LINE} ${SAID}`;

    /** A reply that streams the whole of {@link STREAM} and then finishes. */
    const streamed = async (call: ProseCall): Promise<ProseReply> => {
      for (const text of STREAM) call.onText?.({ itemId: ANSWER_ITEM, text });
      return reply({ text: STREAM.at(-1) as string });
    };

    it("says it after the acknowledgment and continues from it in one utterance", async () => {
      const { h, voice } = spoken([streamed]);
      h.model.firstLines.push(async () => FIRST_LINE);
      h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
      await h.clock.settle();

      // Two utterances, not three: the acknowledgment, then the answer — of
      // which the first line is the opening, which is what makes a barge-in
      // one cancellation and `spokenSoFar` one reading.
      expect(voice.utterances).toHaveLength(2);
      expect(voice.utterances[1]?.said).toEqual([FIRST_LINE, SAID]);

      // The holding call is given the conversation and asked for a line, not
      // an answer; the searched call is told what the room already heard.
      expect(h.model.firstLineCalls).toHaveLength(1);
      expect(h.model.firstLineCalls[0]?.user).toContain("what do rivals charge?");
      expect(h.model.firstLineCalls[0]?.user).toContain("Do not answer the question");
      expect(h.model.calls[0]?.user).toContain(FIRST_LINE);
      expect(h.model.calls[0]?.user).toContain("already started answering out loud");

      // The card is the searched answer's, unchanged; only the transcript of
      // what was said holds both parts.
      const record = h.records[0];
      expect(record?.headline).toBe("Rivals charge $5-$25 a seat");
      expect(record?.detailMd).toBe("- Notion $12");
      expect(record?.spokenText).toBe(BOTH);
      expect(h.cards.at(-1)?.spokenText).toBe(BOTH);
    });

    it("logs when the line was heard and when the searched answer followed it", async () => {
      const { h } = spoken([streamed]);
      h.model.firstLines.push(async () => FIRST_LINE);
      h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
      await h.clock.settle();

      const record = h.records[0];
      // The acknowledgment at 300 ms, then the answer's utterance a second
      // later — which the first line is the start of, so the two agree.
      expect(record?.ackMs).toBe(300);
      expect(record?.firstAudioMs).toBe(1_300);
      expect(record?.firstLineMs).toBe(1_300);
      // The continuation is heard where the line's speech ends, because the
      // two are one utterance and are played in the order they went over.
      expect(record?.continuationMs).toBe(1_300 + FIRST_LINE.length * 100);
      expect(h.timing).toContainEqual(expect.objectContaining({
        stage: "answer_first_line", answerId: "ans-1", turnId: "0:2",
      }));
      expect(h.timing).toContainEqual(expect.objectContaining({
        stage: "answer_voice", firstLineMs: 1_300, ackToAnswerMs: 1_000,
      }));
    });

    it("skips it when the searched answer's first sentence is ready first", async () => {
      const { h, voice } = spoken([streamed]);
      const late = h.model.heldFirstLine();
      h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
      // The line never arrives inside its head start, so the searched answer
      // goes out without it and says its own first sentence.
      h.wall.advanceBy(FIRST_LINE_CONTEXT_WAIT_MS);
      await microtasks();
      late.write(FIRST_LINE);
      await h.clock.settle();

      expect(voice.utterances[1]?.said).toEqual([SAID]);
      expect(h.model.calls[0]?.user).not.toContain("already started answering out loud");
      const record = h.records[0];
      expect(record?.spokenText).toBe(SAID);
      expect(record?.firstLineMs).toBeNull();
      // With no line in front of it, the continuation *is* the answer's first
      // audio — here a head start later than the test above.
      expect(record?.continuationMs).toBe(record?.firstAudioMs);
      expect(record?.continuationMs).toBe(FIRST_LINE_CONTEXT_WAIT_MS + 1_300);
    });

    it("writes one for a question the conversation already answers, and says it is checking the notes", async () => {
      // The live checkpoint measured 9.8 s of silence after "Mm-hm" on
      // "where are we at": the model reads a whole board before its first
      // sentence, so a notes question gets a holding line too.
      const { h, voice } = spoken([streamed]);
      h.model.firstLines.push(async () => FIRST_LINE);
      h.agent.ask({ question: "what did we decide about pricing?", askedBy: "A", turnId: "0:2" });
      await h.clock.settle();

      expect(h.model.firstLineCalls).toHaveLength(1);
      expect(h.model.firstLineCalls[0]?.user).toMatch(/go back through the notes/);
      expect(h.model.firstLineCalls[0]?.user).not.toMatch(/look that up/);
      expect(voice.utterances[1]?.said[0]).toBe(FIRST_LINE);
      expect(h.records[0]?.firstLineMs).not.toBeNull();
    });

    it("is stopped by the same barge-in the answer is, and read back with it", async () => {
      const { h, voice } = spoken([]);
      const held = h.model.held();
      h.model.firstLines.push(async () => FIRST_LINE);
      h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
      await microtasks();
      // Being said, while the search is still running.
      expect(voice.utterances).toHaveLength(2);
      expect(voice.utterances[1]?.said).toEqual([FIRST_LINE]);

      const spoke = voice.utterances[1]!;
      spoke.heard = "You're asking what the other meeting tools charge.";
      await h.agent.interrupt();
      held.answer(reply({ text: STREAM.at(-1) as string }));
      await h.clock.settle();

      // One cancellation, and nothing opened afterwards to say the rest in.
      expect(voice.utterances).toHaveLength(2);
      const record = h.records[0];
      expect(record?.spokenSoFar).toBe("You're asking what the other meeting tools charge.");
      // What it meant to say is still both halves; what was heard is not.
      expect(record?.spokenText).toBe(BOTH);
    });

    it("says nothing extra when the holding call fails", async () => {
      const { h, voice } = spoken([streamed]);
      h.model.firstLines.push(async () => {
        throw new Error("the holding line timed out");
      });
      h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
      await h.clock.settle();

      expect(voice.utterances[1]?.said).toEqual([SAID]);
      expect(h.records[0]?.status).toBe("done");
      expect(h.records[0]?.firstLineMs).toBeNull();
      expect(h.warnings.join(" ")).toContain("had no first line");
    });
  });
});

describe("Sotto's speech in the transcript (V2-008a)", () => {
  /** A harness with a voice, and a stream clock the test can move. */
  function spoken(
    replies: ((call: ProseCall) => Promise<ProseReply>)[],
    streamNow: () => number = () => 0,
  ) {
    const wall = new SimulatedClock(0);
    const voice = new FakeVoice(wall);
    const h = harness(replies, { voice, wall, streamNow });
    return { h, voice };
  }

  it("writes down what it said, labeled Sotto and placed where playback started", async () => {
    // The stream is 42 s in when the first sentence is spoken; the session
    // clock is nearly an hour of server uptime ahead of it, which is the
    // V2-008 bug this must not repeat.
    const { h } = spoken(
      [
        async (call) => {
          for (const text of STREAM) call.onText?.({ itemId: ANSWER_ITEM, text });
          return reply({ text: STREAM.at(-1) as string });
        },
      ],
      () => 42_000,
    );
    h.clock.advanceTo(3_210_000);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.spokenTurns).toHaveLength(1);
    expect(h.spokenTurns[0]).toEqual({
      turnId: "sotto:ans-1",
      speaker: SOTTO_SPEAKER,
      // Sotto's own words, not the microphone's version of them.
      text: SAID,
      final: true,
      startMs: 42_000,
      endMs: 42_000,
      speakerMappingUncertain: false,
      sotto: true,
    });
  });

  it("holds only what the room heard when speech was cut off, and says so", async () => {
    const { h, voice } = spoken([
      async (call) => {
        call.onText?.({ itemId: ANSWER_ITEM, text: STREAM[3] as string });
        await microtasks();
        const spoke = voice.utterances[1];
        if (spoke === undefined) throw new Error("the answer was never spoken");
        spoke.heard = "They charge five to twenty";
        spoke.cancel();
        return reply({ text: STREAM.at(-1) as string });
      },
    ]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.spokenTurns).toHaveLength(1);
    expect(h.spokenTurns[0]?.text).toBe("They charge five to twenty");
    expect(h.spokenTurns[0]?.interrupted).toBe(true);
  });

  it("adds nothing when a cut-off utterance never reported being heard", async () => {
    const { h, voice } = spoken([
      async (call) => {
        call.onText?.({ itemId: ANSWER_ITEM, text: STREAM[3] as string });
        await microtasks();
        voice.utterances[1]?.cancel();
        return reply({ text: STREAM.at(-1) as string });
      },
    ]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.spokenTurns).toEqual([]);
  });

  it("adds nothing for a muted answer, which nobody heard", async () => {
    const { h, voice } = spoken([async () => reply({ text: STREAM.at(-1) as string })]);
    voice.available = false;
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.records[0]?.status).toBe("done");
    expect(h.spokenTurns).toEqual([]);
  });

  it("adds nothing for an acknowledgment, which is not a contribution", async () => {
    const { h, voice } = spoken([
      async () => {
        await microtasks();
        // The acknowledgment is the only utterance there has been.
        expect(voice.utterances).toHaveLength(1);
        throw new Error("the model gave up");
      },
    ]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.records[0]?.status).toBe("error");
    expect(h.spokenTurns).toEqual([]);
  });

  it("writes down the sentences a failed answer had already said", async () => {
    const { h } = spoken(
      [
        async (call) => {
          // Far enough for the spoken half to be whole, which is what it said.
          call.onText?.({ itemId: ANSWER_ITEM, text: STREAM[3] as string });
          throw new Error("the stream broke");
        },
      ],
      () => 7_500,
    );
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.records[0]?.status).toBe("error");
    expect(h.spokenTurns[0]).toMatchObject({ text: SAID, startMs: 7_500, sotto: true });
  });

  it("gives each answer its own line", async () => {
    const whole = STREAM.at(-1) as string;
    const { h } = spoken([
      async (call) => {
        call.onText?.({ itemId: ANSWER_ITEM, text: whole });
        return reply({ text: whole });
      },
      async (call) => {
        call.onText?.({ itemId: ANSWER_ITEM, text: whole });
        return reply({ text: whole });
      },
    ]);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    h.agent.ask({ question: "and what about us?", askedBy: "B", turnId: "0:3" });
    await h.clock.settle();

    expect(h.spokenTurns.map((one) => one.turnId)).toEqual(["sotto:ans-1", "sotto:ans-2"]);
  });
});

describe("briefing from the research (V2-015)", () => {
  function packet(overrides: Partial<ResearchPacket> = {}): ResearchPacket {
    return {
      id: "packet-1",
      ideaId: "idea-1",
      title: "Otter, Fireflies and Granola all only transcribe",
      teaser: "All three ship transcripts; none of them speaks up in the meeting.",
      keyPoints: ["Otter reviews complain about summaries"],
      sources: [{ url: "https://otter.ai/pricing", title: "Otter.ai — Pricing" }],
      createdAtMs: 60_000,
      latencyMs: 14_000,
      ...overrides,
    };
  }

  const BRIEF = "Otter and Fireflies both stop at the transcript.";

  /** A reply built from the research, with the packet's page under Sources. */
  const briefed = async (call: ProseCall): Promise<ProseReply> => {
    const text =
      `Say this:\n${BRIEF}\n\nShow this:\nAll three only transcribe\n\n` +
      "- Otter stops at the transcript\n\nSources:\n- Otter.ai — Pricing - https://otter.ai/pricing";
    call.onText?.({ itemId: ANSWER_ITEM, text });
    // Nothing was searched for: the research already had the pages.
    return reply({ text, searched: false, searchedUrls: [] });
  };

  /** A harness with a voice and research already done. */
  function asked(packets: ResearchPacket[], replies = [briefed]) {
    const wall = new SimulatedClock(0);
    const voice = new FakeVoice(wall);
    const h = harness(replies, { voice, wall, packets });
    return { h, voice };
  }

  it("gives the model every packet, whatever the question is about", async () => {
    const { h } = asked([packet(), packet({ id: "packet-2", title: "Market was $3.5B" })]);
    h.agent.ask({ question: "how long would that take to build?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    const user = h.model.calls[0]?.user ?? "";
    expect(user).toContain("## Research you have already done");
    expect(user).toContain("### packet-1 — Otter, Fireflies and Granola all only transcribe");
    expect(user).toContain("### packet-2 — Market was $3.5B");
    // Not a briefing: nothing came forward and nothing was asked about.
    expect(h.briefings).toEqual([]);
    expect(user).not.toContain("They are asking about");
    expect(h.records[0]?.packetIds).toEqual(["packet-1", "packet-2"]);
  });

  it("brings the packet forward and opens out loud with no acknowledgment", async () => {
    const { h, voice } = asked([packet()]);
    h.agent.ask({ question: "what did you find on competitors?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.briefings).toEqual([["packet-1"]]);
    // One utterance, opening with the line that makes an acknowledgment
    // pointless: the findings were already in hand, so nothing was waited for.
    expect(voice.utterances).toHaveLength(1);
    expect(voice.utterances[0]?.said).toEqual([BRIEFING_OPENER, BRIEF]);
    expect(h.records[0]?.ackMs).toBeNull();
    // 300 ms, not the 1,300 an acknowledged answer measures: the opener *is*
    // the answer's utterance, so the room hears a real sentence a whole
    // utterance sooner than it would have heard "Let me check."
    expect(h.records[0]?.firstLineMs).toBe(300);
    expect(h.records[0]?.firstAudioMs).toBe(300);
    expect(h.records[0]?.spokenText).toBe(`${BRIEFING_OPENER} ${BRIEF}`);
    // And no model call was made to write that line.
    expect(h.model.firstLineCalls).toHaveLength(0);
  });

  it("tells the model what the room is asking about and that it has started", async () => {
    const { h } = asked([packet()]);
    h.agent.ask({ question: "what did you find on competitors?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    const user = h.model.calls[0]?.user ?? "";
    expect(user).toContain("## They are asking about packet-1");
    expect(user).toContain("Brief them from it");
    expect(user).toContain(BRIEFING_OPENER);
    expect(user).toContain("already started answering out loud");
  });

  it("opens for several packets when the question named none of them", async () => {
    const { h, voice } = asked([packet(), packet({ id: "packet-2" })]);
    h.agent.ask({ question: "what did you find?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.briefings[0]).toEqual(["packet-2", "packet-1"]);
    expect(voice.utterances[0]?.said[0]).toBe(BRIEFING_OPENER_MANY);
  });

  it("records which packets the answer was built from, and cites their pages", async () => {
    const { h } = asked([
      packet({ teaser: "The competitors all ship transcripts and nothing else." }),
      packet({
        id: "packet-2",
        title: "Market was $3.5B",
        teaser: "Analysts say $3.5 billion.",
        keyPoints: [],
        sources: [{ url: "https://example.com/market", title: "Market" }],
      }),
    ]);
    h.agent.ask({ question: "what did you find on competitors?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    const record = h.records[0];
    expect(record?.packetIds).toEqual(["packet-1", "packet-2"]);
    expect(record?.usedPacketIds).toEqual(["packet-1"]);
    // The packet's page is a real search result, so it is a citable source
    // even though this call searched for nothing at all.
    expect(record?.citations).toEqual([
      { url: "https://otter.ai/pricing", title: "Otter.ai — Pricing" },
    ]);
    expect(h.warnings.join(" ")).not.toContain("never opened");
  });

  it("shows the sources even when the answer forgot to list them", async () => {
    const { h } = asked([packet()], [
      async (call: ProseCall) => {
        const text = `Say this:\n${BRIEF}\n\nShow this:\nAll three only transcribe`;
        call.onText?.({ itemId: ANSWER_ITEM, text });
        return reply({ text, searched: false, searchedUrls: [] });
      },
    ]);
    h.agent.ask({ question: "tell us about that research", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.records[0]?.citations.map((one) => one.url)).toEqual(["https://otter.ai/pricing"]);
  });

  it("is cut off by the same barge-in any answer is", async () => {
    const { h, voice } = asked([packet()], []);
    const held = h.model.held();
    h.agent.ask({ question: "what did you find on competitors?", askedBy: "A", turnId: "0:2" });
    await microtasks();
    expect(voice.utterances[0]?.said).toEqual([BRIEFING_OPENER]);

    voice.utterances[0]!.heard = "Yes, I looked";
    await h.agent.interrupt();
    held.answer(reply({ text: `Say this:\n${BRIEF}\n\nShow this:\nAll three only transcribe` }));
    await h.clock.settle();

    expect(voice.utterances).toHaveLength(1);
    expect(h.records[0]?.spokenSoFar).toBe("Yes, I looked");
  });

  it("says nothing of the sort when there is no research to brief from", async () => {
    const { h, voice } = asked([]);
    h.agent.ask({ question: "what did you find on competitors?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.briefings).toEqual([]);
    expect(h.model.calls[0]?.user).not.toContain("Research you have already done");
    // The ordinary path: an acknowledgment, then the answer.
    expect(voice.utterances[0]?.text()).toBe(ACK_SEARCH);
    expect(h.records[0]?.packetIds).toEqual([]);
    expect(h.records[0]?.usedPacketIds).toEqual([]);
  });

  it("writes Sotto's whole spoken line into the transcript, opener and all", async () => {
    const { h } = asked([packet()]);
    h.agent.ask({ question: "what did you find on competitors?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.spokenTurns).toHaveLength(1);
    expect(h.spokenTurns[0]?.text).toBe(`${BRIEFING_OPENER} ${BRIEF}`);
  });
});

describe("screenFromSpoken", () => {
  it("clips an over-long first sentence to the headline limit", () => {
    const long = `${"a very long opening clause ".repeat(6)}ends here. And more.`;
    const screen = screenFromSpoken(long);
    expect(screen.headline.length).toBeLessThanOrEqual(90);
    expect(screen.detailMd).toBe("And more.");
  });

  it("leaves no detail when the whole answer is one sentence", () => {
    expect(screenFromSpoken("It is $12 a seat.")).toMatchObject({
      headline: "It is $12 a seat.",
      detailMd: "",
    });
  });
});

describe("recentTurns", () => {
  it("keeps the last hour of conversation and drops what came before", () => {
    const turns = [
      turn({ turnId: "0:1", startMs: 0, endMs: 2_000 }),
      turn({ turnId: "0:2", startMs: 30 * 60_000, endMs: 30 * 60_000 + 2_000 }),
      turn({ turnId: "0:3", startMs: 72 * 60_000, endMs: null }),
    ];
    expect(recentTurns(turns).map((one) => one.turnId)).toEqual(["0:2", "0:3"]);
    expect(recentTurns([])).toEqual([]);
  });

  it("keeps live conversation context when server uptime is far ahead of the audio stream", async () => {
    const h = harness([async () => reply({ text: "The Anthropic case\n\nHere is the case." })], {
      turns: [turn({ turnId: "0:1", text: "We are discussing the Anthropic IPO", startMs: 33_000, endMs: 40_000 })],
    });
    h.clock.advanceTo(1_914_000);
    h.agent.ask({ question: "Give me the bull and bear case", askedBy: "A", turnId: "0:2" });
    await h.agent.flush();
    expect(h.model.calls[0]?.user).toContain("We are discussing the Anthropic IPO");
    expect(h.model.calls[0]?.user).not.toContain("nothing has been transcribed");
  });
});

describe("renderAnswerRequest", () => {
  it("names the speakers as the group named them, and puts the question last", () => {
    const board = emptyBoard();
    board.summary = "Pricing a note-taking app.";
    const answer = cardAnswer({ question: "what do rivals charge?", askedBy: "Jordan" });
    const request = renderAnswerRequest(
      board,
      [turn({ turnId: "0:1", speaker: "A", text: "we need a price" })],
      { A: "Maya" },
      answer,
    );
    expect(request).toContain("Pricing a note-taking app.");
    expect(request).toContain("Maya (00:00): we need a price");
    expect(request.indexOf("what do rivals charge?")).toBeGreaterThan(
      request.indexOf("we need a price"),
    );
    expect(request).toContain("Jordan just asked you");
  });

  it("says so when nothing has been transcribed", () => {
    const request = renderAnswerRequest(emptyBoard(), [], {}, cardAnswer({}));
    expect(request).toContain("_nothing has been transcribed yet_");
  });
});

describe("sameQuestion", () => {
  it("reads a repeat with different words as the same question", () => {
    expect(sameQuestion(
      "is there anything else we should consider for our trip?",
      "is there anything else we should think about for our trip?",
    )).toBe(true);
    expect(sameQuestion("can you look up those bus schedules?", "look up the bus schedules")).toBe(true);
  });

  it("keeps different questions apart", () => {
    expect(sameQuestion("what time is the bus?", "what price is the hotel?")).toBe(false);
    expect(sameQuestion("go ahead", "go on")).toBe(false);
  });
});

describe("a question repeated while the first is in flight", () => {
  it("is skipped, and a typed repeat is not", async () => {
    const h = harness();
    const first = h.model.held();
    const second = h.model.held();
    h.agent.ask({ question: "is there anything else we should consider for our trip?", askedBy: "A", turnId: "0:1" });
    h.agent.ask({ question: "is there anything else we should think about for our trip?", askedBy: "A", turnId: "0:2" });
    h.agent.ask({ question: "is there anything else we should think about for our trip?", askedBy: null, turnId: null });
    expect(h.agent.pending()).toBe(2);
    first.answer(reply({ text: "Return bus\n\nDetail" }));
    await microtasks();
    second.answer(reply({ text: "Return bus again\n\nDetail" }));
    await h.clock.settle();
    expect(h.timing).toContainEqual(expect.objectContaining({ stage: "answer_repeat", turnId: "0:2" }));
    expect(h.records.map((record) => record.question)).toEqual([
      "is there anything else we should consider for our trip?",
      "is there anything else we should think about for our trip?",
    ]);
  });
});

describe("cardForAnswer", () => {
  it("leaves out what has not arrived", () => {
    const card = cardForAnswer(cardAnswer({}));
    expect(card).toEqual({
      id: "card-ans-1",
      variant: "answer",
      state: "thinking",
      createdAtMs: 0,
      headline: "",
      question: "a question",
      askedBy: "typed",
    });
  });

  it("shows an error as an error card, with the reason as the message", () => {
    const card = cardForAnswer(
      cardAnswer({ status: "error", error: "the model returned no text" }),
    );
    expect(card.state).toBe("error");
    expect(card.message).toBe("the model returned no text");
  });
});

/** An {@link Answer} with everything a test does not care about defaulted. */
function cardAnswer(overrides: Partial<Answer>): Answer {
  return {
    id: "ans-1",
    question: "a question",
    askedBy: "typed",
    headline: "",
    detailMd: "",
    citations: [],
    artifacts: [],
    status: "thinking",
    createdAtMs: 0,
    latencyMs: 0,
    spokenText: "",
    ackMs: null,
    firstAudioMs: null,
    firstLineMs: null,
    continuationMs: null,
    packetIds: [],
    usedPacketIds: [],
    ...overrides,
  };
}

describe("AnswerAgent and show_html (US-020)", () => {
  /** A saver that keeps what it was handed, numbering as the session would. */
  function saver(): {
    save: (artifact: ShowHtmlArgs) => Artifact | null;
    saved: ShowHtmlArgs[];
  } {
    const saved: ShowHtmlArgs[] = [];
    return {
      saved,
      save: (artifact) => {
        saved.push(artifact);
        const file = `0${saved.length}-${artifact.title.toLowerCase().replace(/\s+/g, "-")}.html`;
        return {
          title: artifact.title,
          path: `artifacts/${file}`,
          url: `/api/sessions/s-1/artifacts/${file}`,
        };
      },
    };
  }

  /**
   * A reply that draws once on its way to the answer, the way the real client
   * does it: the tool runs during the call, and the text comes back after.
   */
  function drawing(
    args: { title: string; html: string },
    text: string,
  ): (call: ProseCall) => Promise<ProseReply> {
    return async (call) => {
      const tool = (call.functions ?? []).find((one) => one.name === "show_html");
      if (tool === undefined) throw new Error("show_html was not offered");
      await tool.run(args);
      return reply({ text, functionCalls: 1, searched: false });
    };
  }

  it("offers the tool only when there is somewhere to save what it draws", async () => {
    const without = harness([async (call) => {
      expect(call.functions ?? []).toEqual([]);
      return reply({ text: "An answer\n\nin words." });
    }]);
    without.agent.ask({ question: "sketch the flow", askedBy: null, turnId: null });
    await without.agent.flush();

    const { save } = saver();
    const with_ = harness(
      [
        async (call) => {
          expect((call.functions ?? []).map((one) => one.name)).toEqual(["show_html"]);
          return reply({ text: "An answer\n\nin words." });
        },
      ],
      { onArtifact: save },
    );
    with_.agent.ask({ question: "sketch the flow", askedBy: null, turnId: null });
    await with_.agent.flush();
  });

  it("saves what the model drew and puts it on the card straight away", async () => {
    const { save, saved } = saver();
    const html = "<!DOCTYPE html><html><body><svg/></body></html>";
    const h = harness(
      [drawing({ title: "User flow", html }, "Four screens\n\nThe loops are at the bottom.")],
      { onArtifact: save },
    );
    h.agent.ask({ question: "sketch the flow", askedBy: null, turnId: null });
    await h.agent.flush();

    expect(saved).toEqual([{ title: "User flow", html }]);
    // thinking, the diagram, then the finished answer: the frame is on the
    // stage before the sentence under it is written.
    const withArtifacts = h.cards.filter((card) => (card.artifacts ?? []).length > 0);
    expect(withArtifacts.length).toBeGreaterThanOrEqual(2);
    expect(withArtifacts[0]?.state).toBe("thinking");
    expect(new Set(h.cards.map((card) => card.id)).size).toBe(1);

    const done = h.records[0]!;
    expect(done.status).toBe("done");
    expect(done.artifacts).toEqual([
      {
        title: "User flow",
        path: "artifacts/01-user-flow.html",
        url: "/api/sessions/s-1/artifacts/01-user-flow.html",
      },
    ]);
    // The card carries where to read it, never the markup.
    expect(h.cards.at(-1)?.artifacts).toEqual([
      { title: "User flow", url: "/api/sessions/s-1/artifacts/01-user-flow.html" },
    ]);
  });

  it("tells the model to answer in words when there is nowhere to save it", async () => {
    let told = "";
    const h = harness(
      [
        async (call) => {
          const tool = (call.functions ?? [])[0]!;
          told = await tool.run({ title: "User flow", html: "<svg/>" });
          return reply({ text: "Four screens\n\nin words, then." });
        },
      ],
      { onArtifact: () => null },
    );
    h.agent.ask({ question: "sketch the flow", askedBy: null, turnId: null });
    await h.agent.flush();

    expect(told).toMatch(/unavailable/);
    expect(h.records[0]?.artifacts).toEqual([]);
    expect(h.cards.at(-1)?.artifacts).toBeUndefined();
    expect(h.warnings.join("\n")).toMatch(/could not save "User flow"/);
  });

  it("refuses a document that is not one, and says why", async () => {
    let told = "";
    const { save, saved } = saver();
    const h = harness(
      [
        async (call) => {
          const tool = (call.functions ?? [])[0]!;
          told = await tool.run({ title: "Nothing", html: "   " });
          return reply({ text: "Four screens\n\nin words, then." });
        },
      ],
      { onArtifact: save },
    );
    h.agent.ask({ question: "sketch the flow", askedBy: null, turnId: null });
    await h.agent.flush();

    expect(told).toMatch(/could not be shown/);
    expect(saved).toEqual([]);
    expect(h.records[0]?.artifacts).toEqual([]);
  });

  it("keeps a diagram that was drawn before the words failed", async () => {
    const { save } = saver();
    const h = harness(
      [
        async (call) => {
          await (call.functions ?? [])[0]!.run({ title: "User flow", html: "<svg/>" });
          throw new Error("the model returned no text");
        },
      ],
      { onArtifact: save },
    );
    h.agent.ask({ question: "sketch the flow", askedBy: null, turnId: null });
    await h.agent.flush();

    const card = h.cards.at(-1)!;
    expect(card.state).toBe("error");
    expect(h.records[0]?.artifacts).toHaveLength(1);
  });
});
