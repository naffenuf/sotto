/**
 * V2-008's intent routing under controlled clocks. Deferred classifiers expose
 * the live races that instant fixture replay previously hid, without APIs.
 */
import { describe, expect, it } from "vitest";
import { sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import type { WakeTrigger } from "../wakeWatcher.js";
import {
  ADDRESS_ARM_MS,
  ADDRESS_EARLY_WORDS,
  ADDRESS_SETTLE_MS,
  ADDRESS_TIMEOUT_MS,
  AddressWatcher,
} from "./AddressWatcher.js";
import type { AddressClassifier, AddressInput } from "./address.js";

function turn(text: string, id = "0:1", speaker: string | null = "A", final = true): TurnUpdate {
  return { turnId: id, speaker, text, final, startMs: 0, endMs: final ? 100 : null,
    speakerMappingUncertain: false };
}

function setup(classify: AddressClassifier = async () => ({ kind: "mention", question: "" })) {
  const clock = new SimulatedClock();
  const wall = new SimulatedClock();
  const calls: AddressInput[] = [];
  const questions: WakeTrigger[] = [];
  const listening: boolean[] = [];
  const timing: Record<string, unknown>[] = [];
  const signals: AbortSignal[] = [];
  const watcher = new AddressWatcher({
    clock, wallClock: wall,
    classify: (input, signal) => {
      calls.push(input);
      signals.push(signal);
      return classify(input, signal);
    },
    speakers: () => ({ A: "Craig", B: "EJ" }),
    onQuestion: (question) => questions.push(question),
    onListening: (value) => listening.push(value),
    onTiming: (event) => timing.push(event),
  });
  return { clock, wall, calls, questions, listening, timing, signals, watcher };
}

describe("model-assisted addressing", () => {
  it("listens immediately anywhere in a partial, then routes exactly one classified question", async () => {
    const t = setup(async () => ({ kind: "request", question: "Give me the bull and bear case" }));
    const text = "I was wondering Soto can you give me the bull and bear case";
    t.watcher.acceptTurn(turn(text, "0:1", null, false));
    expect(t.listening).toEqual([true]);
    // The partial is already several words past the name, so V2-008b checks
    // it there; the finals below reuse that one call rather than adding any.
    expect(t.calls).toHaveLength(1);
    t.watcher.acceptTurn(turn(text));
    t.watcher.acceptTurn(turn(text));
    await t.clock.settle();
    expect(t.calls).toHaveLength(1);
    expect(t.questions).toEqual([{ turnId: "0:1", speaker: "A", question: "Give me the bull and bear case" }]);
    expect(t.listening).toEqual([true, false]);
    expect(t.timing).toContainEqual(expect.objectContaining({
      stage: "address", kind: "request", fallback: false,
    }));
  });

  it("never classifies Sotto's own transcript line (V2-008a)", async () => {
    const t = setup(async () => ({ kind: "request", question: "anything" }));
    t.watcher.acceptTurn(
      sottoTurn({
        utteranceId: "ans-1",
        text: "Sotto here — what do rivals charge? Around twelve dollars.",
        startMs: 4_000,
        interrupted: false,
      }),
    );
    await t.clock.settle();
    expect(t.calls).toEqual([]);
    expect(t.questions).toEqual([]);
    expect(t.listening).toEqual([]);
  });

  it("does not classify name-free turns, possessives or sotto voce, and rejects mentions", async () => {
    const t = setup();
    const texts = ["what is the price", "Soto's restaurant", "sotto voce", "Sotto is helpful"];
    for (const [id, text] of texts.entries()) {
      t.watcher.acceptTurn(turn(text, String(id)));
    }
    await t.watcher.flush();
    expect(t.calls.map((input) => input.turn.text)).toEqual(["Sotto is helpful"]);
    expect(t.questions).toEqual([]);
    expect(t.listening.at(-1)).toBe(false);
  });

  it("arms only the named speaker, with named recent context, and consumes their next final", async () => {
    const t = setup(async ({ turn: latest }) => latest.text === "Soto"
      ? { kind: "name_only", question: "" }
      : { kind: "request", question: "Tell me the case" });
    t.watcher.acceptTurn(turn("Soto"));
    await t.watcher.flush();
    expect(t.listening).toEqual([true]);
    t.watcher.acceptTurn(turn("Tell me about lunch", "0:2", "B"));
    t.clock.advanceBy(2_000);
    t.watcher.acceptTurn(turn("Tell me the case", "0:3"));
    await t.watcher.flush();
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]?.previous.map((item) => item.text)).toEqual(["Soto", "Tell me about lunch"]);
    expect(t.calls[1]?.speakers).toEqual({ A: "Craig", B: "EJ" });
    expect(t.questions).toHaveLength(1);
    t.watcher.acceptTurn(turn("Another ordinary turn", "0:4"));
    await t.watcher.flush();
    expect(t.calls).toHaveLength(2);
    expect(t.listening.at(-1)).toBe(false);
  });

  it("lowers listening at eight seconds and does not classify an expired follow-up", async () => {
    const t = setup(async () => ({ kind: "name_only", question: "" }));
    t.watcher.acceptTurn(turn("Soto"));
    await t.watcher.flush();
    t.clock.advanceBy(ADDRESS_ARM_MS);
    expect(t.listening).toEqual([true, false]);
    t.watcher.acceptTurn(turn("What about the IPO", "0:2"));
    await t.watcher.flush();
    expect(t.calls).toHaveLength(1);
  });

  it("keeps a fast follow-up queued behind the name-only classification", async () => {
    let release = (_value: unknown): void => {};
    const t = setup(async ({ turn: latest }) => latest.text === "Soto"
      ? new Promise((resolve) => { release = resolve; })
      : { kind: "request", question: "Tell me the case" });
    t.watcher.acceptTurn(turn("Soto"));
    await Promise.resolve();
    t.clock.advanceBy(1_000);
    t.watcher.acceptTurn(turn("Tell me the case", "0:2"));
    release({ kind: "name_only", question: "" });
    await t.watcher.flush();
    expect(t.questions.map((question) => question.turnId)).toEqual(["0:2"]);
  });

  it.each([null, { kind: "request", question: " " }, { kind: "other", question: "x" }])(
    "uses the old detector when the result is unusable: %j", async (result) => {
      const t = setup(async () => result);
      t.watcher.acceptTurn(turn("Sotto, what is the price?"));
      await t.watcher.flush();
      expect(t.questions[0]?.question).toBe("what is the price?");
      expect(t.timing).toContainEqual(expect.objectContaining({ stage: "address_fallback" }));
      expect(t.timing).toContainEqual(expect.objectContaining({ stage: "address", fallback: true }));
    },
  );

  it("logs fallback on errors without inventing a question for a name-only turn", async () => {
    const t = setup(async () => { throw new Error("offline"); });
    t.watcher.acceptTurn(turn("Soto"));
    await t.watcher.flush();
    expect(t.questions).toEqual([]);
    expect(t.timing.at(-1)).toMatchObject({ kind: "mention", fallback: true });
    expect(t.listening.at(-1)).toBe(false);
  });

  it("falls back after six seconds, aborts transport and ignores a late model result", async () => {
    let release = (_value: unknown): void => {};
    const t = setup(() => new Promise((resolve) => { release = resolve; }));
    t.watcher.acceptTurn(turn("Sotto, what is the price?"));
    await Promise.resolve();
    t.wall.advanceBy(ADDRESS_TIMEOUT_MS);
    await t.watcher.flush();
    expect(t.signals[0]?.aborted).toBe(true);
    expect(t.questions).toHaveLength(1);
    expect(t.timing.at(-1)).toMatchObject({ latencyMs: ADDRESS_TIMEOUT_MS, fallback: true });
    release({ kind: "request", question: "duplicate" });
    await Promise.resolve();
    expect(t.questions).toHaveLength(1);
  });

  it("does not double-classify a playback command or answer after Stop", async () => {
    const t = setup(() => new Promise(() => {}));
    t.watcher.acceptTurn(turn("Soto", "0:1", "A", false));
    t.watcher.ignoreTurn("0:1");
    t.watcher.acceptTurn(turn("Soto stop", "0:1"));
    await t.watcher.flush();
    expect(t.calls).toHaveLength(0);
    t.watcher.acceptTurn(turn("Sotto, what is the price?", "0:2"));
    await Promise.resolve();
    t.watcher.stop();
    await t.watcher.flush();
    expect(t.questions).toEqual([]);
    expect(t.signals[0]?.aborted).toBe(true);
    expect(t.listening.at(-1)).toBe(false);
    expect(t.wall.pending).toBe(0);
  });
});

