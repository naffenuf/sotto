import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { SimulatedClock } from "../clock.js";
import { EventBus } from "../events/bus.js";
import type { Speaker, SpeechResult } from "./Speaker.js";
import { VoiceHub, VOICE_FLUSH_WAIT_MS } from "./VoiceHub.js";
import { SELF_ECHO_TAIL_MS } from "./selfEcho.js";

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: (string | Buffer)[] = [];
  send(value: string | Buffer): void { this.sent.push(value); }
  report(value: unknown): void { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
}

function setup() {
  const bus = new EventBus();
  const socket = new Socket();
  const wall = new SimulatedClock(0);
  let audio: ((chunk: Buffer) => void) | undefined;
  let finish!: (result: SpeechResult) => void;
  const positions: number[] = [];
  const said: string[] = [];
  let cancelled = false;
  let heard = "";
  const speaker = {
    start: async () => {}, append: (text: string) => said.push(text),
    finish: () => new Promise<SpeechResult>((resolve) => { finish = resolve; }),
    cancel: () => { cancelled = true; },
    firstAudioMs: 299,
    spokenSoFar: () => heard,
    notePlayedMs: (ms: number) => positions.push(ms), notePlayedAll: () => positions.push(-1),
  } as unknown as Speaker;
  const hub = new VoiceHub(bus, (onAudio) => { audio = onAudio; return speaker; }, wall);
  hub.attach(socket as unknown as WebSocket);
  return {
    bus, socket, hub, positions, said, wall,
    emitAudio: (bytes: Buffer) => audio?.(bytes),
    end: (overrides: Partial<SpeechResult> = {}) =>
      finish({ reason: "complete", text: "Hello", spokenSoFar: "", audioBytes: 2, audioMs: 1, firstAudioMs: 299, ...overrides }),
    hear: (text: string) => { heard = text; },
    cancelled: () => cancelled,
  };
}

describe("voice playback transport", () => {
  it("exposes only heard text, from playback start through the 1.5-second echo tail", async () => {
    const t = setup();
    const id = await t.hub.speak("Heard words. Queued words nobody has heard.");
    expect(t.hub.playback()).toEqual({ playing: false, recent: [] });
    t.socket.report({ type: "started", id });
    expect(t.hub.playback()).toEqual({ playing: true, recent: [{ id, text: "" }] });
    t.hear("Heard words.");
    t.socket.report({ type: "position", id, playedMs: 500 });
    expect(t.hub.playback().recent).toEqual([{ id, text: "Heard words." }]);
    t.hub.stop();
    // The late browser flush can extend heard text even after stop().
    t.hear("Heard words. Queued");
    t.socket.report({ type: "ended", id, playedMs: 650, flushed: true });
    t.wall.advanceBy(SELF_ECHO_TAIL_MS);
    expect(t.hub.playback()).toEqual({
      playing: false,
      recent: [{ id, text: "Heard words. Queued" }],
    });
    t.wall.advanceBy(1);
    expect(t.hub.playback()).toEqual({ playing: false, recent: [] });
  });

  it("retains a completed utterance in the echo tail without extending it on reads", async () => {
    const t = setup();
    const id = await t.hub.speak("Hello");
    t.socket.report({ type: "started", id });
    t.hear("Hello");
    t.end();
    await Promise.resolve();
    t.socket.report({ type: "ended", id, playedMs: 500, flushed: false });
    t.wall.advanceBy(1_000);
    expect(t.hub.playback()).toEqual({ playing: false, recent: [{ id, text: "Hello" }] });
    t.wall.advanceBy(501);
    expect(t.hub.playback().recent).toEqual([]);
  });

  it("forwards audio and uses browser reports until playback finishes", async () => {
    const t = setup();
    const id = await t.hub.speak("Hello");
    expect(t.bus.voiceState()).toMatchObject({ speaking: true, playing: false, utteranceId: id });
    t.emitAudio(Buffer.from([1, 2]));
    expect(t.socket.sent[1]).toEqual(Buffer.from([1, 2]));
    t.socket.report({ type: "started", id });
    t.socket.report({ type: "position", id, playedMs: 400 });
    expect(t.bus.voiceState().playing).toBe(true);
    t.end();
    await Promise.resolve();
    expect(t.bus.voiceState().speaking).toBe(true);
    t.socket.report({ type: "ended", id, playedMs: 500, flushed: false });
    expect(t.positions).toEqual([400, 500, -1]);
    expect(t.bus.voiceState().speaking).toBe(false);
  });

  it("cancels speech and discards late audio when stopped", async () => {
    const t = setup();
    const id = await t.hub.speak("Hello");
    t.hub.stop();
    t.emitAudio(Buffer.from([1, 2]));
    expect(t.cancelled()).toBe(true);
    expect(t.socket.sent).toHaveLength(2);
    expect(JSON.parse(t.socket.sent[1] as string)).toEqual({ type: "cancel", id });
    expect(t.bus.voiceState().speaking).toBe(false);
    t.socket.report({ type: "ended", id, playedMs: 375, flushed: true });
    expect(t.positions).toEqual([375]);
  });

  it("does not synthesize when muted, and says so with null rather than an error", async () => {
    const t = setup();
    t.bus.setSettings({ ...t.bus.settingsState(), voiceMuted: true });
    await expect(t.hub.speak("Hello")).resolves.toBeNull();
    expect(t.socket.sent).toHaveLength(0);
    expect(t.bus.voiceState().speaking).toBe(false);
  });

  it("does not synthesize with no page attached to play it", async () => {
    let built = false;
    const hub = new VoiceHub(new EventBus(), () => {
      built = true;
      return {} as Speaker;
    });
    await expect(hub.speak("Hello")).resolves.toBeNull();
    expect(built).toBe(false);
  });
});

