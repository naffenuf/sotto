/**
 * Replays a captured transcription stream instead of calling the API.
 *
 * A `fixtures/events/<name>.jsonl` capture (US-004) holds every frame the
 * realtime server sent and the millisecond it arrived, so feeding those
 * records back to the turn assembler reproduces a conversation exactly — for
 * free, and in milliseconds rather than minutes. The eval harness (US-016)
 * and every pipeline test run this way; only `npm run capture` and
 * `npm run e2e` talk to the real socket.
 *
 * Two speeds, one timeline:
 *
 *   - `1x` spends real time between frames, for watching the UI fill up.
 *   - `max` spends none, for tests and tuning.
 *
 * Either way the pipeline's clock is *set* to each frame's recorded arrival
 * time, so the turns, pauses and board timestamps come out identical at both
 * speeds. What `max` skips is idle wall-clock time, never simulated time —
 * and it never skips over work: {@link ControllableClock.settle} holds the
 * replay at the current moment until everything the last frame set off (a
 * board update, an observer call) has finished.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAsrFrameRecords, type AsrFrameRecord } from "../../shared/asr.js";
import { systemClock, type Clock, type ControllableClock } from "../clock.js";
import type { TurnAssembler } from "./turns.js";

/** Where `npm run capture` writes the frames it recorded. */
export const FIXTURE_EVENTS_DIR = fileURLToPath(new URL("../../fixtures/events/", import.meta.url));

/** Path to a fixture's capture, by fixture name (e.g. `"brainstorm"`). */
export function fixtureEventsPath(name: string): string {
  return join(FIXTURE_EVENTS_DIR, `${name}.jsonl`);
}

/** `1x` for UI demos, `max` for tests and the eval harness. */
export type ReplaySpeed = "1x" | "max";

export const replaySpeeds: readonly ReplaySpeed[] = ["1x", "max"];

/** Why a replay stopped, matching the audio sources' end reasons. */
export type ReplayEndReason = "complete" | "stopped";

/** Receives recorded frames, in the order they were recorded. */
export interface AsrFrameSink {
  /** One frame, as {@link RealtimeTranscriptionClient}'s `onFrame` would hand it over. */
  onFrame(record: AsrFrameRecord): void;
  /** Called exactly once, after the last frame. No frames arrive afterwards. */
  onEnd(reason: ReplayEndReason): void;
}

export interface EventReplayOptions {
  /**
   * The pipeline's clock. Replay sets it to each frame's recorded arrival
   * time, so it has to be one whose time can be set.
   */
  clock: ControllableClock;
  speed?: ReplaySpeed;
  /**
   * Real time, which `1x` paces itself against. Defaults to
   * {@link systemClock}; a test passes something instant instead.
   */
  wallClock?: Clock;
}

/**
 * Pours a replay straight into the turn assembler, which is what every
 * pipeline caller wants. `onEnd` is where a session closes itself out.
 */
export function assemblerSink(
  assembler: TurnAssembler,
  onEnd?: (reason: ReplayEndReason) => void,
): AsrFrameSink {
  return {
    onFrame: (record) => {
      assembler.accept(record);
    },
    onEnd: (reason) => onEnd?.(reason),
  };
}

export class EventReplaySource {
  /** Frames this replay will deliver, in recorded order. */
  readonly frameCount: number;
  readonly speed: ReplaySpeed;

  private readonly records: readonly AsrFrameRecord[];
  private readonly clock: ControllableClock;
  private readonly wallClock: Clock;
  private running = false;
  private stopped = false;
  private cancelPace: (() => void) | undefined;
  /** How many frames have been handed to the sink. */
  private sent = 0;

  constructor(records: readonly AsrFrameRecord[], options: EventReplayOptions) {
    this.records = records;
    this.frameCount = records.length;
    this.clock = options.clock;
    this.speed = options.speed ?? "max";
    this.wallClock = options.wallClock ?? systemClock;
  }

  /** Replays `fixtures/events/<name>.jsonl`. */
  static forFixture(name: string, options: EventReplayOptions): EventReplaySource {
    return new EventReplaySource(
      parseAsrFrameRecords(readFileSync(fixtureEventsPath(name), "utf8")),
      options,
    );
  }

  /** How many frames have been delivered so far. */
  get sentFrames(): number {
    return this.sent;
  }

  /**
   * Runs the whole capture through `sink`, resolving once the sink's `onEnd`
   * has been called. At `max` a two-minute capture takes milliseconds; at `1x`
   * it takes two minutes, so callers that aren't waiting for it should drop
   * the promise and use {@link stop}.
   */
  async run(sink: AsrFrameSink): Promise<void> {
    if (this.running) throw new Error("EventReplaySource is already running");
    this.running = true;
    this.sent = 0;
    const startedAt = this.wallClock.now();
    for (const record of this.records) {
      // Whatever the last frame set off happens *at the last frame's time*;
      // only once it has finished may the clock move on.
      await this.clock.settle();
      if (this.stopped) return this.finish(sink, "stopped");
      await this.paceTo(startedAt, record.atMs);
      if (this.stopped) return this.finish(sink, "stopped");
      // Captures are written in arrival order, so this only ever moves
      // forward; frames sharing a millisecond leave it where it is.
      if (record.atMs > this.clock.now()) this.clock.advanceTo(record.atMs);
      this.sent += 1;
      sink.onFrame(record);
    }
    await this.clock.settle();
    this.finish(sink, this.stopped ? "stopped" : "complete");
  }

  /**
   * Ends the replay early. Idempotent, and safe to call from inside
   * `onFrame`: the run stops before the next frame.
   */
  stop(): void {
    this.stopped = true;
    this.cancelPace?.();
    this.cancelPace = undefined;
  }

  /**
   * Spends real time until the capture is `atMs` old, and none at `max`.
   *
   * The wait is measured from the start of the run rather than from the
   * previous frame, the same way {@link WavReplaySource} paces chunks, so a
   * late timer doesn't push the rest of the conversation back.
   */
  private async paceTo(startedAt: number, atMs: number): Promise<void> {
    if (this.speed === "max") return;
    const delay = atMs - (this.wallClock.now() - startedAt);
    if (delay <= 0) return;
    await new Promise<void>((resolve) => {
      this.cancelPace = this.wallClock.setTimeout(() => {
        this.cancelPace = undefined;
        resolve();
      }, delay);
      // stop() landed between the check above and the timer being armed.
      if (this.stopped) {
        this.cancelPace?.();
        this.cancelPace = undefined;
        resolve();
      }
    });
  }

  private finish(sink: AsrFrameSink, reason: ReplayEndReason): void {
    this.running = false;
    this.cancelPace?.();
    this.cancelPace = undefined;
    sink.onEnd(reason);
  }
}
