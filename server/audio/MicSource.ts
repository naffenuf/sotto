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
 * that drops ends the input (`"complete"`) rather than the process.
 */
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

export class MicSource implements AudioSource {
  readonly sampleRate = AUDIO_SAMPLE_RATE;
  /** Whole chunks handed to the sink so far. */
  chunksSent = 0;
  /** Bytes dropped because they arrived faster than the sink could be given one. */
  droppedBytes = 0;

  private sink: AudioSink | undefined;
  /** Bytes received but not yet a whole chunk — or not yet wanted. */
  private pending: Buffer = Buffer.alloc(0);
  private attached = false;
  private inputEnded = false;
  private finished = false;

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
    return this.attached;
  }

  /**
   * Claims the one `/ws/audio` socket. False if another browser already has
   * it, which the route answers by closing the newcomer rather than letting
   * two microphones interleave into one stream.
   */
  attach(): boolean {
    if (this.attached || this.finished || this.inputEnded) return false;
    this.attached = true;
    return true;
  }

  /** One binary message from the browser. Partial chunks are carried over. */
  write(bytes: Buffer): void {
    if (this.finished || this.inputEnded) return;
    if (this.sink === undefined && this.pending.length + bytes.length > MIC_BUFFER_LIMIT_BYTES) {
      this.droppedBytes += bytes.length;
      return;
    }
    this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
    this.emit();
  }

  /**
   * The browser is done — it stopped, or its socket dropped. The tail is
   * padded out to a whole chunk and the source completes, which is what ends
   * the session: `endStream` goes out and the API flushes its last words.
   */
  endInput(): void {
    if (this.finished || this.inputEnded) return;
    this.inputEnded = true;
    this.attached = false;
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
    this.attached = false;
    const sink = this.sink;
    this.sink = undefined;
    this.pending = Buffer.alloc(0);
    sink?.onEnd(reason);
  }
}
