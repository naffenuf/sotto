/**
 * V2-006's boundary is tested with real ASR frame shapes and an injected
 * playback state, so both transcript and raw-file leaks are caught offline.
 */
import { describe, expect, it } from "vitest";
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { TurnUpdate } from "../../shared/turns.js";
import type { SpeechPlayback } from "../voice/selfEcho.js";
import { SimulatedClock } from "../clock.js";
import { OVERLAP_SIDE_TALK_MS, SessionTranscription } from "./SessionTranscription.js";

function setup() {
  const clock = new SimulatedClock(0);
  let playback: SpeechPlayback = { playing: false, recent: [] };
  const updates: { turn: TurnUpdate; suppressed: boolean }[] = [];
  const saved: AsrFrameRecord[] = [];
  const echoes: (TurnUpdate & { selfEcho: true })[] = [];
  const input: AsrFrameRecord[] = [];
  const transcription = new SessionTranscription({
    clock,
    playback: () => playback,
    logger: { warn: () => {} },
    onUpdate: (turn, suppressed) => updates.push({ turn, suppressed }),
    onEvent: (record) => saved.push(record),
    onEcho: (turn) => echoes.push(turn),
  });
  const frame = (value: Record<string, unknown>): void => {
    clock.advanceBy(10);
    const record = {
      session: 0,
      atMs: clock.now(),
      frame: { audioProcessedMs: clock.now(), ...value },
    };
    input.push(record);
    transcription.accept(record);
  };
  const start = (id: number, text: string): void => {
    frame({ type: "speechStart", turnId: id });
    frame({ type: "transcript", transcript: text, final: false });
    frame({ type: "speaker", label: "A" });
  };
  const end = (id: number, text: string): void => {
    frame({ type: "speechEnd", turnId: id });
    frame({ type: "speechComplete", turnId: id, transcript: text });
  };
  return {
    clock, transcription, updates, saved, echoes, input, frame, start, end,
    playback: (state: SpeechPlayback) => {
      playback = state;
    },
  };
}

const speech = { playing: true, recent: [{ id: "hello", text: "I'm Sotto. Use the garden gate." }] };

