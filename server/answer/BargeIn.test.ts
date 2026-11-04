/**
 * V2-007 exercises real ASR shapes through the echo boundary on a simulated
 * clock, so prompt interruption never depends on APIs, microphones or speakers.
 */
import { describe, expect, it } from "vitest";
import { SimulatedClock } from "../clock.js";
import { SessionTranscription } from "../session/SessionTranscription.js";
import { sottoTurn } from "../../shared/turns.js";
import { detectsAddress } from "../wake.js";
import { BargeIn } from "./BargeIn.js";
import type { AskedQuestion } from "./AnswerAgent.js";

function setup(playingInitially = true, answering = false, unprompted = false) {
  const clock = new SimulatedClock(0);
  let playing = playingInitially;
  let stops = 0;
  const commands: AskedQuestion[] = [];
  const overheard: AskedQuestion[] = [];
  const timing: Record<string, unknown>[] = [];
  const publicText: string[] = [];
  const listening: boolean[] = [];
  const watcher = new BargeIn({
    clock,
    speaking: () => playing,
    answering: () => answering,
    interrupt: () => {
      stops += 1;
      playing = false;
      return Promise.resolve(35);
    },
    command: (asked) => commands.push(asked),
    overheard: (asked) => overheard.push(asked),
    onTiming: (record) => timing.push(record),
    onListening: (value) => listening.push(value),
    unprompted: () => unprompted,
  });
  const transcription = new SessionTranscription({
    clock,
    playback: () => ({ playing, recent: [{ id: "answer", text: "I'm Sotto. The price is twelve dollars." }] }),
    logger: { warn: () => {} },
    onHuman: (turn, record, during) => watcher.accept(turn, record, during),
    onUpdate: (turn) => publicText.push(turn.text),
    onEcho: () => {},
    onEvent: () => {},
  });
  const frame = (value: Record<string, unknown>): void => {
    clock.advanceBy(80);
    transcription.accept({
      session: 0, atMs: clock.now() + 700,
      frame: { audioProcessedMs: clock.now(), ...value },
    });
  };
  const start = (id: number, text: string): void => {
    frame({ type: "speechStart", turnId: id });
    frame({ type: "transcript", transcript: text, final: false });
  };
  const end = (id: number, text: string): void => {
    frame({ type: "speechEnd", turnId: id });
    frame({ type: "speechComplete", turnId: id, transcript: text });
  };
  return { watcher, start, end, frame, commands, overheard, timing, publicText, listening, stops: () => stops };
}

