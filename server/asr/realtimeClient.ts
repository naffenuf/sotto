/**
 * Client for Meta's realtime transcription socket
 * (https://dev.meta.ai/docs/api-reference/voice/realtime).
 *
 * It takes an {@link AudioSource}, streams its chunks to the API, and hands
 * every frame the server sends back to `onFrame` with the time it arrived.
 * `npm run capture` writes those frames to `fixtures/events/`; the live
 * pipeline feeds them to the turn assembler instead.
 */
import { WebSocket } from "ws";
import type { AsrFrameRecord, AsrMode } from "../../shared/asr.js";
import type { AudioEndReason, AudioSink, AudioSource } from "../audio/AudioSource.js";
import { systemClock, type Clock } from "../clock.js";

export const REALTIME_URL = "wss://api.meta.ai/v1/asr/realtime";
export const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";
/** Matches {@link AUDIO_SAMPLE_RATE}: signed 16-bit little-endian mono PCM. */
export const AUDIO_ENCODING = "PCM_24KHZ";
/** Biases recognition towards the wake word. Spellings still vary — see fixtures/events/NOTES.md. */
export const WAKE_KEYWORDS = ["Sotto"];

/**
 * The handshake has to be the first frame and arrive within 10 s of
 * connecting; we send it on `open`, so the only risk is a connect that hangs.
 */
export const CONNECT_TIMEOUT_MS = 10_000;
/** How long to wait for the server to flush results and close after `endStream`. */
export const FLUSH_TIMEOUT_MS = 20_000;
/** Backoff before each retry of a retriable close. Its length is the retry budget. */
export const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000];

/** Close codes the API uses (see the docs table). */
export const CLOSE_NORMAL = 1000;
/** Bad configuration or audio pacing. Retrying would fail the same way. */
export const CLOSE_POLICY = 1008;
/** Backend failure, and also how the 60-minute session limit arrives. */
export const CLOSE_INTERNAL = 1011;
/** Too many streams. */
export const CLOSE_RATE_LIMITED = 1013;

/** Reason text the API sends when a session reaches the 60-minute limit. */
export const MAX_SESSION_DURATION_REASON = "Max session duration reached";

function isRetriable(code: number): boolean {
  return code === CLOSE_INTERNAL || code === CLOSE_RATE_LIMITED;
}

/**
 * Whether a close is the 60-minute session limit rather than a failure.
 *
 * It arrives as a 1011 like any backend error does, and the only thing that
 * tells them apart is the reason text, so match it loosely: any casing, and
 * trailing detail allowed.
 */
export function isMaxSessionDuration(code: number, reason: string): boolean {
  return (
    code === CLOSE_INTERNAL &&
    reason.toLowerCase().includes(MAX_SESSION_DURATION_REASON.toLowerCase())
  );
}

export class RealtimeTranscriptionError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly reason: string,
  ) {
    super(message);
    this.name = "RealtimeTranscriptionError";
  }
}

type Logger = Pick<Console, "log" | "warn" | "error">;

export interface RealtimeClientOptions {
  /** Meta Model API key. Travels in the handshake frame, never in a header or a log line. */
  apiKey: string;
  /** Override for tests pointing at a local WebSocket server. */
  url?: string;
  model?: string;
  mode?: AsrMode;
  keywords?: string[];
  clock?: Clock;
  /** Called for every server frame, in arrival order, across reconnects. */
  onFrame?: (record: AsrFrameRecord) => void;
  logger?: Logger;
}

export interface RealtimeRunResult {
  /** `sessionId` from each handshake acknowledgement, in order. */
  sessionIds: string[];
  /** Server frames received across every session. */
  frameCount: number;
  /** How many ASR sessions the run needed; more than one means it reconnected. */
  sessionCount: number;
  /** Milliseconds from the first audio chunk to the final close. */
  durationMs: number;
}

interface SessionOutcome {
  code: number;
  reason: string;
}

