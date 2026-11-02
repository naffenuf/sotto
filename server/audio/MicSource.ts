/**
 * The browser's microphone as an {@link AudioSource}.
 *
 * The conversion happens in the browser (`web/src/audio/`), so what arrives
 * over `/ws/audio` is already PCM16 mono 24 kHz; all this has to do is hand
 * it on in chunks of exactly {@link AUDIO_CHUNK_BYTES}, whatever sizes the
 * socket's messages happen to be.
 *
 * It outlives the socket in both directions: the session is started before
 * the browser dials `/ws/audio`, so early audio is buffered, and a socket
 * that *drops* — a refresh, a laptop going to sleep — opens a grace period
 * of {@link MIC_GRACE_MS} in which the page may dial again, rather than
 * ending the meeting. Only the page saying it is done ({@link MicHandle.end},
 * a clean close) or the grace running out ends the input.
 */
import { systemClock, type Clock } from "../clock.js";
import {
  AUDIO_CHUNK_BYTES,
  AUDIO_SAMPLE_RATE,
  type AudioEndReason,
  type AudioSink,
  type AudioSource,
} from "./AudioSource.js";

/**
 * How much audio may pile up before a sink is attached. One second is far
 * more than the round trip between `POST /api/session/start` and the socket
 * opening; past that something is wrong and dropping is better than growing.
 */
export const MIC_BUFFER_LIMIT_BYTES = AUDIO_SAMPLE_RATE * 2;

/**
 * How long a session waits for the page to come back after its audio socket
 * dropped. A refresh is seconds; a laptop waking is longer, since the page
 * has to notice its socket is gone first.
 */
export const MIC_GRACE_MS = 60_000;

/**
 * A holder that has sent nothing for this long is presumed gone — the page
 * sends an 80 ms frame continuously while it streams — so a newcomer may
 * take its place. A laptop that slept leaves the server a socket it will
 * not hear close for minutes, and the woken page dials a new one.
 */
export const MIC_STALE_MS = 2_000;

/** One socket's claim on the microphone. Everything is a no-op once replaced. */
export interface MicHandle {
  /** One binary message from the browser. Partial chunks are carried over. */
  write(bytes: Buffer): void;
  /** The socket dropped without the page meaning it to: hold the session open. */
  detach(): void;
  /** The page is done: pad the tail, complete the source, end the session. */
  end(): void;
  /** False once another socket has taken over or the input has ended. */
  readonly active: boolean;
}

export interface MicSourceOptions {
  clock?: Clock;
  graceMs?: number;
  staleMs?: number;
}

export class MicSource implements AudioSource {
  readonly sampleRate = AUDIO_SAMPLE_RATE;
  /** Whole chunks handed to the sink so far. */
  chunksSent = 0;
  /** Bytes dropped because they arrived faster than the sink could be given one. */
  droppedBytes = 0;
  /** Told when the socket drops into, and comes back from, the grace period. */
  onConnection: ((connected: boolean) => void) | undefined;

  private readonly clock: Clock;
  private readonly graceMs: number;
  private readonly staleMs: number;
  private sink: AudioSink | undefined;
  /** Bytes received but not yet a whole chunk — or not yet wanted. */
  private pending: Buffer = Buffer.alloc(0);
  private holder: Holder | undefined;
  /** Cancels the grace timer, while one is armed. */
  private grace: (() => void) | undefined;
  private inputEnded = false;
  private finished = false;

  constructor(options: MicSourceOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.graceMs = options.graceMs ?? MIC_GRACE_MS;
    this.staleMs = options.staleMs ?? MIC_STALE_MS;
  }

  start(sink: AudioSink): void {
    if (this.sink) throw new Error("MicSource is already running");
    this.sink = sink;
    this.emit();
  }

  stop(): void {
    this.finish("stopped");
  }

  /** True while a browser holds `/ws/audio`. */
  get connected(): boolean {
    return this.holder !== undefined;
  }

