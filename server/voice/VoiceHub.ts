/**
 * Where Sotto's speech meets the page that plays it (V2-004).
 *
 *     Speaker (ElevenLabs socket) -> VoiceHub -> /ws/voice -> Web Audio
 *                                       ^                         |
 *                                       +--- started / position / ended
 *
 * The hub holds **one playback page and one utterance**. One page, because
 * the voice has to come out of the same page that captures the microphone —
 * that is what lets Chrome's echo cancellation use it as a reference — and a
 * second tab playing the same answer would be an echo nothing cancels. One
 * utterance, because Sotto never talks over itself: a new one stops the last.
 *
 * The bus carries what the stage shows (`voice` events). `speaking` goes up
 * when an utterance opens and comes down when the *page* says it has finished
 * playing, not when ElevenLabs has finished sending: synthesis runs faster
 * than real time, so "done generating" can be seconds before "done talking".
 */
import type WebSocket from "ws";
import {
  VoiceClientFrameSchema,
  VOICE_SAMPLE_RATE,
  silentVoice,
  type VoiceClientFrame,
  type VoiceServerFrame,
} from "../../shared/voice.js";
import type { EventBus } from "../events/bus.js";
import type { Speaker } from "./Speaker.js";

/** Builds the Speaker for one utterance; tests pass a fake. */
export type SpeakerFactory = (onAudio: (chunk: Buffer) => void) => Speaker;

export class VoiceHub {
  private socket: WebSocket | undefined;
  private speaker: Speaker | undefined;
  private nextId = 0;
  /** The open utterance's id, or undefined when nothing is being said. */
  private active: string | undefined;
  /** ElevenLabs has sent everything, so the page's `ended` means "all of it was heard". */
  private synthesisDone = false;
  /**
   * The utterance Stop last cut off. The page's final `ended` report arrives
   * after `stop()` has already closed it, and that report is what fixes
   * {@link spokenSoFar} — so the Speaker has to outlive the utterance.
   */
  private cancelled: { id: string; speaker: Speaker } | undefined;

  constructor(
    private readonly bus: EventBus,
    private readonly makeSpeaker: SpeakerFactory,
  ) {}

  /**
   * Takes a page's `/ws/voice` socket as the playback page. Refuses (false)
   * while another page holds an open one; that page losing its socket frees
   * the slot, and whatever it was saying stops.
   */
  attach(socket: WebSocket): boolean {
    if (this.socket && this.socket.readyState === this.socket.OPEN) return false;
    this.socket = socket;
    socket.on("message", (data, binary) => {
      // The page only ever sends JSON; a binary frame is not ours to read.
      if (binary) return;
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = VoiceClientFrameSchema.safeParse(value);
      if (parsed.success) this.onReport(parsed.data);
    });
    const release = (): void => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.stop();
    };
    socket.on("close", release);
    socket.on("error", release);
    return true;
  }

  /**
   * Starts saying `text`, stopping anything already being said. Resolves with
   * the utterance id once ElevenLabs has the text, or with `null` when nothing
   * would be heard — voice is muted, or no page is attached to play it. Null
   * is not an error: a muted Sotto answers on screen only (V2-005), so callers
   * carry on without speech rather than catching.
   */
  async speak(text: string): Promise<string | null> {
    if (this.bus.settingsState().voiceMuted) return null;
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) return null;
    this.stop();
    const id = `voice-${++this.nextId}`;
    this.active = id;
    this.synthesisDone = false;
    try {
      const speaker = this.makeSpeaker((chunk) => {
        // Audio from an utterance that has since been stopped is dropped here,
        // so a late ElevenLabs frame can never restart a voice the room cut off.
        const socket = this.socket;
        if (this.active === id && socket && socket.readyState === socket.OPEN) socket.send(chunk);
      });
      this.speaker = speaker;
      this.bus.setVoice({ speaking: true, playing: false, utteranceId: id, text });
      this.send({ type: "utterance", id, sampleRate: VOICE_SAMPLE_RATE, text });
      await speaker.start();
      // Stopped while the ElevenLabs socket was still opening.
      if (this.active !== id) {
        speaker.cancel();
        return id;
      }
      speaker.append(text);
      void speaker
        .finish()
        .then((result) => {
          if (this.active !== id) return;
          this.synthesisDone = true;
          this.send({ type: "end", id, reason: result.reason });
        })
        .catch(() => {
          if (this.active === id) this.stop();
        });
      return id;
    } catch (error) {
      if (this.active === id) this.stop();
      throw error;
    }
  }

  /**
   * Stops the open utterance now: cancels synthesis, tells the page to drop
   * what it has buffered, and takes `speaking` down. The Stop button, muting,
   * the end of a session, and (V2-007) a barge-in.
   */
  stop(): void {
    const id = this.active;
    if (!id) return;
    if (this.speaker) this.cancelled = { id, speaker: this.speaker };
    this.speaker?.cancel();
    this.send({ type: "cancel", id });
    this.finish(id);
  }

  /** What the room heard of the last utterance Stop cut off; "" if none was. */
  spokenSoFar(): string {
    return this.cancelled?.speaker.spokenSoFar() ?? "";
  }

  private onReport(frame: VoiceClientFrame): void {
    // The flushed position of an utterance Stop already closed.
    if (frame.type === "ended" && frame.id === this.cancelled?.id) {
      this.cancelled.speaker.notePlayedMs(frame.playedMs);
      return;
    }
    if (frame.id !== this.active) return;
    switch (frame.type) {
      case "started":
        this.bus.setVoice({ ...this.bus.voiceState(), playing: true });
        return;
      case "position":
        this.speaker?.notePlayedMs(frame.playedMs);
        return;
      case "ended":
        this.speaker?.notePlayedMs(frame.playedMs);
        // Played out to the end of everything ElevenLabs sent: every character was heard.
        if (!frame.flushed && this.synthesisDone) this.speaker?.notePlayedAll();
        this.finish(frame.id);
        return;
      case "error":
        this.stop();
        return;
    }
  }

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
