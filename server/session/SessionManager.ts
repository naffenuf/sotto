/**
 * Owns the one running session, and wires it up:
 *
 *     WAV fixture  -> realtime transcription client -\
 *     microphone   -> realtime transcription client --> turn assembler -> bus
 *     capture (1x) ------------------------------------/
 *
 * Only the left-hand column differs between sources. Everything downstream —
 * the turn assembler (US-005), and the board, observer and answers that later
 * stories hang off the bus — sees the same frames and reads time from the same
 * injected clock, so a replay behaves exactly like a live session.
 */
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { StatusState } from "../../shared/events.js";
import type { SessionInfo, SessionSource } from "../../shared/session.js";
import { describeSource, sourceSlug } from "../../shared/session.js";
import {
  EventReplaySource,
  assemblerSink,
  fixtureEventsPath,
  type ReplaySpeed,
} from "../asr/EventReplaySource.js";
import { RealtimeTranscriptionClient } from "../asr/realtimeClient.js";
import { TurnAssembler } from "../asr/turns.js";
import type { AudioSource } from "../audio/AudioSource.js";
import { WavReplaySource } from "../audio/WavReplaySource.js";
import { SimulatedClock, systemClock, type Clock } from "../clock.js";
import type { EventBus } from "../events/bus.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

/**
 * How long `stop()` waits for the transcription socket to flush and close
 * before answering anyway. The session keeps draining in the background; this
 * only stops an HTTP request from hanging on it.
 */
export const STOP_DRAIN_MS = 5_000;

/** The part of {@link RealtimeTranscriptionClient} a session needs. */
export interface AsrClient {
  run(source: AudioSource): Promise<unknown>;
  stop(): void;
}

export interface AsrClientOptions {
  apiKey: string;
  clock: Clock;
  onFrame: (record: AsrFrameRecord) => void;
  logger: Logger;
}

/** Seam for tests: a fake client keeps `npm test` off the network. */
export type AsrClientFactory = (options: AsrClientOptions) => AsrClient;

/** A start that can't happen, with the HTTP status the route should answer. */
export class SessionStartError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SessionStartError";
  }
}

export interface SessionManagerOptions {
  bus: EventBus;
  /** Meta Model API key. Absent only where no live session will be started. */
  apiKey?: string | undefined;
  logger?: Logger;
  createAsrClient?: AsrClientFactory;
  /** Clock for live sessions; a replay brings its own simulated one. */
  liveClock?: Clock;
  /** Real time that a `1x` replay paces itself against. */
  wallClock?: Clock;
  /** Replay speed for `events` sources. `1x` for the UI, `max` for tests. */
  replaySpeed?: ReplaySpeed;
}

interface RunningSession {
  info: SessionInfo;
  assembler: TurnAssembler;
  /** What the transcription dot shows once the session is published. */
  transcription: [state: StatusState, detail: string];
  /** Ends input: `endStream` for a live session, no more frames for a replay. */
  stop(): void;
  /** Resolves when the session has fully drained; rejects if it failed. */
  done: Promise<unknown>;
  /** True once {@link SessionManager.stop} asked for it, so late errors are noise. */
  stopRequested: boolean;
}

export class SessionManager {
  private readonly bus: EventBus;
  private readonly apiKey: string | undefined;
  private readonly logger: Logger;
  private readonly createAsrClient: AsrClientFactory;
  private readonly liveClock: Clock;
  private readonly wallClock: Clock;
  private readonly replaySpeed: ReplaySpeed;

  private current: RunningSession | undefined;
  private started = 0;

  constructor(options: SessionManagerOptions) {
    this.bus = options.bus;
    this.apiKey = options.apiKey;
    this.logger = options.logger ?? console;
    this.createAsrClient =
      options.createAsrClient ??
      ((clientOptions) => new RealtimeTranscriptionClient(clientOptions));
    this.liveClock = options.liveClock ?? systemClock;
    this.wallClock = options.wallClock ?? systemClock;
    this.replaySpeed = options.replaySpeed ?? "1x";
  }

  /** The session that is running, or `null`. */
  state(): SessionInfo | null {
    return this.current?.info ?? null;
  }

  /**
   * Starts a session and returns it, having already published its `session`
   * and status events.
   *
   * @throws {SessionStartError} when one is already running, the fixture is
   * missing or unusable, or the source needs something the server hasn't got.
   */
  start(source: SessionSource): SessionInfo {
    if (this.current !== undefined) {
      throw new SessionStartError(
        `a session is already running (${describeSource(this.current.info.source)}); stop it first`,
        409,
      );
    }

    this.started += 1;
    const info: SessionInfo = {
      id: `${sourceSlug(source)}-${this.started}`,
      source,
      startedAtMs: source.kind === "events" ? 0 : this.liveClock.now(),
    };

    const running =
      source.kind === "events"
        ? this.startReplay(info, source.fixture)
        : this.startLive(info, source);

    this.current = running;
    // The session goes out before its statuses, so a listener always knows
    // which session a dot is talking about.
    this.bus.setSession(info);
    this.bus.setStatus("transcription", ...running.transcription);
    this.bus.setStatus("model", ...this.modelStatus());
    this.watch(running);
    this.logger.log(`[session] ${info.id} started (${describeSource(source)})`);
    return info;
  }