describe("the session's echo boundary", () => {
  it("measures live silence on the stream timeline even when server uptime is much larger", () => {
    const clock = new SimulatedClock(1_914_000);
    const transcription = new SessionTranscription({
      clock,
      playback: () => ({ playing: false, recent: [] }),
      logger: { warn: () => {} },
      onUpdate: () => {},
      onEvent: () => {},
      onEcho: () => {},
    });
    expect(transcription.pauseState().silentForMs).toBe(0);
    transcription.accept({ session: 0, atMs: 1_000,
      frame: { type: "speechStart", turnId: 0, audioProcessedMs: 900 } });
    clock.advanceBy(2_000);
    transcription.accept({ session: 0, atMs: 3_000,
      frame: { type: "speechEnd", turnId: 0, audioProcessedMs: 2_900 } });
    expect(transcription.pauseState()).toEqual({ speaking: false, silentForMs: 650 });
    clock.advanceBy(50);
    expect(transcription.pauseState()).toEqual({ speaking: false, silentForMs: 700 });
  });

  it("puts now on the stream timeline, not on server uptime (V2-008a)", () => {
    const clock = new SimulatedClock(1_914_000);
    const transcription = new SessionTranscription({
      clock,
      playback: () => ({ playing: false, recent: [] }),
      logger: { warn: () => {} },
      onUpdate: () => {},
      onEvent: () => {},
      onEcho: () => {},
    });
    // Before any frame there is nothing to project from, so the stream is at 0.
    expect(transcription.streamNow()).toBe(0);
    transcription.accept({ session: 0, atMs: 42_000,
      frame: { type: "speechStart", turnId: 0, audioProcessedMs: 41_300 } });
    expect(transcription.streamNow()).toBe(42_000);
    clock.advanceBy(1_500);
    expect(transcription.streamNow()).toBe(43_500);
  });

  it("keeps every echo partial and raw frame out, and marks only timing", () => {
    const t = setup();
    t.playback(speech);
    t.start(1, "I'm");
    expect(t.updates).toEqual([]);
    expect(t.saved).toEqual([]);
    t.end(1, "I'm Sotto.");
    expect(t.echoes).toEqual([expect.objectContaining({ selfEcho: true, text: "I'm Sotto." })]);
    expect(t.updates).toEqual([]);
    expect(t.saved).toEqual([]);
    expect(t.transcription.finalTurns()).toEqual([]);
  });

  it("releases side talk whose short partial initially looked like echo", () => {
    const t = setup();
    t.playback(speech);
    t.start(1, "the garden gate");
    t.end(1, "The garden gate sounds fine but Alex needs parking directions tomorrow");
    expect(t.echoes).toEqual([]);
    expect(t.updates).toEqual([expect.objectContaining({ suppressed: true })]);
    expect(t.transcription.finalTurns()).toHaveLength(1);
    expect(t.saved).toEqual(t.input);
  });

  it("keeps the window and wake suppression for a turn finalized after playback", () => {
    const t = setup();
    t.playback(speech);
    t.start(1, "use the garden");
    t.playback({ playing: false, recent: [] });
    t.clock.advanceBy(2_000);
    t.end(1, "Use the garden gate");
    expect(t.echoes).toHaveLength(1);

    t.playback(speech);
    t.start(2, "Sotto, can you");
    t.playback({ playing: false, recent: [] });
    t.end(2, "Sotto, can you explain tomorrow's parking arrangements?");
    expect(t.updates.at(-1)?.suppressed).toBe(true);
  });

  it("does not write off a long turn that only began as Sotto was finishing", () => {
    // 2026-11-03_0945-mic: "Okay, can you tell us, do we need to book ahead for
    // the Barnes Museum?" started in the last second of an answer and ran ten
    // seconds past it; its final is the room talking to Sotto, not side talk.
    const t = setup();
    t.playback(speech);
    t.start(1, "Okay can you");
    t.playback({ playing: false, recent: [] });
    t.clock.advanceBy(OVERLAP_SIDE_TALK_MS + 2_000);
    t.end(1, "Okay, can you tell us, do we need to book ahead for the Barnes Museum?");
    expect(t.updates.at(-1)?.suppressed).toBe(false);

    // A short one over the end of the answer is still side talk.
    t.playback(speech);
    t.start(2, "yeah");
    t.playback({ playing: false, recent: [] });
    t.clock.advanceBy(500);
    t.end(2, "yeah right");
    expect(t.updates.at(-1)?.suppressed).toBe(true);
  });

  it("allows a new human wake question during the tail but removes a tail echo", () => {
    const t = setup();
    t.playback({ ...speech, playing: false });
    t.start(1, "Use the garden gate");
    t.end(1, "Use the garden gate");
    t.start(2, "Sotto, what time is lunch?");
    t.end(2, "Sotto, what time is lunch?");
    expect(t.echoes).toHaveLength(1);
    expect(t.updates).toEqual([expect.objectContaining({ suppressed: false })]);
  });

  it("preserves human partials outside the window and original raw-frame ordering", () => {
    const t = setup();
    t.start(1, "Alex needs parking");
    expect(t.updates.at(-1)?.turn.text).toBe("Alex needs parking");
    t.frame({ type: "audioProgress" });
    t.start(2, "Lunch is noon");
    t.end(2, "Lunch is noon");
    expect(t.saved).toEqual([]);
    t.end(1, "Alex needs parking directions");
    expect(t.saved).toEqual(t.input);
    expect(t.transcription.finalTurns()).toHaveLength(2);
  });

  it("filters one overlapping echo without dropping the other speaker's frames", () => {
    const t = setup();
    t.playback(speech);
    t.start(1, "Use the garden gate");
    const echoFrames = [...t.input];
    t.start(2, "Lunch is noon");
    t.end(2, "Lunch is noon");
    const humanFrames = t.input.slice(echoFrames.length);
    t.end(1, "Use the garden gate");
    expect(t.saved).toEqual(humanFrames);
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0]?.turn.text).toBe("Lunch is noon");
  });

  it("holds policy delivery throughout playback, even in an ASR pause", () => {
    const t = setup();
    t.clock.advanceBy(10_000);
    t.playback(speech);
    expect(t.transcription.pauseState()).toEqual({ speaking: true, silentForMs: 0 });
    t.playback({ ...speech, playing: false });
    expect(t.transcription.pauseState()).toEqual({ speaking: false, silentForMs: 10_000 });
  });

  it("flushes incomplete human captures at stream end but still drops echo", () => {
    const t = setup();
    t.playback(speech);
    t.start(1, "Use the garden gate");
    t.transcription.finish();
    expect(t.saved).toEqual([]);
    expect(t.echoes).toHaveLength(1);
    t.start(2, "Lunch is noon");
    const expected = t.input.slice(3);
    t.transcription.finish();
    expect(t.saved).toEqual(expected);
  });
});
