/**
 * V2-006 wiring checks use a fake transcription client, model and voice. The
 * real SessionManager must keep echo out of every downstream path, rather
 * than merely proving the standalone matcher can recognize it.
 */
import { describe, expect, it } from "vitest";
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { ServerEvent } from "../../shared/events.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { silentVoice } from "../../shared/voice.js";
import { SimulatedClock } from "../clock.js";
import { EventBus } from "../events/bus.js";
import type { ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";
import type { SpeechPlayback } from "../voice/selfEcho.js";
import { SessionManager } from "./SessionManager.js";
import type { SessionWriter } from "./SessionStore.js";

function setup(withModel = true) {
  const clock = new SimulatedClock(0);
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const bus = new EventBus(quiet);
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const raw: AsrFrameRecord[] = [];
  const turns: TurnUpdate[] = [];
  const timing: unknown[] = [];
  const answers: unknown[] = [];
  const prompts: { label: string; text: string }[] = [];
  let interrupts = 0;
  const writer: SessionWriter = {
    dir: "/tmp/unused-self-echo-test",
    appendEvent: (record) => raw.push(record),
    appendTurn: (turn) => turns.push(turn),
    appendTiming: (record) => timing.push(record),
    appendAnswer: (answer) => answers.push(answer),
    appendResearch: () => {},
    renameSpeaker: () => {},
    setSettings: () => {},
    writeBoard: () => {},
    appendCandidate: () => {},
    appendFeedback: () => {},
    writeArtifact: () => null,
    end: () => {},
  };
  const model: ModelClient = {
    structured: async (call) => {
      prompts.push({ label: call.label, text: call.user });
      if (call.label === "voice_command") {
        return { command: "new_question", question: "What time is lunch tomorrow?" };
      }
      return call.label === "board" ? { operations: [] } : { candidates: [] };
    },
    grounded: async () => {
      throw new Error("No factual candidate was proposed");
    },
    prose: async (call) => {
      prompts.push({ label: "answer", text: call.user });
      return {
        text: "Lunch is noon\n\nAlex brings sandwiches.",
        citations: [],
        searchedUrls: [],
        searched: false,
        functionCalls: 0,
      };
    },
  };
  let playback: SpeechPlayback = { playing: false, recent: [] };
  let emit!: (record: AsrFrameRecord) => void;
  let finish!: () => void;
  const sessions = new SessionManager({
    bus,
    apiKey: "fake",
    logger: quiet,
    liveClock: clock,
    wallClock: clock,
    createStore: () => writer,
    createModel: () => withModel ? model : null,
    createVoice: () => ({
      begin: async () => null,
      playback: () => playback,
      interrupt: async () => {
        interrupts += 1;
        playback = { ...playback, playing: false };
        bus.setVoice(silentVoice());
        return 20;
      },
    }),
    createAsrClient: ({ onFrame }) => {
      emit = onFrame;
      return {
        run: () => new Promise<void>((resolve) => {
          finish = resolve;
        }),
        stop: () => finish(),
      };
    },
  });
  sessions.start({ kind: "mic" });
  let nextTurn = 0;
  const frame = (value: Record<string, unknown>): void => {
    clock.advanceBy(10);
    emit({ session: 0, atMs: clock.now(), frame: { ...value, audioProcessedMs: clock.now() } });
  };
  const say = (text: string): void => {
    const turnId = nextTurn++;
    for (const value of [
      { type: "speechStart", turnId },
      { type: "transcript", transcript: text, final: false },
      { type: "speaker", label: "A" },
      { type: "speechEnd", turnId },
      { type: "speechComplete", turnId, transcript: text },
    ]) {
      frame(value);
    }
  };
  return {
    sessions, clock, bus, events, raw, turns, timing, answers, prompts, say, frame,
    interrupts: () => interrupts,
    play: (text: string) => {
      playback = { playing: true, recent: [{ id: "speech", text }] };
      bus.setVoice({ speaking: true, playing: true, utteranceId: "speech", text });
    },
    endPlayback: () => {
      playback = { ...playback, playing: false };
      bus.setVoice(silentVoice());
    },
  };
}

describe("self-echo suppression throughout a session", () => {
  it("routes a human partial through barge-in and classifies its final exactly once (V2-007)", async () => {
    const t = setup();
    t.play("The price is twelve dollars a seat.");
    t.frame({ type: "speechStart", turnId: 99 });
    t.frame({ type: "transcript", transcript: "Sotto", final: false });
    expect(t.interrupts()).toBe(1);
    expect(t.answers).toEqual([]);
    expect(t.turns).toEqual([]);
    t.frame({ type: "transcript", transcript: "Sotto what time is lunch tomorrow?", final: false });
    t.frame({ type: "speaker", label: "A" });
    t.frame({ type: "speechEnd", turnId: 99 });
    t.frame({ type: "speechComplete", turnId: 99, transcript: "Sotto what time is lunch tomorrow?" });
    await t.clock.settle();
    expect(t.answers).toHaveLength(1);
    expect(t.prompts.filter((prompt) => prompt.label === "voice_command")).toHaveLength(1);
    expect(t.prompts.filter((prompt) => prompt.label === "address")).toHaveLength(0);
    expect(t.timing).toContainEqual(expect.objectContaining({ stage: "barge_in", flushMs: 20 }));
    expect(t.turns.map((turn) => turn.text)).toEqual(["Sotto what time is lunch tomorrow?"]);
    await t.sessions.stop();
  });

  it("excludes echo from files, UI, introductions, board, observer, wake and answer context", async () => {
    const t = setup();
    const echo = "I'm Sotto. Sotto, what about the secret echo watermelon?";
    t.play(echo);
    t.say(echo);
    expect(t.raw).toEqual([]);
    expect(t.turns).toEqual([]);
    expect(t.bus.speakerNames()).toEqual({});
    expect(t.events.filter((event) => event.type === "turn" || event.type === "wake")).toEqual([]);
    expect(t.timing).toContainEqual(expect.objectContaining({
      stage: "self_echo", selfEcho: true, text: echo,
    }));

    t.say("What time is lunch tomorrow?");
    t.say("Alex brings sandwiches for everyone.");
    expect(t.turns.map((turn) => turn.text)).toEqual([
      "What time is lunch tomorrow?", "Alex brings sandwiches for everyone.",
    ]);
    expect(t.events.some((event) => event.type === "wake" && event.listening)).toBe(false);
    expect(t.answers).toEqual([]);
    t.endPlayback();
    await t.sessions.stop();
    expect(t.sessions.askQuestion("What did we discuss?")).toBe("asked");
    await t.clock.settle();
    expect(t.answers).toHaveLength(1);
    for (const label of ["board", "observer", "answer"]) {
      const calls = t.prompts.filter((prompt) => prompt.label === label);
      expect(calls.length, label).toBeGreaterThan(0);
      expect(calls.some((call) => call.text.includes("sandwiches")), label).toBe(true);
    }
    expect(JSON.stringify(t.prompts)).not.toContain("watermelon");
    expect(JSON.stringify(t.raw)).not.toContain("watermelon");
  });

  it("keeps the opening hello out of the transcript, the files and the board (V2-009)", async () => {
    const t = setup();
    const hello = loadPrompt(PROMPTS.hello);
    // The microphone hears Sotto introduce itself, word for word.
    t.play(hello);
    t.say(hello);
    expect(t.turns).toEqual([]);
    expect(t.raw).toEqual([]);
    expect(t.events.filter((event) => event.type === "turn")).toEqual([]);
    expect(t.bus.speakerNames()).toEqual({});
    t.endPlayback();

    t.say("So, pricing. Where did we land on the per-seat number?");
    expect(t.turns).toHaveLength(1);
    await t.sessions.stop();
    expect(JSON.stringify(t.prompts)).not.toContain("just say");
  });

  it.each([false, true])("releases held cards after playback (late echo: %s)", async (lateEcho) => {
    const t = setup();
    t.clock.advanceBy(1_000);
    t.play("An answer that is still playing after generation ended.");
    t.sessions.interjectionPolicy()?.accept({
      id: "candidate", createdAtMs: 1_000, run: 1, type: "contradiction",
      headline: "Alex cannot attend Thursday", detail: "The dates conflict.", whyNow: "They are choosing a date.",
      evidenceTurnIds: [], evidence: [], relatedBoardItemIds: [],
      scores: { relevance: 1, novelty: 1, importance: 1, confidence: 1 },
    });
    t.clock.advanceBy(10_000);
    expect(t.sessions.interjectionPolicy()?.delivered()).toBe(0);
    expect(t.sessions.interjectionPolicy()?.heldCount()).toBe(1);
    if (lateEcho) {
      t.frame({ type: "speechStart", turnId: 99 });
      t.frame({ type: "transcript", transcript: "An answer that is still playing", final: false });
    }
    t.endPlayback();
    if (lateEcho) {
      expect(t.sessions.interjectionPolicy()?.delivered()).toBe(0);
      t.frame({ type: "speechEnd", turnId: 99 });
      t.frame({ type: "speechComplete", turnId: 99, transcript: "An answer that is still playing" });
      t.clock.advanceBy(100);
    }
    expect(t.sessions.interjectionPolicy()?.delivered()).toBe(1);
    await t.sessions.stop();
  });

  it("filters a hello even when no model is configured", async () => {
    const t = setup(false);
    t.play("I'm Sotto, just say Sotto when you need me.");
    t.say("I'm Sotto, just say Sotto when you need me.");
    expect(t.turns).toEqual([]);
    expect(t.raw).toEqual([]);
    expect(t.timing).toContainEqual(expect.objectContaining({ selfEcho: true }));
    await t.sessions.stop();
  });
});
