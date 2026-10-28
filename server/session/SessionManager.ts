/**
 * Owns the one running session, and wires it up:
 *
 *     WAV fixture  -> realtime transcription client -\
 *     microphone   -> realtime transcription client --> turn assembler -> bus
 *     capture (1x) ------------------------------------/        |
 *                                                              v
 *                                                        board updater -> bus
 *                                                              |
 *                                                              v
 *                                                     observer -> verifier
 *                                                              |
 *                                                              v
 *                                                     policy -> candidates.jsonl
 *
 * Only the left-hand column differs between sources. Everything downstream —
 * the turn assembler (US-005), the board update loop (US-009), and the
 * observer and answers that later stories hang off the bus — sees the same
 * frames and reads time from the same injected clock, so a replay behaves
 * exactly like a live session.
 *
 * On the way past, both the raw frames and the final turns are written to the
 * session folder (`SessionStore`, US-008), so every session leaves a record on
 * disk whether or not a browser was watching.
 */
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { StatusState } from "../../shared/events.js";
import type { Chattiness } from "../../shared/policy.js";
import type { SessionInfo, SessionSettings, SessionSource } from "../../shared/session.js";
import { describeSource, sourceSlug } from "../../shared/session.js";
import type { PauseState } from "../../shared/turns.js";
import {
  EventReplaySource,
  fixtureEventsPath,
  type ReplaySpeed,
} from "../asr/EventReplaySource.js";
import { RealtimeTranscriptionClient } from "../asr/realtimeClient.js";
import { TurnAssembler } from "../asr/turns.js";
import type { AudioSource } from "../audio/AudioSource.js";
import { MicSource } from "../audio/MicSource.js";
import { WavReplaySource } from "../audio/WavReplaySource.js";
import { BoardUpdater } from "../board/BoardUpdater.js";
import { SimulatedClock, systemClock, type Clock } from "../clock.js";
import type { EventBus } from "../events/bus.js";
import { InterjectionPolicy } from "../interject/InterjectionPolicy.js";
import { Observer } from "../interject/Observer.js";
import { Verifier } from "../interject/Verifier.js";
import { MuseClient, type ModelClient } from "../model/client.js";
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

/**
 * Builds the model client a session's board, observer and answers call, or
 * returns `null` to run a session with no model at all — which is what
 * happens without `MODEL_API_KEY`, and what the unit tests do so `npm test`
 * makes no network calls.
 */
export type ModelClientFactory = () => ModelClient | null;

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
  /** Makes the model client. Defaults to Muse Spark when there is an API key. */
  createModel?: ModelClientFactory;
  /** Clock for live sessions; a replay brings its own simulated one. */
  liveClock?: Clock;
  /** Real time that a `1x` replay paces itself against. */
  wallClock?: Clock;
  /** Replay speed for `events` sources. `1x` for the UI, `max` for tests. */
  replaySpeed?: ReplaySpeed;
  /** How talkative the policy starts out (US-014). The header changes it live. */
  chattiness?: Chattiness;
}

/**
 * Holds the session folder for the pipeline closures that write to it.
 *
 * It is a box rather than a plain value because the folder is only opened
 * once the source has been accepted — a start that answers 400 or 503 must
 * not leave an empty folder behind — while the closures that write to it are
 * built during that acceptance. Nothing writes before `start()` returns.
 */
interface StoreSlot {
  writer: SessionWriter | null;
}

/** The model-driven loops a session runs, or nulls when it has no model. */
interface ModelLoops {
  board: BoardUpdater | null;
  observer: Observer | null;
  verifier: Verifier | null;
  policy: InterjectionPolicy | null;
}

