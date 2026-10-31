/**
 * Sotto's voice: ElevenLabs text-to-speech over its input-streaming socket
 * (https://elevenlabs.io/docs/api-reference/websocket).
 *
 * This is the other half of {@link ../voice/elevenlabs.js}: that module POSTs a
 * whole line and gets a whole WAV back, which is what rendering a fixture
 * wants. A conversation wants the opposite — text arriving a sentence at a time
 * from the model, audio leaving a chunk at a time, and the whole thing stoppable
 * mid-word. So this is a socket, and it is single-use: one `Speaker` is one
 * utterance.
 *
 * Three things about the protocol are load-bearing:
 *
 *   - **The first frame is the handshake** (`{ text: " ", voice_settings,
 *     generation_config }`) and the credential rides the HTTP upgrade's
 *     `xi-api-key` header, not the JSON, so the key never reaches a message
 *     this module might log.
 *   - **`{ text: "" }` ends the stream; `{ text: " " }` does not.** An empty
 *     string is the end-of-input signal, which is why {@link Speaker.flush}
 *     sends a space with `flush: true` rather than nothing.
 *   - **`chunk_length_schedule` is a latency dial.** The server buffers text
 *     until one of those character counts is reached; `flush: true` makes it
 *     generate what it has. Hence {@link Speaker.append} flushing the *first*
 *     chunk of text by default: a short opening sentence would otherwise sit in
 *     the buffer waiting for the rest of the answer to be written.
 *
 * Alignment is requested with `sync_alignment=true`, which attaches per-character
 * timings to every audio frame. They are what makes "what did Sotto actually
 * say before it was cut off?" answerable (V2-007's `continue`): the browser
 * reports its playback position, and {@link Speaker.spokenSoFar} is the
 * characters whose audio had finished by then.
 */
import { WebSocket } from "ws";
import { AUDIO_SAMPLE_RATE } from "../../shared/audio.js";
import { systemClock, type Clock } from "../clock.js";
import { ELEVENLABS_OUTPUT_FORMAT, DEFAULT_TTS_MODEL } from "./elevenlabs.js";

/** ElevenLabs' socket root. `wss`, so the key is only ever sent encrypted. */
export const ELEVENLABS_WS_BASE = "wss://api.elevenlabs.io";

/**
 * Sotto's default voice: the "River" library voice
 * (https://elevenlabs.io/docs/capabilities/text-to-speech#voices) — calm and
 * level, which is what a meeting participant should sound like, and clearly
 * apart from the two fixture voices in `fixtures/voices.json` (Rachel, Adam) so
 * a replayed conversation never has Sotto sounding like one of the people in
 * it. Override with `ELEVENLABS_VOICE_ID`.
 */
export const DEFAULT_SOTTO_VOICE_ID = "SAz9YHcvj6GT2YYXdXww";
export const DEFAULT_SOTTO_VOICE_NAME = "River";

/**
 * Character counts at which the server generates audio for what it has
 * buffered. The first one is deliberately the smallest the API allows (50), so
 * a flushed opening sentence is never the thing keeping the room waiting; the
 * later ones are the documented defaults, which read better across a long
 * answer.
 */
export const CHUNK_LENGTH_SCHEDULE = [50, 160, 250, 290];

/** Calm delivery: steady rather than expressive, and no style exaggeration. */
export const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  use_speaker_boost: true,
} as const;

/** How long the upgrade may take before the socket is abandoned. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** How long after the end-of-input frame the server may take to finish speaking. */
export const FINISH_TIMEOUT_MS = 60_000;
/** Seconds of silence from us before the server hangs up (API max 180). */
export const INACTIVITY_TIMEOUT_S = 60;

/** Why an utterance ended. */
export type SpeechEndReason = "complete" | "cancelled";

export class SpeakerError extends Error {
  constructor(
    message: string,
    readonly code = 0,
    readonly reason = "",
  ) {
    super(message);
    this.name = "SpeakerError";
  }
}