  /** True while the socket is gone and the session is waiting for it back. */
  get waiting(): boolean {
    return this.grace !== undefined;
  }

  /**
   * Claims the `/ws/audio` socket. `null` if another browser is streaming
   * into it right now, which the route answers by closing the newcomer rather
   * than letting two microphones interleave into one stream. A holder that
   * has gone quiet for {@link MIC_STALE_MS} is presumed dead and replaced:
   * `onReplaced` is how the route learns to close that socket.
   */
  attach(onReplaced?: () => void): MicHandle | null {
    if (this.finished || this.inputEnded) return null;
    const current = this.holder;
    if (current !== undefined) {
      if (this.clock.now() - current.lastWriteAt < this.staleMs) return null;
      this.holder = undefined;
      current.onReplaced?.();
    }
    const wasWaiting = this.grace !== undefined;
    this.grace?.();
    this.grace = undefined;
    const holder = new Holder(this, this.clock.now(), onReplaced);
    this.holder = holder;
    if (wasWaiting) this.onConnection?.(true);
    return holder;
  }

  /** @internal */
  holds(holder: Holder): boolean {
    return this.holder === holder;
  }

  /** @internal */
  writeFrom(holder: Holder, bytes: Buffer): void {
    if (this.holder !== holder || this.finished || this.inputEnded) return;
    holder.lastWriteAt = this.clock.now();
    if (this.sink === undefined && this.pending.length + bytes.length > MIC_BUFFER_LIMIT_BYTES) {
      this.droppedBytes += bytes.length;
      return;
    }
    this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
    this.emit();
  }

  /** @internal */
  detachFrom(holder: Holder): void {
    if (this.holder !== holder || this.finished || this.inputEnded) return;
    this.holder = undefined;
    this.grace = this.clock.setTimeout(() => {
      this.grace = undefined;
      this.endInput();
    }, this.graceMs);
    this.onConnection?.(false);
  }

  /** @internal */
  endFrom(holder: Holder): void {
    if (this.holder !== holder) return;
    this.endInput();
  }

  /**
   * The browser is done, or never came back. The tail is padded out to a
   * whole chunk and the source completes, which is what ends the session:
   * `endStream` goes out and the API flushes its last words.
   */
  endInput(): void {
    if (this.finished || this.inputEnded) return;
    this.inputEnded = true;
    this.holder = undefined;
    this.grace?.();
    this.grace = undefined;
    if (this.sink !== undefined && this.pending.length > 0) {
      const tail = Buffer.concat([
        this.pending,
        Buffer.alloc(AUDIO_CHUNK_BYTES - this.pending.length),
      ]);
      this.pending = Buffer.alloc(0);
      this.chunksSent += 1;
      this.sink.onChunk(tail);
    }
    this.finish("complete");
  }

  private emit(): void {
    const sink = this.sink;
    if (sink === undefined) return;
    while (this.pending.length >= AUDIO_CHUNK_BYTES) {
      const chunk = this.pending.subarray(0, AUDIO_CHUNK_BYTES);
      this.pending = this.pending.subarray(AUDIO_CHUNK_BYTES);
      this.chunksSent += 1;
      sink.onChunk(chunk);
      if (this.sink === undefined) return; // the sink called stop()
    }
  }

  private finish(reason: AudioEndReason): void {
    if (this.finished) return;
    this.finished = true;
    this.holder = undefined;
    this.grace?.();
    this.grace = undefined;
    const sink = this.sink;
    this.sink = undefined;
    this.pending = Buffer.alloc(0);
    sink?.onEnd(reason);
  }
}

class Holder implements MicHandle {
  constructor(
    private readonly mic: MicSource,
    public lastWriteAt: number,
    readonly onReplaced: (() => void) | undefined,
  ) {}

  get active(): boolean {
    return this.mic.holds(this);
  }

  write(bytes: Buffer): void {
    this.mic.writeFrom(this, bytes);
  }

  detach(): void {
    this.mic.detachFrom(this);
  }

  end(): void {
    this.mic.endFrom(this);
  }
}
