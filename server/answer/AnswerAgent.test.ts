import { describe, expect, it } from "vitest";
import type { Answer, AnswerLogRecord } from "../../shared/answers.js";
import { emptyBoard, type Board } from "../../shared/board.js";
import type { StageCard } from "../../shared/cards.js";
import type { SpeakerNames } from "../../shared/events.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import type { ProseCall, ProseReply, ModelClient } from "../model/client.js";
import {
  ANSWER_CONTEXT_MS,
  ANSWER_ITEM_PREFIX,
  ANSWER_MAX_TOKENS,
  ANSWER_TRACK_LABEL,
  AnswerAgent,
  cardForAnswer,
  recentTurns,
  renderAnswerRequest,
} from "./AnswerAgent.js";

/** The answer item's id, which is the only one a headline is taken from. */
const ANSWER_ITEM = `${ANSWER_ITEM_PREFIX}-01`;

/** A prose reply, with everything a test does not care about defaulted. */
function reply(overrides: Partial<ProseReply> & { text: string }): ProseReply {
  return { citations: [], searchedUrls: [], searched: true, ...overrides };
}

/** A model whose prose calls are answered from a script. */
class FakeModel implements ModelClient {
  readonly calls: ProseCall[] = [];

  constructor(readonly replies: ((call: ProseCall) => Promise<ProseReply>)[]) {}

  async structured(): Promise<never> {
    throw new Error("the answer agent never makes a structured call");
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
}

function harness(
  replies: ((call: ProseCall) => Promise<ProseReply>)[] = [],
  options: { speakers?: SpeakerNames; board?: Board; turns?: TurnUpdate[] } = {},
): Harness {
  const clock = new SimulatedClock(0);
  const model = new FakeModel(replies);
  const cards: StageCard[] = [];
  const pushes: Answer[] = [];
  const records: AnswerLogRecord[] = [];
  const thinking: boolean[] = [];
  const states: [string, string][] = [];
  const warnings: string[] = [];
  const agent = new AnswerAgent({
    clock,
    model,
    board: () => options.board ?? emptyBoard(),
    transcript: () => options.turns ?? [],
    speakers: () => options.speakers ?? {},
    onCard: (card, answer) => {
      cards.push(card);
      pushes.push(answer);
    },
    onRecord: (record) => records.push(record),
    onThinking: (value) => thinking.push(value),
    onModelState: (state, detail) => states.push([state, detail]),
    logger: {
      log: () => {},
      warn: (line: string) => warnings.push(line),
    },
  });
  return { clock, model, agent, cards, pushes, records, thinking, states, warnings };
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

  it("pushes the headline as soon as line 1 is complete, and ignores the narration", async () => {
    const h = harness([
      async (call) => {
        // The model narrates first, in items of its own (measured).
        call.onText?.({ itemId: "rs_01", text: "I'll look up current pricing." });
        call.onText?.({ itemId: "rs_01", text: "I'll look up current pricing.\nthen read it" });
        // Then the answer, a piece at a time.
        call.onText?.({ itemId: ANSWER_ITEM, text: "Rivals charge $5" });
        call.onText?.({ itemId: ANSWER_ITEM, text: "Rivals charge $5-$25 a seat" });
        call.onText?.({ itemId: ANSWER_ITEM, text: "Rivals charge $5-$25 a seat\n" });
        call.onText?.({ itemId: ANSWER_ITEM, text: "Rivals charge $5-$25 a seat\n\n- Notion $12" });
        return reply({ text: "Rivals charge $5-$25 a seat\n\n- Notion $12" });
      },
    ]);
    h.clock.advanceBy(1_500);
    h.agent.ask({ question: "what do rivals charge?", askedBy: "A", turnId: "0:2" });
    await h.clock.settle();

    expect(h.cards.map((card) => [card.state, card.headline])).toEqual([
      ["thinking", ""],
      ["thinking", "Rivals charge $5-$25 a seat"],
      ["ready", "Rivals charge $5-$25 a seat"],
    ]);
    // One card id throughout, so the stage replaces it rather than stacking.
    expect(new Set(h.cards.map((card) => card.id))).toEqual(new Set(["card-ans-1"]));
    expect(h.cards[2]?.detailMd).toBe("- Notion $12");
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

describe("recentTurns", () => {
  it("keeps the last ten minutes of conversation and drops what came before", () => {
    const turns = [
      turn({ turnId: "0:1", startMs: 0, endMs: 2_000 }),
      turn({ turnId: "0:2", startMs: 9 * 60_000, endMs: 9 * 60_000 + 2_000 }),
      turn({ turnId: "0:3", startMs: 12 * 60_000, endMs: null }),
    ];
    // Twenty minutes in, only the turn from minute 12 is inside the window.
    expect(recentTurns(turns, 20 * 60_000).map((one) => one.turnId)).toEqual(["0:3"]);
    // Ten minutes in, the window reaches back to the start of the session.
    expect(recentTurns(turns, ANSWER_CONTEXT_MS).map((one) => one.turnId)).toEqual([
      "0:1",
      "0:2",
      "0:3",
    ]);
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
    status: "thinking",
    createdAtMs: 0,
    latencyMs: 0,
    ...overrides,
  };
}
