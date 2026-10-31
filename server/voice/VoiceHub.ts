import type WebSocket from "ws";
import { VoiceClientFrameSchema, VOICE_SAMPLE_RATE, silentVoice, type VoiceServerFrame } from "../../shared/voice.js";
import type { EventBus } from "../events/bus.js";
import { Speaker } from "./Speaker.js";

/** One playback owner avoids playing the same voice from multiple tabs. */
export class VoiceHub {
  private socket: WebSocket | undefined;
  private speaker: Speaker | undefined;
  private id = 0;
  private active: string | undefined;
  private synthesisDone = false;
  private cancelledSpeaker: { id: string; speaker: Speaker } | undefined;

  constructor(private readonly bus: EventBus, private readonly makeSpeaker: (onAudio: (chunk: Buffer) => void) => Speaker) {}

  attach(socket: WebSocket): boolean {
    if (this.socket && this.socket.readyState === this.socket.OPEN) return false;
    this.socket = socket;
    socket.on("message", (data, binary) => {
      if (binary) return;
      let value: unknown;
      try { value = JSON.parse(data.toString()); } catch { return; }
      const parsed = VoiceClientFrameSchema.safeParse(value);
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.type === "ended" && frame.id === this.cancelledSpeaker?.id) {
        this.cancelledSpeaker.speaker.notePlayedMs(frame.playedMs);
        return;
      }
      if (frame.id !== this.active) return;
      if (frame.type === "started") this.bus.setVoice({ ...this.bus.voiceState(), playing: true });
      if (frame.type === "position" || frame.type === "ended") this.speaker?.notePlayedMs(frame.playedMs);
      if (frame.type === "ended") {
        if (!frame.flushed && this.synthesisDone) this.speaker?.notePlayedAll();
        this.finish(frame.id);
      }
      if (frame.type === "error") { this.stop(); }
    });
    socket.on("close", () => { if (this.socket === socket) { this.socket = undefined; this.stop(); } });
    socket.on("error", () => { if (this.socket === socket) { this.socket = undefined; this.stop(); } });
    return true;
  }

  async speak(text: string): Promise<string> {
    if (this.bus.settingsState().voiceMuted) throw new Error("Voice is muted");
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) throw new Error("No browser is connected for voice playback");
    this.stop();
    const id = `voice-${++this.id}`;
    this.active = id;
    this.synthesisDone = false;
    try {
      const speaker = this.makeSpeaker((chunk) => {
        const socket = this.socket;
        if (this.active === id && socket && socket.readyState === socket.OPEN) socket.send(chunk);
      });
      this.speaker = speaker;
      this.bus.setVoice({ speaking: true, playing: false, utteranceId: id, text });
      this.send({ type: "utterance", id, sampleRate: VOICE_SAMPLE_RATE, text });
      await speaker.start();
      if (this.active !== id) { speaker.cancel(); return id; }
      speaker.append(text);
      void speaker.finish().then((result) => {
        if (this.active !== id) return;
        this.synthesisDone = true;
        this.send({ type: "end", id, reason: result.reason });
      }).catch(() => { if (this.active === id) this.stop(); });
      return id;
    } catch (error) { if (this.active === id) this.stop(); throw error; }
  }

  stop(): void {
    const id = this.active;
    if (!id) return;
    if (this.speaker) this.cancelledSpeaker = { id, speaker: this.speaker };
    this.speaker?.cancel();
    this.send({ type: "cancel", id });
    this.finish(id);
  }

  /** Last cancelled utterance, updated when the browser reports its final position. */
  spokenSoFar(): string { return this.cancelledSpeaker?.speaker.spokenSoFar() ?? ""; }

  private finish(id: string): void {
    if (this.active !== id) return;
    this.active = undefined;
    this.speaker = undefined;
    this.bus.setVoice(silentVoice());
  }

  private send(frame: VoiceServerFrame): void {
    const socket = this.socket;
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  }
}