/**
 * V2-008b's early check, on the shapes the captures actually produce: a
 * question reaches four words after the name 1.8–4.9 s before `speechEnd`
 * arrives, the last partial carries the whole utterance, and the final turn
 * mostly just puts the punctuation back.
 */
describe("checking a settled partial early", () => {
  /** Feeds growing partials without ever letting the settle timer fire. */
  function say(t: ReturnType<typeof setup>, texts: string[], id = "0:1"): void {
    for (const text of texts) {
      t.watcher.acceptTurn(turn(text, id, null, false));
      t.clock.advanceBy(ADDRESS_SETTLE_MS - 100);
    }
  }

  it("goes out as soon as there are a few words after the name, mid-sentence", async () => {
    const t = setup(async () => ({ kind: "request", question: "what do the main" }));
    say(t, [" Sotto", " Sotto what do"]);
    // Two words after the name: not yet worth a call.
    expect(t.calls).toEqual([]);
    t.watcher.acceptTurn(turn(" Sotto what do the main", "0:1", null, false));
    // Four words, and no timer had to fire: the speaker is still talking.
    expect(t.calls.map((input) => input.turn.text)).toEqual([" Sotto what do the main"]);
    await t.clock.settle();
    // And nothing is said while they are.
    expect(t.questions).toEqual([]);
    expect(t.timing).toContainEqual(expect.objectContaining({
      stage: "address_early", event: "started", characters: 22,
    }));
  });

  it("keeps the verdict and takes the question from the words the final added", async () => {
    const t = setup(async () => ({ kind: "request", question: "what do the main" }));
    say(t, [" Sotto what do the main"]);
    await t.clock.settle();
    t.watcher.acceptTurn(turn(" Sotto what do the main competitors charge per month. ", "0:1"));
    await t.watcher.flush();
    // One call for the whole turn, and the question is the whole question.
    expect(t.calls).toHaveLength(1);
    expect(t.questions).toEqual([{
      turnId: "0:1", speaker: "A",
      question: "what do the main competitors charge per month.",
    }]);
    expect(t.timing).toContainEqual(expect.objectContaining({
      stage: "address_early", event: "reused", kind: "request", extraWords: 4,
    }));
  });

  it("checks a short request once its text has held still", async () => {
    const t = setup(async () => ({ kind: "request", question: "stop that" }));
    say(t, [" Soto, stop that"]);
    expect(t.calls).toEqual([]);
    t.clock.advanceBy(100);
    await t.clock.settle();
    expect(t.calls).toHaveLength(1);

    t.watcher.acceptTurn(turn(" Soto, stop that. ", "0:1"));
    await t.watcher.flush();
    expect(t.calls).toHaveLength(1);
    expect(t.questions[0]?.question).toBe("stop that");
    expect(t.timing).toContainEqual(expect.objectContaining({
      stage: "address_early", event: "reused", extraWords: 0,
    }));
  });

  it("starts one check per turn however much the partial grows while it is in flight", async () => {
    let release = (_value: unknown): void => {};
    const t = setup(() => new Promise((resolve) => { release = resolve; }));
    say(t, [" Sotto can you list what"]);
    expect(t.calls).toHaveLength(1);
    say(t, [" Sotto can you list what depends", " Sotto can you list what depends on what here"]);
    expect(t.calls).toHaveLength(1);
    release({ kind: "request", question: "can you list what" });
    await t.clock.settle();
    expect(t.calls).toHaveLength(1);
  });

  it("reads the final again when the transcription changed its mind", async () => {
    const t = setup(async ({ turn: latest }) => ({ kind: "request", question: latest.text.trim() }));
    say(t, [" Sotto what do the main"]);
    await t.clock.settle();
    // Not an extension: "do" became "does", so the check read another sentence.
    t.watcher.acceptTurn(turn(" Sotto what does the main rival charge? ", "0:1"));
    await t.watcher.flush();
    expect(t.calls).toHaveLength(2);
    expect(t.timing).toContainEqual(expect.objectContaining({
      stage: "address_early", event: "rechecked", reason: "changed",
    }));
  });

  it("never reuses a name-only verdict the speaker then completed into a request", async () => {
    const t = setup(async ({ turn: latest }) => latest.text.trim() === "Soto"
      ? { kind: "name_only", question: "" }
      : { kind: "request", question: "what about lunch" });
    say(t, [" Soto"]);
    t.clock.advanceBy(100);
    await t.clock.settle();
    t.watcher.acceptTurn(turn(" Soto, what about lunch? ", "0:1"));
    await t.watcher.flush();
    expect(t.calls).toHaveLength(2);
    expect(t.timing).toContainEqual(expect.objectContaining({
      stage: "address_early", event: "rechecked", reason: "name_only",
    }));
    expect(t.questions).toEqual([{ turnId: "0:1", speaker: "A", question: "what about lunch" }]);
  });

  it("reuses a name-only verdict that stood, and arms that speaker", async () => {
    const t = setup(async ({ turn: latest }) => latest.text.trim() === "Soto"
      ? { kind: "name_only", question: "" }
      : { kind: "request", question: "tell me the case" });
    say(t, [" Soto"]);
    t.clock.advanceBy(100);
    await t.clock.settle();
    t.watcher.acceptTurn(turn(" Soto. ", "0:1"));
    await t.watcher.flush();
    expect(t.calls).toHaveLength(1);
    expect(t.questions).toEqual([]);
    expect(t.listening.at(-1)).toBe(true);

    t.watcher.acceptTurn(turn("Tell me the case", "0:2"));
    await t.watcher.flush();
    expect(t.questions).toHaveLength(1);
  });

  it("reuses a mention, which acknowledges nothing, unless it grew a lot", async () => {
    const t = setup(async () => ({ kind: "mention", question: "" }));
    say(t, [" Sotto is being too chatty"]);
    await t.clock.settle();
    t.watcher.acceptTurn(turn(" Sotto is being too chatty today. ", "0:1"));
    await t.watcher.flush();
    expect(t.calls).toHaveLength(1);
    expect(t.questions).toEqual([]);
    expect(t.timing).toContainEqual(expect.objectContaining({
      stage: "address_early", event: "reused", kind: "mention",
    }));

    // Nobody waits on a mention, so a sentence that kept going is read again
    // rather than written off from its first few words.
    say(t, [" Sotto is being too chatty", "0:2"], "0:2");
    await t.clock.settle();
    t.watcher.acceptTurn(turn(
      " Sotto is being too chatty, which reminds me, Sotto what time is it? ", "0:2"));
    await t.watcher.flush();
    expect(t.timing).toContainEqual(expect.objectContaining({
      stage: "address_early", event: "rechecked", reason: "extended",
    }));
  });

  it("stamps speechEnd so the acknowledgment latency is the one the room felt", async () => {
    const t = setup(async () => ({ kind: "request", question: "what about lunch now" }));
    say(t, [" Soto, what about lunch now"]);
    await t.clock.settle();
    // The endpointer closes the turn: the same text again, with an end.
    t.wall.advanceBy(900);
    t.watcher.acceptTurn({ ...turn(" Soto, what about lunch now", "0:1", null, false), endMs: 4_000 });
    t.wall.advanceBy(100);
    t.watcher.acceptTurn(turn(" Soto, what about lunch now? ", "0:1"));
    await t.watcher.flush();
    expect(t.questions[0]?.heardAtMs).toBe(900);
  });

  it("abandons the early check for a turn the barge-in takes over", async () => {
    const t = setup(() => new Promise(() => {}));
    say(t, [" Soto stop that now please"]);
    expect(t.calls).toHaveLength(1);
    t.watcher.ignoreTurn("0:1");
    expect(t.signals[0]?.aborted).toBe(true);
    t.watcher.acceptTurn(turn(" Soto stop that now please. ", "0:1"));
    await t.watcher.flush();
    expect(t.calls).toHaveLength(1);
    expect(t.questions).toEqual([]);
    expect(t.timing).not.toContainEqual(expect.objectContaining({ stage: "address" }));
  });

  it("leaves no timer behind and starts nothing new after Stop", async () => {
    const t = setup(() => new Promise(() => {}));
    t.watcher.acceptTurn(turn(" Soto, lunch", "0:1", null, false));
    expect(t.clock.pending).toBe(1);
    t.watcher.stop();
    expect(t.clock.pending).toBe(0);
    t.clock.advanceBy(ADDRESS_SETTLE_MS);
    await t.clock.settle();
    expect(t.calls).toEqual([]);
  });

  it("goes early on four words, which is what the captures reach in time", () => {
    expect(ADDRESS_EARLY_WORDS).toBe(4);
  });
});
