import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { EventBus } from "../events/bus.js";
import type { Speaker, SpeechResult } from "./Speaker.js";
import { VoiceHub } from "./VoiceHub.js";

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
  let audio: ((chunk: Buffer) => void) | undefined;
  let finish!: (result: SpeechResult) => void;
  const positions: number[] = [];
  let cancelled = false;
  const speaker = {
    start: async () => {}, append: () => {},
    finish: () => new Promise<SpeechResult>((resolve) => { finish = resolve; }),
    cancel: () => { cancelled = true; },
    notePlayedMs: (ms: number) => positions.push(ms), notePlayedAll: () => positions.push(-1),
  } as unknown as Speaker;
  const hub = new VoiceHub(bus, (onAudio) => { audio = onAudio; return speaker; });
  hub.attach(socket as unknown as WebSocket);
  return { bus, socket, hub, positions, emitAudio: (bytes: Buffer) => audio?.(bytes), end: () => finish({ reason: "complete", text: "Hello", spokenSoFar: "", audioBytes: 2, audioMs: 1, firstAudioMs: 1 }), cancelled: () => cancelled };
}

describe("voice playback transport", () => {
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

  it("does not synthesize when muted", async () => {
    const t = setup();
    t.bus.setSettings({ ...t.bus.settingsState(), voiceMuted: true });
    await expect(t.hub.speak("Hello")).rejects.toThrow("muted");
    expect(t.socket.sent).toHaveLength(0);
  });
});