describe("barge-in at the transcription boundary", () => {
  it("cancels on a non-echo partial, waits for final to classify, and logs confirmed silence", async () => {
    const t = setup();
    t.start(1, "Sotto, stop");
    expect(t.stops()).toBe(1);
    expect(t.commands).toEqual([]);
    expect(t.publicText).toEqual([]);
    t.frame({ type: "transcript", transcript: "Sotto, stop please", final: false });
    expect(t.stops()).toBe(1);
    t.end(1, "Sotto, stop please");
    expect(t.commands).toHaveLength(1);
    expect(t.publicText).toEqual(["Sotto, stop please"]);
    expect(t.listening).toEqual([true, false]);
    await Promise.resolve();
    expect(t.timing[0]).toMatchObject({
      stage: "barge_in", flushConfirmed: true, flushMs: 35, wakeToSilenceMs: 735,
    });
  });

  it("cannot be interrupted by Sotto's own transcript line (V2-008a)", () => {
    const t = setup();
    // The line Sotto is in the middle of saying, written down as a turn.
    t.watcher.accept(
      sottoTurn({
        utteranceId: "ans-1",
        text: "Sotto here — the price is twelve dollars.",
        startMs: 1_000,
        interrupted: false,
      }),
      { session: 0, atMs: 1_700, frame: { audioProcessedMs: 1_000 } },
      true,
    );
    expect(t.stops()).toBe(0);
    expect(t.commands).toEqual([]);
    expect(t.listening).toEqual([]);
  });

  it("routes a turn steering the frequency after an unprompted line (V3-006)", () => {
    // Nothing is playing: "Sotto, not now" arrives in the quiet after the
    // line it is about, which is the only time a group says it.
    const t = setup(false, false, true);
    t.start(1, "Sotto, not now");
    t.end(1, "Sotto, not now");
    expect(t.stops()).toBe(0);
    expect(t.commands.map((asked) => asked.question)).toEqual(["Sotto, not now"]);
  });

  it("leaves an ordinary request in that window to the address classifier", () => {
    const t = setup(false, false, true);
    t.start(1, "Sotto, what do the main competitors charge?");
    t.end(1, "Sotto, what do the main competitors charge?");
    expect(t.commands).toEqual([]);
  });

  it("does not route a steering turn with no unprompted line behind it", () => {
    const t = setup(false);
    t.start(1, "Sotto, not now");
    t.end(1, "Sotto, not now");
    expect(t.commands).toEqual([]);
  });

  it("ignores Sotto's own name and unrelated side talk", () => {
    const t = setup();
    t.start(1, "I'm Sotto.");
    t.end(1, "I'm Sotto.");
    t.start(2, "Alex needs parking directions");
    t.end(2, "Alex needs parking directions");
    expect(t.stops()).toBe(0);
    expect(t.commands).toEqual([]);
    expect(t.publicText).toEqual(["Alex needs parking directions"]);
  });

  it("handles thanks Sotto but leaves later questions to the address classifier", () => {
    const t = setup();
    t.start(1, "thanks Sotto");
    t.end(1, "thanks Sotto");
    t.start(2, "Sotto, what about the annual plan?");
    t.end(2, "Sotto, what about the annual plan?");
    expect(t.commands.map((asked) => asked.question)).toEqual([
      "thanks Sotto",
    ]);
    expect(t.stops()).toBe(1);
  });

  it("leaves thanks plus a request to the address classifier when nothing is being answered", () => {
    const t = setup(false);
    const request = "thanks Soto that was helpful can you also check the weather for Saturday";
    t.start(1, request);
    t.end(1, request);
    expect(t.commands).toEqual([]);
  });

  it("still routes stop in the silent gap between acknowledgment and answer", () => {
    const t = setup(false, true);
    t.start(1, "Soto stop");
    t.end(1, "Soto stop");
    expect(t.commands.map((asked) => asked.question)).toEqual(["Sotto stop"]);
  });

  it.each([
    "Sotto", "hey Sato", "Okay, Soto, go on", "thanks Sotto",
    "I was wondering Soto can you help", "I think Sotto is helpful",
  ])(
    "accepts the address %s without waiting for a question", (text) => {
      expect(detectsAddress(text)).toBe(true);
    },
  );

  it.each(["Sotto voce", "Soto's restaurant", "Sottovoce", "Sotto2", "_Sotto", "Sotto_"])(
    "rejects the non-address %s", (text) => {
      expect(detectsAddress(text)).toBe(false);
    },
  );

  it("hands a turn said over the voice without the name to the overheard read, and claims nothing", () => {
    // `2026-11-03_2253-mic`: "Sotto, not now" came through as "So not now"
    // over the answer's playback; nothing stopped the retry.
    const t = setup(true);
    t.start(7, "So not");
    t.end(7, "So not now");
    expect(t.stops()).toBe(0);
    expect(t.commands).toEqual([]);
    expect(t.overheard).toEqual([{ question: "So not now", askedBy: null, turnId: "0:7" }]);
    // Not owned: the ordinary pipeline still gets the turn.
    expect(t.watcher.owns("0:7")).toBe(false);
    expect(t.publicText).toContain("So not now");
  });

  it("overhears nothing when Sotto is not speaking, and nothing addressed", () => {
    const quiet = setup(false);
    quiet.start(8, "not now");
    quiet.end(8, "not now, let's do the hotel");
    expect(quiet.overheard).toEqual([]);
    const named = setup(true);
    named.start(9, "Sotto stop");
    named.end(9, "Sotto stop");
    expect(named.overheard).toEqual([]);
    expect(named.commands).toHaveLength(1);
  });
});