describe("an utterance fed a sentence at a time (V2-005)", () => {
  it("hands each piece straight on and shows what is being said", async () => {
    const t = setup();
    const utterance = await t.hub.begin();
    expect(utterance).not.toBeNull();
    utterance!.append("Let me check.");
    utterance!.append("They charge $12 a seat.");
    expect(t.said).toEqual(["Let me check.", "They charge $12 a seat."]);
    // The stage shows the answer as it is spoken, not only once it is over.
    expect(t.bus.voiceState().text).toBe("Let me check. They charge $12 a seat.");
    expect(utterance!.firstAudioMs()).toBe(299);

    const spoken = utterance!.finish();
    t.end();
    await expect(spoken).resolves.toMatchObject({ reason: "complete", firstAudioMs: 299 });
    // The page is told no more audio is coming; it plays out what it has.
    expect(JSON.parse(t.socket.sent.at(-1) as string)).toEqual({
      type: "end", id: utterance!.id, reason: "complete",
    });
  });

  it("drops text appended after the room cut it off", async () => {
    const t = setup();
    const utterance = await t.hub.begin();
    utterance!.append("They charge");
    t.hub.stop();
    utterance!.append("and the rest of it");
    expect(t.said).toEqual(["They charge"]);
    expect(t.cancelled()).toBe(true);
  });

  it("waits for the page's last word on what it managed to play", async () => {
    const t = setup();
    const utterance = await t.hub.begin();
    utterance!.append("They charge $12 a seat.");
    const spoken = utterance!.finish();
    t.hub.stop();
    t.end({ reason: "cancelled" });
    await microtasks();
    // The flushed position arrives after the cancel, and it is the only thing
    // that knows how much was heard.
    t.hear("They charge");
    t.socket.report({ type: "ended", id: utterance!.id, playedMs: 410, flushed: true });
    await expect(spoken).resolves.toMatchObject({
      reason: "cancelled",
      spokenSoFar: "They charge",
    });
  });

  it("gives up waiting for a page that never answers", async () => {
    const t = setup();
    const utterance = await t.hub.begin();
    utterance!.append("They charge $12 a seat.");
    const spoken = utterance!.finish();
    t.hub.stop();
    t.end({ reason: "cancelled" });
    await microtasks();
    t.wall.advanceBy(VOICE_FLUSH_WAIT_MS);
    await expect(spoken).resolves.toMatchObject({ reason: "cancelled" });
  });

  it("is a no-op all the way through when nothing would be heard", async () => {
    const t = setup();
    t.bus.setSettings({ ...t.bus.settingsState(), voiceMuted: true });
    expect(await t.hub.begin()).toBeNull();
    expect(t.socket.sent).toHaveLength(0);
  });
});

/** Lets everything already queued as a microtask run, and nothing else. */
async function microtasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