interface RunningSession {
  info: SessionInfo;
  assembler: TurnAssembler;
  store: StoreSlot;
  /** Where `/ws/audio` delivers, for a `mic` session; `undefined` otherwise. */
  mic: MicSource | undefined;
  /** The board update loop, or `null` when there is no model client. */
  board: BoardUpdater | null;
  /** The observer (US-012), or `null` when there is no model client. */
  observer: Observer | null;
  /** The fact check (US-013), or `null` when there is no model client. */
  verifier: Verifier | null;
  /** The interjection policy (US-014), or `null` when there is no model client. */
  policy: InterjectionPolicy | null;
  /** What the transcription dot shows once the session is published. */
  transcription: [state: StatusState, detail: string];
  /** What the model dot shows once the session is published. */
  model: [state: StatusState, detail: string];
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
  private readonly createModel: ModelClientFactory;
  private readonly liveClock: Clock;
  private readonly wallClock: Clock;
  private readonly replaySpeed: ReplaySpeed;

  private current: RunningSession | undefined;
  private started = 0;
  /**
   * The settings the next session starts with, and the ones the running
   * session is using. Server-wide rather than per session, so turning Sotto
   * down between conversations sticks.
   */
  private currentSettings: SessionSettings;

  constructor(options: SessionManagerOptions) {
    this.bus = options.bus;
    this.apiKey = options.apiKey;
    this.logger = options.logger ?? console;
    this.createAsrClient =
      options.createAsrClient ??
      ((clientOptions) => new RealtimeTranscriptionClient(clientOptions));
    this.createStore =
      options.createStore ?? ((info) => SessionStore.create(info, { logger: this.logger }));
    this.createModel =
      options.createModel ??
      ((): ModelClient | null =>
        this.apiKey === undefined || this.apiKey === ""
          ? null
          : new MuseClient({ apiKey: this.apiKey, logger: this.logger }));
    this.liveClock = options.liveClock ?? systemClock;
    this.wallClock = options.wallClock ?? systemClock;
    this.replaySpeed = options.replaySpeed ?? "1x";
    // The bus is where the settings a browser is caught up with are
    // remembered, so they start from there and are only published when this
    // manager was built with something else in mind.
    this.currentSettings = options.chattiness === undefined
      ? this.bus.settingsState()
      : { chattiness: options.chattiness };
    if (this.currentSettings.chattiness !== this.bus.settingsState().chattiness) {
      this.bus.setSettings(this.currentSettings);
    }
  }

  /** The session that is running, or `null`. */
  state(): SessionInfo | null {
    return this.current?.info ?? null;
  }

  /** The settings as they now stand (US-014's chattiness). */
  settings(): SessionSettings {
    return this.currentSettings;
  }

  /**
   * Changes how talkative Sotto is, live. A running session's policy picks it
   * up at once and `session.json` records it; with nothing running it is the
   * setting the next session will start with.
   */
  setChattiness(chattiness: Chattiness): SessionSettings {
    if (chattiness !== this.currentSettings.chattiness) {
      this.currentSettings = { chattiness };
      this.bus.setSettings(this.currentSettings);
      this.current?.policy?.setChattiness(chattiness);
      this.current?.store.writer?.setSettings(this.currentSettings);
    }
    return this.currentSettings;
  }

  /**
   * The running session's interjection policy (US-014), or `null`. This is
   * where the courtesy hooks live: wake-phrase detection (US-017) and the
   * answer agent (US-018) call `wakePhraseDetected` and `setAnswerThinking`
   * on it so that Sotto does not talk over itself.
   */
  interjectionPolicy(): InterjectionPolicy | null {
    return this.current?.policy ?? null;
  }

