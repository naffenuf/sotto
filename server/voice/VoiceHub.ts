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
import { cleanForSpeech } from "../../shared/spoken.js";
import type WebSocket from "ws";
import {
  VoiceClientFrameSchema,
  VOICE_SAMPLE_RATE,
  silentVoice,
  type VoiceClientFrame,
  type VoiceServerFrame,
} from "../../shared/voice.js";
import { systemClock, type Clock } from "../clock.js";
import type { EventBus } from "../events/bus.js";
import type { Speaker } from "./Speaker.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "./voiceOut.js";
import { SELF_ECHO_TAIL_MS, type SpeechPlayback } from "./selfEcho.js";

/** Builds the Speaker for one utterance; tests pass a fake. */
export type SpeakerFactory = (onAudio: (chunk: Buffer) => void) => Speaker;

/**
 * How long a cancelled utterance waits for the page's last word on what it
 * managed to play.
 *
 * `cancel` and the final `ended` report cross on the wire, and that report is
 * the only thing that knows how much of the buffered audio was actually heard
 * — which is the whole of `spokenSoFar`. Half a second is far more than the
 * round trip to a page on the same machine, and a page that has gone away
 * simply never answers, so it is also a ceiling and not a cost.
 */
export const VOICE_FLUSH_WAIT_MS = 500;

export class VoiceHub implements VoiceOut {
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

  /** Resolves a cancelled utterance's wait for the page's last report. */
  private readonly flushWaiters = new Map<string, () => void>();
  /** Playback, unlike synthesis, determines when an answer is safe to record (V2-007). */
  private readonly playbackWaiters = new Map<string, () => void>();
  /** Cancellation can follow synthesis completion, whose result still says complete. */
  private readonly cutOff = new Set<string>();
  /** Actual receipt times distinguish confirmed silence from a timed-out flush. */
  private readonly flushedAt = new Map<string, number>();
  /** Multiple observers share one bounded wait for the final browser position. */
  private readonly flushPromises = new Map<string, Promise<void>>();
  /** Retain Speakers through the echo tail so a late flushed report still counts. */
  private readonly heard = new Map<string, { speaker: Speaker; endedAt: number | null }>();

  constructor(
    private readonly bus: EventBus,
    private readonly makeSpeaker: SpeakerFactory,
    /** Real time, for {@link VOICE_FLUSH_WAIT_MS}; never the session clock. */
    private readonly clock: Clock = systemClock,
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
   * Opens an utterance and hands it back to be fed text (V2-005).
   *
   * Resolves `null` when nothing would be heard — voice is muted, or no page
   * is attached to play it — which is not an error: a muted Sotto answers on
   * screen only, so callers carry on without speech rather than catching.
   */
  async begin(): Promise<VoiceUtterance | null> {
    if (this.bus.settingsState().voiceMuted) return null;
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) return null;
    this.stop();
    const id = `voice-${++this.nextId}`;
    this.active = id;
    this.synthesisDone = false;
    const speaker = this.makeSpeaker((chunk) => {
      // Audio from an utterance that has since been stopped is dropped here,
      // so a late ElevenLabs frame can never restart a voice the room cut off.
      const socket = this.socket;
      if (this.active === id && socket && socket.readyState === socket.OPEN) socket.send(chunk);
    });
    this.speaker = speaker;
    this.bus.setVoice({ speaking: true, playing: false, utteranceId: id, text: "" });
    this.send({ type: "utterance", id, sampleRate: VOICE_SAMPLE_RATE, text: "" });
    try {
      await speaker.start();
    } catch (error) {
      if (this.active === id) this.stop();
      throw error;
    }
    // Stopped while the ElevenLabs socket was still opening. The handle is
    // still handed back: every one of its methods is a no-op on a cancelled
    // utterance, which is simpler for the caller than a second null.
    if (this.active !== id) speaker.cancel();
    return this.utterance(id, speaker);
  }

  /**
   * Says one whole line, for a caller with nothing left to write — the dev
   * test route (V2-004), and the opening hello (V2-009). Resolves with the
   * utterance id, or `null` when nothing would be heard.
   */
  async speak(text: string): Promise<string | null> {
    const utterance = await this.begin();
    if (utterance === null) return null;
    utterance.append(text);
    void utterance.finish().catch(() => {});
    return utterance.id;
  }

  /**
   * The handle one open utterance is driven through.
   *
   * Everything on it is guarded on the utterance still being the open one, so
   * a model still streaming into speech the room has already cut off is
   * harmless — the same rule the audio callback above follows.
   */
  private utterance(id: string, speaker: Speaker): VoiceUtterance {
    /** Everything appended, so the stage can show what is being said. */
    let said = "";
    return {
      id,
      append: (raw: string): void => {
        // The one place every spoken word passes: whatever the prompts let
        // through, the voice must not read a tilde or a slash aloud.
        const text = cleanForSpeech(raw);
        if (this.active !== id || text.trim() === "") return;
        speaker.append(text);
        said = said === "" ? text.trim() : `${said} ${text.trim()}`;
        const voice = this.bus.voiceState();
        if (voice.utteranceId === id) this.bus.setVoice({ ...voice, text: said });
      },
      cancel: (): void => {
        if (this.active === id) this.stop();
        else speaker.cancel();
      },
      firstAudioMs: (): number | null => speaker.firstAudioMs,
      audioMs: (): number => speaker.audioMs,
      // One `.then`, not an `await`: the `end` frame has to reach the page in
      // the same microtask the synthesis finished in, or a report racing it
      // arrives before the hub knows every character was sent.
      finish: (): Promise<VoiceSpoken> =>
        speaker.finish().then(
          async (result) => {
            if (this.active === id) {
              this.synthesisDone = true;
              this.send({ type: "end", id, reason: result.reason });
            }
            // Synthesis can complete long before the room hears the last word.
            if (this.active === id) await this.awaitPlayback(id, result.audioMs);
            if (this.cutOff.has(id)) await this.waitForFlush(id);
            const spoken: VoiceSpoken = {
              reason: this.cutOff.has(id) ? "cancelled" : result.reason,
              text: result.text,
              spokenSoFar: speaker.spokenSoFar(),
              firstAudioMs: result.firstAudioMs,
            };
            this.cutOff.delete(id);
            // Keep the timestamp long enough for concurrent latency readers,
            // but do not retain every utterance for a multi-hour session.
            this.clock.setTimeout(() => {
              this.flushedAt.delete(id);
              this.flushPromises.delete(id);
            }, SELF_ECHO_TAIL_MS);
            return spoken;
          },
          (error: unknown) => {
            if (this.active === id) this.stop();
            throw error;
          },
        ),
    };
  }