  /**
   * Ends the running session: input stops, `endStream` goes out, sockets
   * close. Resolves once it has drained or {@link STOP_DRAIN_MS} has passed,
   * whichever comes first. Returns false if nothing was running.
   */
  async stop(): Promise<boolean> {
    const running = this.current;
    if (running === undefined) return false;
    running.stopRequested = true;
    this.current = undefined;
    this.logger.log(`[session] ${running.info.id} stopping`);
    running.stop();
    // The UI asked for idle, so say idle now; the drain below is cleanup.
    this.bus.setStatus("transcription", "idle");
    this.bus.setStatus("model", "idle");
    this.bus.setSession(null);
    await this.drain(running);
    return true;
  }

  /** A replay needs no API key and no socket: frames come off disk. */
  private startReplay(info: SessionInfo, fixture: string): RunningSession {
    // Replay sets this clock to each frame's recorded arrival time, so the
    // whole pipeline reads the conversation's own timeline (US-006).
    const clock = new SimulatedClock(0);
    const assembler = this.assembler(clock, 0);
    let source: EventReplaySource;
    try {
      source = EventReplaySource.forFixture(fixture, {
        clock,
        speed: this.replaySpeed,
        wallClock: this.wallClock,
      });
    } catch (error) {
      throw new SessionStartError(
        `cannot replay events fixture "${fixture}" (${fixtureEventsPath(fixture)}): ${message(error)}`,
        400,
      );
    }

    return {
      info,
      assembler,
      transcription: ["active", `replaying ${fixture} events at ${this.replaySpeed}`],
      stop: () => source.stop(),
      done: source.run(assemblerSink(assembler)),
      stopRequested: false,
    };
  }

  /** `wav` and `mic` share this path: audio in, realtime transcription out. */
  private startLive(
    info: SessionInfo,
    source: Extract<SessionSource, { kind: "wav" | "mic" }>,
  ): RunningSession {
    if (source.kind === "mic") {
      throw new SessionStartError(
        "microphone capture is not wired up yet (US-012); pick a fixture for now",
        501,
      );
    }
    const apiKey = this.apiKey;
    if (apiKey === undefined || apiKey === "") {
      throw new SessionStartError(
        "live transcription needs MODEL_API_KEY in .env; replay an events fixture instead",
        503,
      );
    }

    let audio: AudioSource;
    try {
      audio = WavReplaySource.forFixture(source.fixture, this.liveClock);
    } catch (error) {
      throw new SessionStartError(
        `cannot replay WAV fixture "${source.fixture}": ${message(error)}`,
        400,
      );
    }

    const assembler = this.assembler(this.liveClock, this.liveClock.now());
    const client = this.createAsrClient({
      apiKey,
      clock: this.liveClock,
      onFrame: (record) => {
        // The first frame back is the proof the session is really up.
        this.bus.setStatus(
          "transcription",
          "active",
          `transcribing ${describeSource(info.source)}`,
        );
        assembler.accept(record);
      },
      logger: this.logger,
    });

    return {
      info,
      assembler,
      transcription: ["connecting", "opening transcription session"],
      stop: () => client.stop(),
      done: client.run(audio),
      stopRequested: false,
    };
  }

  private assembler(clock: Clock, startedAtMs: number): TurnAssembler {
    return new TurnAssembler({
      clock,
      startedAtMs,
      logger: this.logger,
      onUpdate: (turn) => this.bus.publish({ type: "turn", turn }),
    });
  }

  /** Whether the model dot can claim to be ready. */
  private modelStatus(): [state: "active" | "error", detail: string] {
    return this.apiKey === undefined || this.apiKey === ""
      ? ["error", "MODEL_API_KEY is missing"]
      : ["active", "model client ready"];
  }

  /** Watches a session's own completion, whether or not anyone stops it. */
  private watch(running: RunningSession): void {
    void running.done.then(
      () => this.finish(running),
      (error: unknown) => this.finish(running, error),
    );
  }

  private finish(running: RunningSession, error?: unknown): void {
    const wasCurrent = this.current === running;
    if (wasCurrent) this.current = undefined;

    if (error !== undefined && !running.stopRequested) {
      this.logger.error(`[session] ${running.info.id} failed: ${message(error)}`);
      this.bus.setStatus("transcription", "error", message(error));
    } else if (wasCurrent) {
      this.logger.log(`[session] ${running.info.id} ended`);
      this.bus.setStatus("transcription", "idle");
    }

    if (wasCurrent) {
      this.bus.setStatus("model", "idle");
      this.bus.setSession(null);
    }
  }

  /** Waits for a stopped session to finish draining, but not forever. */
  private async drain(running: RunningSession): Promise<void> {
    let cancelTimer: (() => void) | undefined;
    try {
      await Promise.race([
        running.done.catch(() => undefined),
        new Promise<void>((resolve) => {
          cancelTimer = this.liveClock.setTimeout(() => {
            this.logger.warn(
              `[session] ${running.info.id} still draining after ${STOP_DRAIN_MS} ms; carrying on`,
            );
            resolve();
          }, STOP_DRAIN_MS);
        }),
      ]);
    } finally {
      // Leaving it armed would keep the process awake for five seconds.
      cancelTimer?.();
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