  /**
   * The running session's microphone input, for `/ws/audio` to write into.
   * `null` unless a `mic` session is running.
   */
  micInput(): MicSource | null {
    return this.current?.mic ?? null;
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
    // The folder records the context the session ran in, so the eval harness
    // (US-016) can read a report's chattiness off the disk.
    store.writer?.setSettings(this.currentSettings);

    this.current = running;
    // The session goes out before its statuses, so a listener always knows
    // which session a dot is talking about.
    this.bus.setSession(info);
    this.bus.setStatus("transcription", ...running.transcription);
    this.bus.setStatus("model", ...running.model);
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
    // The policy asks the assembler whether anybody is talking, and the
    // assembler is built from the loops, so the getter closes over the
    // `const` below. It is only ever called once `start()` has returned.
    const loops = this.modelLoops(info, clock, store, () => assembler.pauseState());
    const assembler = this.assembler(clock, store, loops);
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
      mic: undefined,
      ...loops,
      transcription: ["active", `replaying ${fixture} events at ${this.replaySpeed}`],
      model: modelStatus(loops.board),
      stop: () => source.stop(),
      // Not `assemblerSink`: a saved session records every raw frame first,
      // so `events.jsonl` is a capture of the stream the assembler saw.
      done: source
        .run({
          onFrame: (record) => {
            store.writer?.appendEvent(record);
            assembler.accept(record);
          },
          onEnd: () => {},
        })
        // The last few turns of a conversation never reach four, so the board
        // gets one more update — and the observer one more look — before the
        // session is declared over.
        .then(() => drainLoops(loops)),
      stopRequested: false,
    };
  }

  /** `wav` and `mic` share this path: audio in, realtime transcription out. */
  private startLive(
    info: SessionInfo,
    source: Extract<SessionSource, { kind: "wav" | "mic" }>,
    store: StoreSlot,
  ): RunningSession {
    const apiKey = this.apiKey;
    if (apiKey === undefined || apiKey === "") {
      throw new SessionStartError(
        "live transcription needs MODEL_API_KEY in .env; replay an events fixture instead",
        503,
      );
    }

    // The mic source exists before the browser dials `/ws/audio` — the page
    // only opens that socket once this call has answered — so it buffers
    // whatever arrives before the transcription socket is ready.
    let mic: MicSource | undefined;
    let audio: AudioSource;
    if (source.kind === "mic") {
      mic = new MicSource();
      audio = mic;
    } else {
      try {
        audio = WavReplaySource.forFixture(source.fixture, this.liveClock);
      } catch (error) {
        throw new SessionStartError(
          `cannot replay WAV fixture "${source.fixture}": ${message(error)}`,
          400,
        );
      }
    }

    // As in `startReplay`: the pause getter reads the assembler built below.
    const loops = this.modelLoops(info, this.liveClock, store, () => assembler.pauseState());
    const assembler = this.assembler(this.liveClock, store, loops);
    const client = this.createAsrClient({
      apiKey,
      clock: this.liveClock,
      onFrame: (record) => {
        // The first frame back is the proof the session is really up. A
        // stopped session keeps receiving frames while the API flushes,
        // though, and those must not light the dot again after the UI has
        // been told the session is over.
        if (this.current?.info.id === info.id) {
          this.bus.setStatus(
            "transcription",
            "active",
            `transcribing ${describeSource(info.source)}`,
          );
        }
        store.writer?.appendEvent(record);
        assembler.accept(record);
      },
      logger: this.logger,
    });

    return {
      info,
      assembler,
      store,
      mic,
      ...loops,
      transcription: [
        "connecting",
        source.kind === "mic"
          ? "waiting for the microphone"
          : "opening transcription session",
      ],
      model: modelStatus(loops.board),
      stop: () => client.stop(),
      done: client.run(audio).then(() => drainLoops(loops)),
      stopRequested: false,
    };
  }

  private assembler(clock: Clock, store: StoreSlot, loops: ModelLoops): TurnAssembler {
    return new TurnAssembler({
      clock,
      // Frame times are measured from the start of the stream on both paths —
      // the realtime client subtracts its own start, a replay sets the clock
      // to the capture's `atMs` — so the assembler's timeline begins at 0.
      startedAtMs: 0,
      logger: this.logger,
      onUpdate: (turn) => {
        this.bus.publish({ type: "turn", turn });
        // Partials are dropped by all three of these; only final turns are
        // saved, and only final turns can trigger a board update.
        store.writer?.appendTurn(turn);
        loops.board?.acceptTurn(turn);
        loops.observer?.acceptTurn(turn);
        // The policy is the one that wants the partials too: a `speechEnd`
        // arrives as one, and it is what opens a pause (US-014).
        loops.policy?.acceptTurn(turn);
      },
    });
  }

  /**
   * Builds everything a session does with a model, sharing one client: the
   * board update loop (US-009), the observer (US-012), the fact check
   * (US-013) and the interjection policy (US-014). All four are `null` when
   * there is no client — in which case the session still transcribes and
   * still saves, it just has no board and notices nothing.
   *
   * They form a chain. The board writes `board.json`/`board.md` and pushes
   * the board to every attached browser; the observer looks at the
   * conversation right after each update; a claim that looks wrong goes to
   * the verifier first and everything else straight to the policy, which
   * decides whether and when it is worth saying. Every candidate, check and
   * decision lands in `candidates.jsonl` on the way past.
   *
   * The model loops all drive the one `model` dot, guarded on the session
   * still being the current one the same way frames are: work that lands
   * after Stop must not light the dot back up. The board itself is published
   * either way, because the last update of a session is the one worth
   * reading.
   */
  private modelLoops(
    info: SessionInfo,
    clock: Clock,
    store: StoreSlot,
    pauseState: () => PauseState,
  ): ModelLoops {
    const model = this.createModel();
    if (model === null) {
      this.logger.warn(
        `[board] ${info.id} has no model client (MODEL_API_KEY is missing); the board will stay empty`,
      );
      return { board: null, observer: null, verifier: null, policy: null };
    }
    const onModelState = (state: "connecting" | "active" | "error", detail: string): void => {
      if (this.current?.info.id === info.id) this.bus.setStatus("model", state, detail);
    };
    const policy = new InterjectionPolicy({
      clock,
      pauseState,
      chattiness: this.currentSettings.chattiness,
      logger: this.logger,
      onRecord: (record) => store.writer?.appendCandidate(record),
      // US-015 is what turns a decision into a card on the stage. Until then
      // a delivered candidate's output is the log and nothing else.
      onDeliver: () => {},
    });
    const verifier = new Verifier({
      clock,
      model,
      logger: this.logger,
      onRecord: (record) => store.writer?.appendCandidate(record),
      // A claim that really is wrong has the correction in its detail by now,
      // and goes to the policy like any other candidate.
      onVerified: (candidate) => policy.accept(candidate),
      onModelState,
    });
    const observer = new Observer({
      clock,
      model,
      logger: this.logger,
      onRecord: (record) => store.writer?.appendCandidate(record),
      // A claim that looks wrong is checked against the web before it can be
      // said to anyone (US-013); everything else goes straight to the policy.
      onCandidate: (candidate) => {
        if (candidate.type === "factual_error") verifier.verify(candidate);
        else policy.accept(candidate);
      },
      onModelState,
    });
    const board = new BoardUpdater({
      clock,
      model,
      logger: this.logger,
      onUpdate: (update) => {
        store.writer?.writeBoard(update.board, update.markdown);
        this.bus.publish({
          type: "board",
          board: update.board,
          changedIds: update.changedIds,
          updatedAtMs: update.atMs,
        });
        // Right after each board update, while the board says what the group
        // has stated and decided. Tracked on the clock inside, so the call is
        // registered before this returns and `max` replay waits for it.
        observer.observe(update.board);
      },
      onModelState,
    });
    return { board, observer, verifier, policy };
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
    running.board?.stop();
    running.observer?.stop();
    running.verifier?.stop();
    running.policy?.stop();
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

/**
 * Gives every loop the end of the conversation: the board gets a last update
 * for the turns that never reached four, the observer gets a last look at the
 * board that came out of it, the checks that look produced get to come back,
 * and the policy decides about them. In that order, because each one reads
 * what the one before it wrote.
 */
async function drainLoops(loops: ModelLoops): Promise<void> {
  await loops.board?.flush();
  await loops.observer?.flush();
  await loops.verifier?.flush();
  // Last, and synchronous: the conversation has ended in silence, so the
  // policy gets one look at that final pause and then accounts for whatever
  // is still waiting.
  loops.policy?.flush();
}

/** What the model dot says about a session: ready, or not running at all. */
function modelStatus(board: BoardUpdater | null): [state: StatusState, detail: string] {
  return board === null
    ? ["error", "MODEL_API_KEY is missing"]
    : ["active", "model client ready"];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
