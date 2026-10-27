/**
 * Streaming the browser's microphone into a session (US-012).
 *
 *     getUserMedia -> AudioWorklet (80 ms batches) -> Resampler -> PCM16
 *       -> /ws/audio, in binary messages of exactly AUDIO_CHUNK_BYTES
 *
 * The permission prompt is deliberately separate from the streaming:
 * {@link requestMicrophone} runs before `POST /api/session/start`, so a
 * refused microphone never leaves a session running with nothing to listen
 * to, and {@link startMicCapture} runs after it, once the server has a
 * `MicSource` waiting on the other end of the socket.
 */
import { AUDIO_CHUNK_SAMPLES } from "../../../shared/audio.js";
import { Resampler, pcm16ToBytes, toPcm16 } from "./resample.js";

/** Served verbatim from `web/public/`; `addModule` takes a URL, not an import. */
export const MIC_WORKLET_URL = "/mic-worklet.js";

/**
 * How much audio may wait for the socket to open. A second is far more than
 * the handshake needs; past that, dropping the oldest audio keeps the page
 * from growing a buffer it will never send.
 */
const MAX_PENDING_SAMPLES = AUDIO_CHUNK_SAMPLES * 12;

/** Asks for the microphone, turning the browser's errors into readable ones. */
export async function requestMicrophone(): Promise<MediaStream> {
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    throw new Error(
      "This browser will not hand a page the microphone unless the page is on localhost or https.",
    );
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (error) {
    throw new Error(describeMicError(error));
  }
}

/**
 * What to tell the user about a microphone that would not open. `getUserMedia`
 * rejects with a `DOMException` whose `name` is the only reliable part — the
 * `message` differs per browser and says nothing a user can act on.
 */
export function describeMicError(error: unknown): string {
  switch (error instanceof Error ? error.name : "") {
    case "NotAllowedError":
    case "SecurityError":
      return (
        "Microphone access was blocked. Allow it for this page in the browser's site " +
        "settings, then press Start again."
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Plug one in, or replay a fixture instead.";
    case "NotReadableError":
      return "The microphone is already in use by another app. Close it and press Start again.";
    case "AbortError":
      return "The microphone could not be started. Press Start to try again.";
    default:
      return `Could not open the microphone: ${
        error instanceof Error ? error.message : String(error)
      }`;
  }
}

/** Where the audio goes: `/ws/audio` on the page's own origin. */
export function micSocketUrl(href: string = window.location.href): string {
  const url = new URL("/ws/audio", href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export interface MicCaptureOptions {
  /** An open microphone, from {@link requestMicrophone}. */
  stream: MediaStream;
  /** Something went wrong after streaming began; the message is for the user. */
  onError?: (message: string) => void;
  /** Override for the socket URL; defaults to {@link micSocketUrl}. */
  url?: string;
}

/**
 * A microphone streaming into the running session. Built by
 * {@link startMicCapture}; the only thing to do with one is {@link stop} it.
 */
export class MicCapture {
  /** Chunks of {@link AUDIO_CHUNK_SAMPLES} samples sent so far. */
  chunksSent = 0;

  private readonly resampler: Resampler;
  private pending = new Int16Array(0);
  private stopped = false;

  constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly nodes: AudioNode[],
    private readonly socket: WebSocket,
  ) {
    this.resampler = new Resampler(context.sampleRate);
  }

  /** Takes one batch of mono samples from the worklet, at the context's rate. */
  accept(samples: Float32Array): void {
    if (this.stopped) return;
    const resampled = this.resampler.process(samples);
    if (resampled.length === 0) return;

    const merged = new Int16Array(this.pending.length + resampled.length);
    merged.set(this.pending);
    merged.set(toPcm16(resampled), this.pending.length);
    this.pending = merged;

    while (this.socket.readyState === WebSocket.OPEN && this.pending.length >= AUDIO_CHUNK_SAMPLES) {
      this.socket.send(pcm16ToBytes(this.pending.slice(0, AUDIO_CHUNK_SAMPLES)));
      this.pending = this.pending.slice(AUDIO_CHUNK_SAMPLES);
      this.chunksSent += 1;
    }
    // The socket is still opening (or already gone): keep the most recent
    // second and let the rest go rather than buffering without end.
    if (this.pending.length > MAX_PENDING_SAMPLES) {
      this.pending = this.pending.slice(this.pending.length - MAX_PENDING_SAMPLES);
    }
  }

  /** Releases the microphone and closes the socket, which ends the input. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const node of this.nodes) node.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    if (this.socket.readyState <= WebSocket.OPEN) this.socket.close(1000, "capture stopped");
    void this.context.close().catch(() => undefined);
  }
}

/**
 * Opens the audio graph and the socket, and starts streaming.
 *
 * The worklet node is connected through a silent gain to the destination:
 * nothing is played back, but a node with no path to the destination is not
 * pulled, and would never see a sample.
 */
export async function startMicCapture(options: MicCaptureOptions): Promise<MicCapture> {
  const { stream } = options;
  const context = new AudioContext({ latencyHint: "interactive" });
  try {
    await context.audioWorklet.addModule(MIC_WORKLET_URL);
    // Chrome starts a context suspended when the page has had no gesture.
    if (context.state === "suspended") await context.resume();

    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "mic-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
    const silence = context.createGain();
    silence.gain.value = 0;
    source.connect(worklet).connect(silence).connect(context.destination);

    const socket = new WebSocket(options.url ?? micSocketUrl());
    socket.binaryType = "arraybuffer";
    const capture = new MicCapture(stream, context, [source, worklet, silence], socket);

    worklet.port.onmessage = (message: MessageEvent<Float32Array>) => capture.accept(message.data);
    socket.addEventListener("close", (event: CloseEvent) => {
      // A close we did not ask for means the server turned the audio away.
      capture.stop();
      if (event.code !== 1000) {
        options.onError?.(
          `The microphone stream was closed by the server${event.reason === "" ? "" : `: ${event.reason}`}.`,
        );
      }
    });
    return capture;
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
    throw new Error(describeMicError(error));
  }
}
