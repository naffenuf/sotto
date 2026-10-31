/**
 * V2-007 exercises real ASR shapes through the echo boundary on a simulated
 * clock, so prompt interruption never depends on APIs, microphones or speakers.
 */
import { describe, expect, it } from "vitest";
import { SimulatedClock } from "../clock.js";
import { SessionTranscription } from "../session/SessionTranscription.js";
import { detectsAddress } from "../wake.js";
import { BargeIn } from "./BargeIn.js";
import type { AskedQuestion } from "./AnswerAgent.js";

function setup() {
  const clock = new SimulatedClock(0);
  let playing = true;
  let stops = 0;
  const commands: AskedQuestion[] = [];
  const timing: Record<string, unknown>[] = [];
  const publicText: string[] = [];
  const listening: boolean[] = [];
  const watcher = new BargeIn({
    clock,
    speaking: () => playing,
    interrupt: () => {
      stops += 1;
      playing = false;
      return Promise.resolve(35);
    },
    command: (asked) => commands.push(asked),
    onTiming: (record) => timing.push(record),
    onListening: (value) => listening.push(value),
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
  return { start, end, frame, commands, timing, publicText, listening, stops: () => stops };
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

  it("handles thanks Sotto and a later question after playback has stopped", () => {
    const t = setup();
    t.start(1, "thanks Sotto");
    t.end(1, "thanks Sotto");
    t.start(2, "Sotto, what about the annual plan?");
    t.end(2, "Sotto, what about the annual plan?");
    expect(t.commands.map((asked) => asked.question)).toEqual([
      "thanks Sotto", "Sotto, what about the annual plan?",
    ]);
    expect(t.stops()).toBe(1);
  });

  it.each(["Sotto", "hey Sato", "Okay, Soto, go on", "thanks Sotto"])(
    "accepts the address %s without waiting for a question", (text) => {
      expect(detectsAddress(text)).toBe(true);
    },
  );

  it.each(["Sotto voce", "Soto's restaurant", "I think Sotto is helpful", "Sottovoce"])(
    "rejects the non-address %s", (text) => {
      expect(detectsAddress(text)).toBe(false);
    },
  );
});