  /**
   * Waits for a cancelled utterance's final `ended` report, or
   * {@link VOICE_FLUSH_WAIT_MS}, whichever comes first.
   */
  private awaitFlush(id: string): Promise<void> {
    if (this.flushedAt.has(id)) return Promise.resolve();
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        this.flushWaiters.delete(id);
        cancelTimer();
        resolve();
      };
      const cancelTimer = this.clock.setTimeout(settle, VOICE_FLUSH_WAIT_MS);
      this.flushWaiters.set(id, settle);
    });
  }

  /**
   * Stops the open utterance now: cancels synthesis, tells the page to drop
   * what it has buffered, and takes `speaking` down. The Stop button, muting,
   * the end of a session, and (V2-007) a barge-in.
   */
  stop(): void {
    const id = this.active;
    if (!id) return;
    this.cutOff.add(id);
    if (this.speaker) this.cancelled = { id, speaker: this.speaker };
    this.speaker?.cancel();
    this.send({ type: "cancel", id });
    this.finish(id);
  }

  /** Stops before returning; the promise measures the browser's confirmation, not synthesis. */
  interrupt(): Promise<number | null> {
    const id = this.active;
    const startedAt = this.clock.now();
    this.stop();
    if (id === undefined) return Promise.resolve(null);
    // Share one wait with finish(), which also needs the final playback position.
    return this.waitForFlush(id).then(() => {
      const endedAt = this.flushedAt.get(id);
      return endedAt === undefined ? null : Math.max(0, endedAt - startedAt);
    });
  }

  /** Multiple observers may need the same flush without replacing each other's resolver. */
  private waitForFlush(id: string): Promise<void> {
    const existing = this.flushPromises.get(id);
    if (existing !== undefined) return existing;
    const waiting = this.awaitFlush(id);
    this.flushPromises.set(id, waiting);
    return waiting;
  }

  private awaitPlayback(id: string, audioMs: number): Promise<void> {
    if (this.active !== id) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const settle = (): void => {
        cancelTimer();
        this.playbackWaiters.delete(id);
        resolve();
      };
      // A lost page report must not wedge the answer queue indefinitely.
      const cancelTimer = this.clock.setTimeout(() => this.stop(), audioMs + 5_000);
      this.playbackWaiters.set(id, settle);
    });
  }

  /** What the room heard of the last utterance Stop cut off; "" if none was. */
  spokenSoFar(): string {
    return this.cancelled?.speaker.spokenSoFar() ?? "";
  }

  /**
   * Echoes match what playback reports say was heard, never text queued for
   * synthesis. This uses the hub's real clock even during a max-speed replay.
   */
  playback(): SpeechPlayback {
    const recent: { id: string; text: string }[] = [];
    let playing = false;
    for (const [id, entry] of this.heard) {
      if (entry.endedAt !== null && this.clock.now() - entry.endedAt > SELF_ECHO_TAIL_MS) {
        this.heard.delete(id);
        continue;
      }
      if (entry.endedAt === null) playing = true;
      recent.push({ id, text: entry.speaker.spokenSoFar() });
    }
    return { playing, recent };
  }

  private onReport(frame: VoiceClientFrame): void {
    // The flushed position of an utterance Stop already closed.
    if (frame.type === "ended" && frame.id === this.cancelled?.id) {
      this.cancelled.speaker.notePlayedMs(frame.playedMs);
      this.flushedAt.set(frame.id, this.clock.now());
      this.flushWaiters.get(frame.id)?.();
      return;
    }
    if (frame.id !== this.active) return;
    switch (frame.type) {
      case "started":
        if (this.speaker) this.heard.set(frame.id, { speaker: this.speaker, endedAt: null });
        this.playback();
        this.bus.setVoice({ ...this.bus.voiceState(), playing: true });
        return;
      case "position": {
        this.speaker?.notePlayedMs(frame.playedMs);
        // So the stage can light the words up as they are heard (every
        // report, 200 ms apart; the bus dedupes nothing here, but a voice
        // event is a few hundred bytes).
        const voice = this.bus.voiceState();
        const heardChars = this.speaker?.spokenSoFar().length ?? 0;
        if (voice.utteranceId === frame.id && voice.heardChars !== heardChars) {
          this.bus.setVoice({ ...voice, heardChars });
        }
        return;
      }
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
    const heard = this.heard.get(id);
    if (heard) heard.endedAt = this.clock.now();
    this.active = undefined;
    this.playbackWaiters.get(id)?.();
    this.speaker = undefined;
    this.bus.setVoice(silentVoice());
  }

  private send(frame: VoiceServerFrame): void {
    const socket = this.socket;
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  }
}
