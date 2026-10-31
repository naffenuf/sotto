/**
 * Playing Sotto's voice (V2-004).
 *
 *     /ws/voice binary PCM16 24 kHz -> AudioBuffer -> scheduled back-to-back
 *       on one AudioContext clock -> speakers
 *
 * This runs in the **same page as {@link ../audio/micCapture.js}** on purpose:
 * Chrome's echo cancellation can only subtract audio it knows the page is
 * playing, so a voice played anywhere else would come straight back through
 * the microphone as somebody talking.
 *
 * Chunks are scheduled at the end of the previous one rather than "now", which
 * is what makes them gapless however unevenly the socket delivers them. The
 * page reports back what has actually come out of the speakers — `started`,
 * `position` every {@link VOICE_REPORT_MS}, `ended` — because only the page
 * knows, and the server's `speaking` state and `spokenSoFar` both depend on it.
 *
 * Chrome will not start an AudioContext without a click or a key press, so
 * the context is created (or resumed) on the first one. Audio that arrives
 * before that is reported as an error rather than silently dropped.
 */
import { useEffect } from "react";
import { VOICE_REPORT_MS, type VoiceClientFrame, type VoiceServerFrame } from "../../../shared/voice.js";

/** How long to wait before reconnecting a lost (or refused) voice socket. */
const RECONNECT_MS = 2000;

/** Lead time for the first chunk, so it is never scheduled in the past. */
const START_LEAD_S = 0.03;

const BLOCKED = "Audio playback is blocked. Click the page to enable sound.";

/** Connects this page as Sotto's speaker for as long as it is mounted. */
export function useVoicePlayback(onError: (message: string) => void): void {
  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let context: AudioContext | undefined;

    // The utterance being played, reset by `clear()`.
    let id: string | undefined;
    let sampleRate = 24_000;
    /** Context time the next chunk starts at: the end of the last one. */
    let nextAt = 0;
    /** Context time the first chunk starts at; 0 until one arrives. */
    let firstAt = 0;
    let segments: { start: number; durationMs: number }[] = [];
    /** The server has sent `end`: whatever is scheduled is all there is. */
    let ended = false;
    let started = false;
    const sources = new Set<AudioBufferSourceNode>();

    const send = (frame: VoiceClientFrame): void => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };

    /** Milliseconds of this utterance that have finished playing. */
    const played = (): number => {
      if (!context) return 0;
      const now = context.currentTime;
      return segments.reduce(
        (sum, segment) => sum + Math.min(segment.durationMs, Math.max(0, (now - segment.start) * 1000)),
        0,
      );
    };

    /** Silences whatever is scheduled and forgets the utterance. */
    const clear = (): void => {
      for (const source of sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Never started, or already stopped.
        }
      }
      sources.clear();
      id = undefined;
      firstAt = 0;
      segments = [];
      nextAt = 0;
      ended = false;
      started = false;
    };

    const unlock = (): void => {
      if (!context) context = new AudioContext();
      if (context.state !== "running") void context.resume().catch(() => {});
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);

    const tick = window.setInterval(() => {
      if (!id || !context) return;
      if (!started && firstAt && context.currentTime >= firstAt) {
        started = true;
        send({ type: "started", id });
      }
      if (started) send({ type: "position", id, playedMs: played() });
      if (ended && (!firstAt || context.currentTime >= nextAt)) {
        send({ type: "ended", id, playedMs: played(), flushed: false });
        clear();
      }
    }, VOICE_REPORT_MS);

    const onControl = (frame: VoiceServerFrame): void => {
      if (frame.type === "utterance") {
        clear();
        id = frame.id;
        sampleRate = frame.sampleRate;
        unlock();
      } else if (frame.id === id && frame.type === "end") {
        ended = true;
      } else if (frame.id === id && frame.type === "cancel") {
        send({ type: "ended", id: frame.id, playedMs: played(), flushed: true });
        clear();
      }
    };

    const onAudio = (data: ArrayBuffer): void => {
      if (!id || !context || data.byteLength < 2) return;
      if (context.state !== "running") {
        send({ type: "error", id, message: BLOCKED });
        onError(BLOCKED);
        clear();
        return;
      }
      const bytes = new DataView(data);
      const count = Math.floor(bytes.byteLength / 2);
      const buffer = context.createBuffer(1, count, sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < count; i++) samples[i] = bytes.getInt16(i * 2, true) / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      // Back-to-back with the last chunk, unless playback has already caught up.
      const startAt = nextAt >= context.currentTime ? nextAt : context.currentTime + START_LEAD_S;
      if (!firstAt) firstAt = startAt;
      nextAt = startAt + buffer.duration;
      segments.push({ start: startAt, durationMs: buffer.duration * 1000 });
      sources.add(source);
      source.onended = () => sources.delete(source);
      source.start(startAt);
    };

    const connect = (): void => {
      const url = new URL("/ws/voice", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.onmessage = (message: MessageEvent<string | ArrayBuffer>) => {
        if (typeof message.data !== "string") {
          onAudio(message.data);
          return;
        }
        try {
          onControl(JSON.parse(message.data) as VoiceServerFrame);
        } catch {
          // Not a frame we know; the server only sends the three above.
        }
      };
      // Also how a second tab waits its turn: the server refuses it while
      // another page is the speaker, and it takes over once that page closes.
      socket.onclose = () => {
        clear();
        if (!closed) retry = window.setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    return () => {
      closed = true;
      if (retry !== undefined) window.clearTimeout(retry);
      window.clearInterval(tick);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      clear();
      socket?.close();
      void context?.close();
    };
  }, [onError]);
}