/** What one utterance came to. */
export interface SpeechResult {
  reason: SpeechEndReason;
  /** Every character handed to ElevenLabs, in order. */
  text: string;
  /** The characters whose audio had finished playing — see {@link Speaker.spokenSoFar}. */
  spokenSoFar: string;
  /** PCM16 bytes emitted to `onAudio`. */
  audioBytes: number;
  /** Those bytes as milliseconds of speech. */
  audioMs: number;
  /** `start()` to the first audio frame, on the injected clock; null if none arrived. */
  firstAudioMs: number | null;
}

type Logger = Pick<Console, "log" | "warn" | "error">;

export interface SpeakerOptions {
  /** ElevenLabs API key. Travels in the upgrade header and is never logged. */
  apiKey: string;
  /** Defaults to {@link DEFAULT_SOTTO_VOICE_ID}. */
  voiceId?: string | undefined;
  modelId?: string | undefined;
  /** Override for tests pointing at a local WebSocket server. */
  url?: string | undefined;
  clock?: Clock | undefined;
  logger?: Logger | undefined;
  /** Raw PCM16 mono 24 kHz, in the order the server produced it. */
  onAudio?: ((chunk: Buffer) => void) | undefined;
}

/** One character of synthesized speech and the moment its audio ends. */
interface TimedChar {
  char: string;
  endMs: number;
}

interface Alignment {
  chars: string[];
  startMs: number[];
  durationMs: number[];
}

/** Milliseconds of PCM16 mono audio in `bytes` bytes. */
function pcmDurationMs(bytes: number): number {
  return (bytes / 2 / AUDIO_SAMPLE_RATE) * 1000;
}

function numbers(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((n) => typeof n === "number")
    ? (value as number[])
    : undefined;
}

/**
 * Reads one of the alignment objects off a server frame.
 *
 * `alignment` holds the characters as we sent them and `normalizedAlignment`
 * holds the text the model actually read ("2010" spoken as four words), so
 * `alignment` is preferred: `spokenSoFar` is fed back to a model as "this is
 * what you had said", and it should be our words. The duration array has been
 * spelled both `charDurationsMs` and `charsDurationsMs` in ElevenLabs' docs, so
 * both are accepted.
 */