/**
 * One run of one audio source through the API. The client is the
 * {@link AudioSink}: chunks queue as they arrive and go out as soon as a
 * socket is open, so a reconnect during backoff doesn't drop audio.
 */
export class RealtimeTranscriptionClient implements AudioSink {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly model: string;
  private readonly mode: AsrMode;
  private readonly keywords: string[];
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly onFrame: ((record: AsrFrameRecord) => void) | undefined;

  private readonly queue: Buffer[] = [];
  private readonly sessionIds: string[] = [];
  private socket: WebSocket | undefined;
  private source: AudioSource | undefined;
  private session = 0;
  private frameCount = 0;
  private streamStartedAt = 0;
  private inputEnded = false;
  private used = false;
  private endStreamSent = false;
  private cancelFlushTimer: (() => void) | undefined;

  constructor(options: RealtimeClientOptions) {
    this.apiKey = options.apiKey;
    this.url = options.url ?? REALTIME_URL;
    this.model = options.model ?? TRANSCRIBE_MODEL;
    this.mode = options.mode ?? "DIARIZATION";
    this.keywords = options.keywords ?? WAKE_KEYWORDS;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? console;
    this.onFrame = options.onFrame;
  }

  /**
   * Streams `source` through a transcription session and resolves once the
   * server has closed normally.
   *
   * @throws {RealtimeTranscriptionError} on a close the client can't recover
   * from: 1008 (configuration or pacing) or a retriable close that outlived
   * the retry budget.
   */
  async run(source: AudioSource): Promise<RealtimeRunResult> {
    if (this.used) throw new Error("RealtimeTranscriptionClient is single-use; make a new one");
    this.used = true;
    this.source = source;
    this.streamStartedAt = this.clock.now();

    try {
      // Retries are counted separately from sessions: hitting the 60-minute
      // limit is a normal part of a long conversation, not a failure, so it
      // opens the next session without spending any of the error budget.
      for (let retry = 0; ; ) {
        const outcome = await this.runSession(this.session === 0);
        if (outcome.code === CLOSE_NORMAL) break;

        if (isMaxSessionDuration(outcome.code, outcome.reason)) {
          this.logger.log(
            `[asr] session ${this.session} reached the 60-minute limit; ` +
              `continuing in session ${this.session + 1}`,
          );
          this.session += 1;
          // Reaching the limit means the stream was healthy right up to it.
          retry = 0;
          continue;
        }

        if (outcome.code === CLOSE_POLICY) {
          this.logger.error(
            `[asr] fatal config/pacing error (1008): ${outcome.reason || "no reason given"} — ` +
              "check the handshake fields and that audio is sent at real-time pace.",
          );
          throw new RealtimeTranscriptionError(
            `transcription rejected the stream: ${outcome.reason || "close 1008"}`,
            outcome.code,
            outcome.reason,
          );
        }

        const retriable = isRetriable(outcome.code);
        const backoffMs = retriable ? RETRY_BACKOFF_MS[retry] : undefined;
        if (backoffMs === undefined) {
          const why = retriable
            ? `gave up after ${RETRY_BACKOFF_MS.length} retries`
            : "close code is not retriable";
          throw new RealtimeTranscriptionError(
            `transcription closed with ${outcome.code} ` +
              `(${outcome.reason || "no reason given"}); ${why}`,
            outcome.code,
            outcome.reason,
          );
        }
        this.logger.warn(
          `[asr] session ${this.session} closed with ${outcome.code} ` +
            `(${outcome.reason || "no reason given"}); retrying in ${backoffMs} ms`,
        );
        await this.sleep(backoffMs);
        retry += 1;
        this.session += 1;
      }
    } finally {
      this.source = undefined;
      source.stop();
      this.cancelFlushTimer?.();
      this.cancelFlushTimer = undefined;
    }

    return {
      sessionIds: [...this.sessionIds],
      frameCount: this.frameCount,
      sessionCount: this.session + 1,
      durationMs: this.clock.now() - this.streamStartedAt,
    };
  }

  /** Ends input early: the source stops, `endStream` goes out, results still flush. */
  stop(): void {
    this.source?.stop();
  }

