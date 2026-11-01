/**
 * V2-008's intent routing under controlled clocks. Deferred classifiers expose
 * the live races that instant fixture replay previously hid, without APIs.
 */
import { describe, expect, it } from "vitest";
import { sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import type { WakeTrigger } from "../wakeWatcher.js";
import { ADDRESS_ARM_MS, ADDRESS_TIMEOUT_MS, AddressWatcher } from "./AddressWatcher.js";
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
    expect(t.calls).toHaveLength(0);
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
