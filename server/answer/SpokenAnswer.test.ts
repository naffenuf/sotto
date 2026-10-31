/**
 * V2-007 covers the opening-socket race independently of model generation:
 * a handle arriving after a barge-in must be cancelled before any text is sent.
 */
import { expect, it } from "vitest";
import { SimulatedClock } from "../clock.js";
import type { VoiceUtterance } from "../voice/voiceOut.js";
import { SpokenAnswer } from "./SpokenAnswer.js";

it("cannot reopen speech when the voice socket finishes opening after cancellation", async () => {
  let opened!: (utterance: VoiceUtterance) => void;
  let cancelled = 0;
  const text: string[] = [];
  const speech = new SpokenAnswer({
    wallClock: new SimulatedClock(0),
    askedAtMs: 0,
    voice: { begin: () => new Promise((resolve) => { opened = resolve; }) },
  });
  speech.acknowledge("Let me check.");
  await Promise.resolve();
  speech.cancel();
  speech.say("A late answer must stay on screen.");
  opened({
    id: "opening",
    append: (piece) => text.push(piece),
    cancel: () => { cancelled += 1; },
    firstAudioMs: () => null,
    finish: async () => ({ reason: "cancelled", text: "", spokenSoFar: "", firstAudioMs: null }),
  });
  await expect(speech.done()).resolves.toMatchObject({ interrupted: true, spokenSoFar: "" });
  expect(cancelled).toBe(1);
  expect(text).toEqual([]);
});