  onChunk(chunk: Buffer): void {
    this.queue.push(chunk);
    this.flush();
  }

  onEnd(reason: AudioEndReason): void {
    this.inputEnded = true;
    this.logger.log(`[asr] input ended (${reason})`);
    this.flush();
  }

  /** Opens one session and resolves with the close that ended it. */
  private runSession(startSource: boolean): Promise<SessionOutcome> {
    const session = this.session;
    const socket = new WebSocket(this.url);
    socket.binaryType = "nodebuffer";
    this.endStreamSent = false;

    return new Promise<SessionOutcome>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: SessionOutcome) => {
        if (settled) return;
        settled = true;
        cancelConnectTimer();
        this.cancelFlushTimer?.();
        this.cancelFlushTimer = undefined;
        this.socket = undefined;
        resolve(outcome);
      };

      const cancelConnectTimer = this.clock.setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) return;
        this.logger.error(`[asr] no connection after ${CONNECT_TIMEOUT_MS} ms`);
        socket.terminate();
      }, CONNECT_TIMEOUT_MS);

      socket.on("open", () => {
        cancelConnectTimer();
        // The credential goes in this frame, not in an HTTP header, and this
        // frame must be the first thing the server sees.
        socket.send(
          JSON.stringify({
            authorization: { accessToken: `Bearer ${this.apiKey}` },
            audioEncoding: AUDIO_ENCODING,
            model: this.model,
            mode: this.mode,
            keywords: this.keywords,
          }),
        );
        this.socket = socket;
        this.logger.log(`[asr] session ${session} open (${this.mode}, ${this.model})`);
        if (startSource) {
          this.streamStartedAt = this.clock.now();
          this.source?.start(this);
        }
        this.flush();
      });

      socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        this.record(session, data, isBinary);
      });

      socket.on("error", (error: Error) => {
        // ws always follows an error with a close, which is what we act on.
        this.logger.warn(`[asr] socket error: ${error.message}`);
      });

      socket.on("close", (code: number, reason: Buffer) => {
        finish({ code, reason: reason.toString("utf8") });
      });

      socket.on("unexpected-response", (_req, res) => {
        reject(
          new RealtimeTranscriptionError(
            `transcription handshake was refused with HTTP ${res.statusCode}`,
            res.statusCode ?? 0,
            res.statusMessage ?? "",
          ),
        );
      });
    });
  }

  /** Sends whatever is queued, then `endStream` once the source is done. */
  private flush(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (this.queue.length > 0) socket.send(this.queue.shift() as Buffer);
    if (this.inputEnded && !this.endStreamSent) {
      this.endStreamSent = true;
      socket.send(JSON.stringify({ type: "endStream" }));
      this.logger.log("[asr] endStream sent; waiting for the server to flush and close");
      // The socket stays open so the server can flush pending results, but it
      // should not stay open forever.
      this.cancelFlushTimer = this.clock.setTimeout(() => {
        this.logger.warn(`[asr] no close ${FLUSH_TIMEOUT_MS} ms after endStream; closing`);
        socket.close(CLOSE_NORMAL, "client flush timeout");
      }, FLUSH_TIMEOUT_MS);
    }
  }

  private record(session: number, data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    const atMs = this.clock.now() - this.streamStartedAt;
    const text = isBinary ? "" : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    let frame: Record<string, unknown>;
    if (isBinary) {
      frame = { raw: "<binary frame>" };
    } else {
      try {
        const parsed: unknown = JSON.parse(text);
        frame =
          typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { raw: text };
      } catch {
        frame = { raw: text };
      }
    }

    this.frameCount += 1;
    // The handshake acknowledgement is the one frame with no `type`.
    const sessionId = frame["sessionId"];
    if (frame["type"] === undefined && typeof sessionId === "string") {
      this.sessionIds.push(sessionId);
    }
    this.onFrame?.({ atMs, session, frame });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimeout(resolve, ms);
    });
  }
}
