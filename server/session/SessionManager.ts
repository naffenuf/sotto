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
 *
 * On the way past, both the raw frames and the final turns are written to the
 * session folder (`SessionStore`, US-008), so every session leaves a record on
 * disk whether or not a browser was watching.
 */
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { StatusState } from "../../shared/events.js";
import type { SessionInfo, SessionSource } from "../../shared/session.js";
import { describeSource, sourceSlug } from "../../shared/session.js";
import {
  EventReplaySource,
  fixtureEventsPath,
  type ReplaySpeed,
} from "../asr/EventReplaySource.js";
import { RealtimeTranscriptionClient } from "../asr/realtimeClient.js";
import { TurnAssembler } from "../asr/turns.js";
import type { AudioSource } from "../audio/AudioSource.js";
import { WavReplaySource } from "../audio/WavReplaySource.js";
import { SimulatedClock, systemClock, type Clock } from "../clock.js";
import type { EventBus } from "../events/bus.js";
import { SessionStore, type SessionWriter } from "./SessionStore.js";

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

/**
 * Opens the session folder a session writes to (US-008), or returns `null` to
 * run without one — which is what the unit tests do, so `npm test` never
 * leaves folders behind.
 */
export type SessionStoreFactory = (info: SessionInfo) => SessionWriter | null;

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
  /** Makes the session folder. Defaults to one under `sessions/`. */
  createStore?: SessionStoreFactory;
  /** Clock for live sessions; a replay brings its own simulated one. */
  liveClock?: Clock;
  /** Real time that a `1x` replay paces itself against. */
  wallClock?: Clock;
  /** Replay speed for `events` sources. `1x` for the UI, `max` for tests. */
  replaySpeed?: ReplaySpeed;
}

/**
 * Holds the session folder for the pipeline closures that write to it.
 *
 * It is a box rather than a plain value because the folder is only opened
 * once the source has been accepted — a start that answers 400 or 501 must
 * not leave an empty folder behind — while the closures that write to it are
 * built during that acceptance. Nothing writes before `start()` returns.
 */
interface StoreSlot {
  writer: SessionWriter | null;
}

interface RunningSession {
  info: SessionInfo;
  assembler: TurnAssembler;
  store: StoreSlot;
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
  private readonly createStore: SessionStoreFactory;
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
    this.createStore =
      options.createStore ?? ((info) => SessionStore.create(info, { logger: this.logger }));
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

    const store: StoreSlot = { writer: null };
    const running =
      source.kind === "events"
        ? this.startReplay(info, source.fixture, store)
        : this.startLive(info, source, store);
    store.writer = this.openStore(info);

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
  private startReplay(info: SessionInfo, fixture: string, store: StoreSlot): RunningSession {
    // Replay sets this clock to each frame's recorded arrival time, so the
    // whole pipeline reads the conversation's own timeline (US-006).
    const clock = new SimulatedClock(0);
    const assembler = this.assembler(clock, store);
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
      store,
      transcription: ["active", `replaying ${fixture} events at ${this.replaySpeed}`],
      stop: () => source.stop(),
      // Not `assemblerSink`: a saved session records every raw frame first,
      // so `events.jsonl` is a capture of the stream the assembler saw.
      done: source.run({
        onFrame: (record) => {
          store.writer?.appendEvent(record);
          assembler.accept(record);
        },
        onEnd: () => {},
      }),
      stopRequested: false,
    };
  }

  /** `wav` and `mic` share this path: audio in, realtime transcription out. */
  private startLive(
    info: SessionInfo,
    source: Extract<SessionSource, { kind: "wav" | "mic" }>,
    store: StoreSlot,
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

    const assembler = this.assembler(this.liveClock, store);
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
        store.writer?.appendEvent(record);
        assembler.accept(record);
      },
      logger: this.logger,
    });

    return {
      info,
      assembler,
      store,
      transcription: ["connecting", "opening transcription session"],
      stop: () => client.stop(),
      done: client.run(audio),
      stopRequested: false,
    };
  }

  private assembler(clock: Clock, store: StoreSlot): TurnAssembler {
    return new TurnAssembler({
      clock,
      // Frame times are measured from the start of the stream on both paths —
      // the realtime client subtracts its own start, a replay sets the clock
      // to the capture's `atMs` — so the assembler's timeline begins at 0.
      startedAtMs: 0,
      logger: this.logger,
      onUpdate: (turn) => {
        this.bus.publish({ type: "turn", turn });
        // Partials are dropped by the store; only final turns are saved.
        store.writer?.appendTurn(turn);
      },
    });
  }

  /**
   * Opens the session folder. A folder that cannot be made is a warning, not
   * a failed session: losing the recording is better than losing the
   * conversation.
   */
  private openStore(info: SessionInfo): SessionWriter | null {
    try {
      return this.createStore(info);
    } catch (error) {
      this.logger.warn(`[session] ${info.id} is not being saved: ${message(error)}`);
      return null;
    }
  }

  /**
   * Gives one diarization label a display name for the running session, and
   * `null` to go back to the bare label. False if no session is running.
   *
   * The name goes two places: the bus, which is what the transcript panel
   * (US-007) reads and what catches a reloaded browser up, and the session
   * folder, which rewrites `transcript.md` with it. A session whose folder
   * could not be opened still renames — the panel must not depend on the disk.
   */
  renameSpeaker(label: string, name: string | null): boolean {
    const running = this.current;
    if (running === undefined) return false;
    this.bus.setSpeakerName(label, name);
    running.store.writer?.renameSpeaker(label, name);
    this.logger.log(
      `[session] ${running.info.id} speaker ${label} is now ${name === null || name.trim() === "" ? "unnamed" : name.trim()}`,
    );
    return true;
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
    // Whether it ended, was stopped or failed, the folder gets its `endedAt`.
    running.store.writer?.end();

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
