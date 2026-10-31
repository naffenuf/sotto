import { useEffect } from "react";
import { VOICE_REPORT_MS, type VoiceClientFrame, type VoiceServerFrame } from "../../../shared/voice.js";

/** Receives PCM on the same page as the microphone and schedules it on one audio clock. */
export function useVoicePlayback(onError: (message: string) => void): void {
  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let context: AudioContext | undefined;
    let id: string | undefined;
    let sampleRate = 24_000;
    let nextAt = 0;
    let firstAt = 0;
    let totalMs = 0;
    let segments: { start: number; durationMs: number }[] = [];
    let ended = false;
    let started = false;
    const sources = new Set<AudioBufferSourceNode>();
    const send = (frame: VoiceClientFrame): void => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); };
    const played = (): number => context ? segments.reduce((sum, segment) => sum + Math.min(segment.durationMs, Math.max(0, (context!.currentTime - segment.start) * 1000)), 0) : 0;
    const clear = (): void => { for (const source of sources) { source.onended = null; try { source.stop(); } catch {} } sources.clear(); id = undefined; firstAt = 0; totalMs = 0; segments = []; nextAt = 0; ended = false; started = false; };
    const unlock = (): void => { if (!context) context = new AudioContext(); if (context.state !== "running") void context.resume().catch(() => {}); };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    const tick = window.setInterval(() => {
      if (!id || !context) return;
      if (!started && firstAt && context.currentTime >= firstAt) { started = true; send({ type: "started", id }); }
      if (started) send({ type: "position", id, playedMs: played() });
      if (ended && (!firstAt || context.currentTime >= nextAt)) { send({ type: "ended", id, playedMs: played(), flushed: false }); clear(); }
    }, VOICE_REPORT_MS);
    const connect = (): void => {
      const url = new URL("/ws/voice", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.onmessage = (message: MessageEvent<string | ArrayBuffer>) => {
        if (typeof message.data === "string") {
          let frame: VoiceServerFrame;
          try { frame = JSON.parse(message.data) as VoiceServerFrame; } catch { return; }
          if (frame.type === "utterance") { clear(); id = frame.id; sampleRate = frame.sampleRate; unlock(); }
          else if (frame.id === id && frame.type === "end") ended = true;
          else if (frame.id === id && frame.type === "cancel") { send({ type: "ended", id: frame.id, playedMs: played(), flushed: true }); clear(); }
          return;
        }
        if (!id || !context || message.data.byteLength < 2) return;
        if (context.state !== "running") { send({ type: "error", id, message: "Audio playback is blocked; click the page to enable sound." }); onError("Audio playback is blocked. Click the page to enable sound."); clear(); return; }
        const bytes = new DataView(message.data);
        const count = Math.floor(bytes.byteLength / 2);
        const buffer = context.createBuffer(1, count, sampleRate);
        const samples = buffer.getChannelData(0);
        for (let i = 0; i < count; i++) samples[i] = bytes.getInt16(i * 2, true) / 32768;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const startAt = nextAt >= context.currentTime ? nextAt : context.currentTime + 0.03;
        if (!firstAt) firstAt = startAt;
        nextAt = startAt + buffer.duration;
        totalMs += buffer.duration * 1000;
        segments.push({ start: startAt, durationMs: buffer.duration * 1000 });
        sources.add(source);
        source.onended = () => sources.delete(source);
        source.start(startAt);
      };
      socket.onclose = () => { clear(); if (!closed) retry = window.setTimeout(connect, 2000); };
    };
    connect();
    return () => { closed = true; if (retry !== undefined) window.clearTimeout(retry); window.clearInterval(tick); window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); clear(); socket?.close(); void context?.close(); };
  }, [onError]);
}