export function readAlignment(frame: Record<string, unknown>): Alignment | undefined {
  for (const key of ["alignment", "normalizedAlignment"]) {
    const raw = frame[key];
    if (raw === null || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const chars = record["chars"];
    const startMs = numbers(record["charStartTimesMs"]);
    const durationMs =
      numbers(record["charDurationsMs"]) ?? numbers(record["charsDurationsMs"]) ?? undefined;
    if (
      !Array.isArray(chars) ||
      !chars.every((c) => typeof c === "string") ||
      !startMs ||
      !durationMs ||
      chars.length !== startMs.length ||
      chars.length !== durationMs.length
    ) {
      continue;
    }
    return { chars: chars as string[], startMs, durationMs };
  }
  return undefined;
}

/**
 * One spoken utterance. Build it, `start()` it, `append()` text as it is
 * written, then `finish()` — or `cancel()`, which stops the sound at once.
 */
export class Speaker {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly url: string;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly onAudio: ((chunk: Buffer) => void) | undefined;

  private socket: WebSocket | undefined;
  private started = false;
  private ended = false;
  private cancelled = false;
  private inputEnded = false;
  private sawFinal = false;
  private failure: SpeakerError | undefined;

  private startedAtMs = 0;
  private firstAudioAtMs: number | undefined;
  private audioBytes = 0;
  /** Characters handed to the API, exactly as sent (minus the keep-alive spaces). */
  private sentText = "";
  /** Every character the server has reported timings for, in speaking order. */
  private readonly timeline: TimedChar[] = [];
  /** Where the last reported character ends, for the chunk-relative test below. */
  private alignedEndMs = 0;
  private playedMs = 0;

  private finishWaiters: Array<{
    resolve: (result: SpeechResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private cancelFinishTimer: (() => void) | undefined;

  constructor(options: SpeakerOptions) {
    this.apiKey = options.apiKey;
    this.voiceId = options.voiceId?.trim() || DEFAULT_SOTTO_VOICE_ID;
    this.modelId = options.modelId ?? DEFAULT_TTS_MODEL;
    this.url = options.url ?? ELEVENLABS_WS_BASE;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? console;
    this.onAudio = options.onAudio;
  }

  /** The voice this utterance is being spoken in. */
  get voice(): string {
    return this.voiceId;
  }

  /** Everything handed to the API so far. */
  get text(): string {
    return this.sentText;
  }

  /** Milliseconds of speech emitted so far. */
  get audioMs(): number {
    return pcmDurationMs(this.audioBytes);
  }

  /** `start()` to the first audio frame, or null while none has arrived. */
  get firstAudioMs(): number | null {
    return this.firstAudioAtMs === undefined ? null : this.firstAudioAtMs - this.startedAtMs;
  }

  /** True once the stream has ended, for any reason. */
  get finished(): boolean {
    return this.ended;
  }

  /**
   * Opens the socket and sends the handshake.
   *
   * @throws {SpeakerError} if the upgrade is refused, times out, or the socket
   * closes before it opens.
   */
  async start(): Promise<void> {
    if (this.started) throw new Error("Speaker is single-use; make a new one per utterance");
    this.started = true;
    this.startedAtMs = this.clock.now();

    const query = new URLSearchParams({
      model_id: this.modelId,
      output_format: ELEVENLABS_OUTPUT_FORMAT,
      sync_alignment: "true",
      inactivity_timeout: String(INACTIVITY_TIMEOUT_S),
    });
    const url =
      `${this.url}/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream-input` +
      `?${query.toString()}`;

    const socket = new WebSocket(url, { headers: { "xi-api-key": this.apiKey } });
    socket.binaryType = "nodebuffer";

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: SpeakerError) => {
        if (settled) return;
        settled = true;
        cancelConnectTimer();
        this.fail(error);
        reject(error);
      };

      const cancelConnectTimer = this.clock.setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) return;
        socket.terminate();
        fail(new SpeakerError(`voice socket did not open within ${CONNECT_TIMEOUT_MS} ms`));
      }, CONNECT_TIMEOUT_MS);

      socket.on("open", () => {
        if (settled) return;
        settled = true;
        cancelConnectTimer();
        this.socket = socket;
        // The handshake must be the first frame. Its text is a single space:
        // not content, and specifically not the empty string, which would end
        // the stream before a word of it existed.
        socket.send(
          JSON.stringify({
            text: " ",
            voice_settings: DEFAULT_VOICE_SETTINGS,
            generation_config: { chunk_length_schedule: CHUNK_LENGTH_SCHEDULE },
          }),
        );
        this.logger.log(`[voice] speaking with ${this.voiceId} (${this.modelId})`);
        resolve();
      });

      socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        this.receive(data, isBinary);
      });

      socket.on("error", (error: Error) => {
        // ws always follows an error with a close, which is what we settle on.
        this.logger.warn(`[voice] socket error: ${error.message}`);
      });

      socket.on("unexpected-response", (_request, response) => {
        fail(
          new SpeakerError(
            `voice handshake was refused with HTTP ${response.statusCode}`,
            response.statusCode ?? 0,
            response.statusMessage ?? "",
          ),
        );
      });

      socket.on("close", (code: number, reason: Buffer) => {
        const text = reason.toString("utf8");
        fail(
          new SpeakerError(
            `voice socket closed before it opened (${code}${text ? `: ${text}` : ""})`,
            code,
            text,
          ),
        );
        this.closed(code, text);
      });
    });
  }

  /**
   * Hands the next piece of text to the API. Safe to call a sentence at a time
   * while the model is still writing.
   *
   * The first call flushes by default, so the opening sentence is spoken
   * without waiting for {@link CHUNK_LENGTH_SCHEDULE}'s first threshold;
   * later calls do not, because flushing every sentence costs the prosody
   * across a sentence boundary. Pass `flush` to decide for yourself.
   *
   * Ignored once the utterance has ended or been cancelled, so a model that is
   * still streaming into a cancelled Speaker is harmless.
   */
  append(text: string, options: { flush?: boolean } = {}): void {
    if (text === "") return;
    if (this.ended || this.cancelled || this.inputEnded) return;
    const socket = this.openSocket();
    if (!socket) return;

    // Without a trailing space the server runs the last word of one chunk into
    // the first word of the next.
    const payload = /\s$/.test(text) ? text : `${text} `;
    const flush = options.flush ?? this.sentText === "";
    this.sentText += payload;
    socket.send(JSON.stringify({ text: payload, flush }));
  }

  /** Makes the server generate whatever text it is still buffering. */
  flush(): void {
    if (this.ended || this.cancelled || this.inputEnded) return;
    // A space keeps the stream open; the empty string would end it.
    this.openSocket()?.send(JSON.stringify({ text: " ", flush: true }));
  }

  /**
   * Signals end of input and resolves once the server has finished speaking it.
   *
   * Resolves with `reason: "cancelled"` if {@link cancel} got there first, and
   * rejects with {@link SpeakerError} if the socket failed.
   */
  finish(): Promise<SpeechResult> {
    if (!this.started) throw new Error("call start() before finish()");
    if (this.ended) {
      if (this.cancelled) return Promise.resolve(this.result("cancelled"));
      return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.result("complete"));
    }

    if (!this.inputEnded) {
      this.inputEnded = true;
      // The one frame that means "no more text": an empty string, not a space.
      this.openSocket()?.send(JSON.stringify({ text: "" }));
      this.cancelFinishTimer = this.clock.setTimeout(() => {
        this.logger.warn(`[voice] no final frame ${FINISH_TIMEOUT_MS} ms after end of input`);
        this.socket?.terminate();
        this.settle();
      }, FINISH_TIMEOUT_MS);
    }

    return new Promise<SpeechResult>((resolve, reject) => {
      this.finishWaiters.push({ resolve, reject });
    });
  }

  /**
   * Stops speaking now.
   *
   * The socket is torn down rather than closed politely, and every frame still
   * in flight is dropped: nothing more reaches `onAudio`, so the only audio the
   * browser has to discard is what it has already buffered (V2-004).
   * {@link spokenSoFar} keeps whatever was played up to this point.
   */
  cancel(): void {
    if (this.ended) return;
    this.cancelled = true;
    this.logger.log(`[voice] cancelled after ${Math.round(this.audioMs)} ms of audio`);
    this.socket?.terminate();
    this.socket = undefined;
    this.settle();
  }

  /**
   * Records how far playback has got, in milliseconds of this utterance's
   * audio. The browser reports it (V2-004); monotonic, so a late report can't
   * un-speak anything.
   */
  notePlayedMs(positionMs: number): void {
    if (positionMs > this.playedMs) this.playedMs = positionMs;
  }

  /** Treats everything emitted so far as heard — what a clean end of playback means. */
  notePlayedAll(): void {
    this.notePlayedMs(Math.max(this.audioMs, this.alignedEndMs));
  }

  /**
   * The text whose audio had finished by the last reported playback position.
   *
   * A character counts as spoken once its sound is over, so this never claims a
   * word the room was still hearing the start of. With no playback reports it
   * is empty, which is the honest answer: audio having been generated is not
   * the same as anybody having heard it.
   */
  spokenSoFar(): string {
    let text = "";
    for (const entry of this.timeline) {
      if (entry.endMs > this.playedMs) break;
      text += entry.char;
    }
    return text.trim();
  }

  /** Full text the server reported timings for, whether played or not. */
  alignedText(): string {
    return this.timeline
      .map((entry) => entry.char)
      .join("")
      .trim();
  }

  private openSocket(): WebSocket | undefined {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.logger.warn("[voice] dropped a frame: the voice socket is not open");
      return undefined;
    }
    return socket;
  }

  /** One server frame. Audio and its alignment arrive together. */
  private receive(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (this.cancelled || this.ended) return;
    if (isBinary) {
      this.logger.warn("[voice] ignored a binary frame; this endpoint sends JSON");
      return;
    }

    const text = Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data as ArrayBuffer).toString("utf8");

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.logger.warn(`[voice] ignored an unparseable frame (${text.length} bytes)`);
      return;
    }

    // An error frame carries no audio, which is what tells it apart from a
    // normal one — `message` on its own is too common a field to act on.
    const failed =
      frame["audio"] === undefined &&
      (typeof frame["error"] === "string" || typeof frame["message"] === "string");
    if (failed) {
      const detail = String(frame["error"] ?? frame["message"]);
      this.fail(new SpeakerError(`voice stream reported an error: ${detail.slice(0, 200)}`));
      this.socket?.terminate();
      this.settle();
      return;
    }

    const audio = frame["audio"];
    if (typeof audio === "string" && audio !== "") {
      const chunk = Buffer.from(audio, "base64");
      const beforeMs = this.audioMs;
      this.audioBytes += chunk.length;
      if (this.firstAudioAtMs === undefined) this.firstAudioAtMs = this.clock.now();
      this.absorbAlignment(frame, beforeMs);
      this.onAudio?.(chunk);
    } else {
      this.absorbAlignment(frame, this.audioMs);
    }

    if (frame["isFinal"] === true) {
      this.sawFinal = true;
      this.settle();
    }
  }

  /**
   * Folds a frame's character timings into the utterance timeline.
   *
   * `/stream-input` has been observed to number `charStartTimesMs` from the
   * start of the whole stream, while its sibling dialogue endpoints restart at
   * zero on every frame. Rather than depend on which, the frame is treated as
   * chunk-relative exactly when it would otherwise run backwards into text
   * already spoken — in which case the offset is the audio that came before it.
   */
  private absorbAlignment(frame: Record<string, unknown>, audioMsBefore: number): void {
    const alignment = readAlignment(frame);
    if (!alignment || alignment.chars.length === 0) return;

    const first = alignment.startMs[0] ?? 0;
    const offset = first < this.alignedEndMs ? audioMsBefore : 0;
    for (let i = 0; i < alignment.chars.length; i += 1) {
      const endMs = offset + (alignment.startMs[i] ?? 0) + (alignment.durationMs[i] ?? 0);
      this.timeline.push({ char: alignment.chars[i] as string, endMs });
      this.alignedEndMs = Math.max(this.alignedEndMs, endMs);
    }
  }

  private closed(code: number, reason: string): void {
    this.socket = undefined;
    if (this.ended) return;
    if (!this.sawFinal && !this.cancelled && !this.failure && code !== 1000) {
      this.fail(
        new SpeakerError(
          `voice stream closed with ${code} (${reason || "no reason given"}) before it finished`,
          code,
          reason,
        ),
      );
    }
    this.settle();
  }

  private fail(error: SpeakerError): void {
    this.failure ??= error;
  }

  /** Ends the utterance once and answers everyone waiting on `finish()`. */
  private settle(): void {
    if (this.ended) return;
    this.ended = true;
    this.cancelFinishTimer?.();
    this.cancelFinishTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();

    const waiters = this.finishWaiters;
    this.finishWaiters = [];
    // A cancel is an outcome, not a failure, even if the torn-down socket also
    // reported one on its way out.
    if (this.failure && !this.cancelled) {
      for (const waiter of waiters) waiter.reject(this.failure);
      return;
    }
    const result = this.result(this.cancelled ? "cancelled" : "complete");
    for (const waiter of waiters) waiter.resolve(result);
  }

  private result(reason: SpeechEndReason): SpeechResult {
    return {
      reason,
      text: this.sentText.trim(),
      spokenSoFar: this.spokenSoFar(),
      audioBytes: this.audioBytes,
      audioMs: this.audioMs,
      firstAudioMs: this.firstAudioMs,
    };
  }
}
