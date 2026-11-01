/**
 * Owns the one running session, and wires it up:
 *
 *     WAV fixture  -> realtime transcription client -\
 *     microphone   -> realtime transcription client --> turn assembler -> bus
 *     capture (1x) ------------------------------------/        |
 *                                                              v
 *                                                        board updater -> bus
 *                                                              |
 *                                      final turns -> observer -> verifier
 *                                                              |
 *                                                              v
 *                                                     policy -> candidates.jsonl
 *                                                              |
 *                                                   wake phrase -> answer agent
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
import { join } from "node:path";
import { TYPED_ASKER } from "../../shared/answers.js";
import {
  ARTIFACT_FILE_PATTERN,
  artifactFileName,
  artifactUrl,
  type Artifact,
} from "../../shared/artifacts.js";
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { StageCard } from "../../shared/cards.js";
import type { CandidateType } from "../../shared/candidates.js";
import type { StatusState } from "../../shared/events.js";
import type { FeedbackLogRecord, FeedbackVerdict } from "../../shared/feedback.js";
import type { Chattiness, DeliveredLevel } from "../../shared/policy.js";
import type { SessionInfo, SessionSettings, SessionSource } from "../../shared/session.js";
import { defaultSettings, describeSource, sourceSlug } from "../../shared/session.js";
import { isSottoTurn, type PauseState, type TurnUpdate } from "../../shared/turns.js";
import {
  EventReplaySource,
  fixtureEventsPath,
  type ReplaySpeed,
} from "../asr/EventReplaySource.js";
import { RealtimeTranscriptionClient } from "../asr/realtimeClient.js";
import type { AudioSource } from "../audio/AudioSource.js";
import { MicSource } from "../audio/MicSource.js";
import { WavReplaySource } from "../audio/WavReplaySource.js";
import { AnswerAgent } from "../answer/AnswerAgent.js";
import { BoardUpdater } from "../board/BoardUpdater.js";
import { SimulatedClock, systemClock, type Clock } from "../clock.js";
import type { EventBus } from "../events/bus.js";
import { cardForInterjection } from "../interject/delivery.js";
import { InterjectionPolicy, type Interjection } from "../interject/InterjectionPolicy.js";
import { Observer } from "../interject/Observer.js";
import { Verifier } from "../interject/Verifier.js";
import { MuseClient, type ModelClient } from "../model/client.js";
import type { VoiceOut } from "../voice/voiceOut.js";
import { WakeWatcher, type WakeWatcherOptions } from "../wakeWatcher.js";
import { AddressWatcher } from "../answer/AddressWatcher.js";
import { classifyAddress } from "../answer/address.js";
import { BargeIn } from "../answer/BargeIn.js";
import { introducedName } from "./speakerIntroductions.js";
import { ARTIFACTS_DIR, SessionStore, type SessionWriter } from "./SessionStore.js";
import { SessionTranscription } from "./SessionTranscription.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

/**
 * How long `stop()` waits for the transcription socket to flush and close
 * before answering anyway. The session keeps draining in the background; this
 * only stops an HTTP request from hanging on it.
 */
export const STOP_DRAIN_MS = 5_000;

/**
 * Silence to give a replayed conversation after its last frame, before the
 * loops are drained.
 *
 * A capture ends within a few milliseconds of the last word (`moment-
 * contradiction`'s final `speechEnd` is 17 ms before its last frame), but the
 * conversation did not: a group that has stopped talking is in the longest
 * pause of the session, and that pause is the one a candidate still waiting
 * for a moment (US-014) has been waiting for. Without it the recording's end
 * reads as "everyone is still mid-sentence" and the policy writes the whole
 * thing off as `session_ended`. A live session needs none of this — its clock
 * keeps running on its own.
 */
export const REPLAY_TRAILING_SILENCE_MS = 3_000;

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
 * Hands a session the voice its answers are spoken with (V2-005), or returns
 * `null` to run a session that only ever answers on screen — which is what
 * the unit tests do, so `npm test` neither synthesizes nor makes a sound.
 */
export type VoiceFactory = () => VoiceOut | null;

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
  /**
   * The voice answers are spoken with (V2-005). Defaults to none, so a
   * SessionManager built without one answers on screen only; `server/app.ts`
   * passes the one {@link VoiceHub} the browser's `/ws/voice` is attached to.
   */
  createVoice?: VoiceFactory;
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
  /**
   * How many artifacts this folder holds, so the next one is numbered after
   * them (US-020). It counts attempts rather than successes: `02` following a
   * `01` that failed to write is a gap, which is better than two files called
   * `01`.
   */
  artifacts: number;
}

/** The model-driven loops a session runs, or nulls when it has no model. */
interface ModelLoops {
  /** Shared Spark client for final-turn addressing (V2-008). */
  modelClient: ModelClient | null;
  /** Retired with the session so late classifications cannot restart speech. */
  address?: AddressWatcher;
  board: BoardUpdater | null;
  observer: Observer | null;
  verifier: Verifier | null;
  policy: InterjectionPolicy | null;
  /** The answer agent (US-018), or `null` when there is no model client. */
  answers: AnswerAgent | null;
  /** Every card the policy delivered, by card id (US-015). */
  deliveries: Map<string, Delivered>;
}

/** One card that reached the stage, kept so feedback can be filed on it. */
interface Delivered {
  card: StageCard;
  candidateId: string;
  /** The level it went out at, which is what `wrong_moment` is a verdict on. */
  level: DeliveredLevel;
  type: CandidateType;
}

/**
 * The most recent session, kept after it has ended.
 *
 * It outlives the session deliberately, because two things the user does
 * happen *after* Stop. A replay's cards stay on the stage once it has
 * finished — that is when somebody actually reads them — so a 👍 clicked then
 * is still a verdict about *that* conversation and belongs in that folder's
 * `feedback.jsonl` (US-015). And a question typed into the stage is answered
 * against the conversation that just happened, whether or not it is still
 * running (US-019), by that session's own answer agent.
 *
 * Only one session is remembered: starting a new one clears the stage, so its
 * predecessor has nothing left to receive.
 */
interface LastSession {
  sessionId: string;
  store: StoreSlot;
  /** The session's clock, for the time a click or a question is recorded at. */
  clock: Clock;
  cards: Map<string, Delivered>;
  /** Its answer agent (US-018), which still takes typed questions (US-019). */
  answers: AnswerAgent | null;
}

/** What {@link SessionManager.recordFeedback} made of a click. */
export type FeedbackOutcome = "recorded" | "no-cards" | "unknown-card";

/**
 * What {@link SessionManager.askQuestion} made of a typed question (US-019).
 *
 * `no-session` is not "nothing is running": a question is answered against
 * the last conversation as happily as against the running one. It means
 * nothing has ever run, so there is no conversation to answer in.
 */
export type AskOutcome = "asked" | "no-session" | "no-model";

interface RunningSession {
  /** V2-008: final-turn addressing has its own bounded asynchronous work. */
  address?: AddressWatcher;
  info: SessionInfo;
  assembler: SessionTranscription;
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
  /** The answer agent (US-018), or `null` when there is no model client. */
  answers: AnswerAgent | null;
  /** The cards this session has put on the stage, by card id (US-015). */
  deliveries: Map<string, Delivered>;
  /** The session's clock: simulated for a replay, live otherwise. */
  clock: Clock;
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
  private readonly createVoice: VoiceFactory;
  private readonly liveClock: Clock;
  private readonly wallClock: Clock;
  private readonly replaySpeed: ReplaySpeed;

  private current: RunningSession | undefined;
  /**
   * The most recent session, running or not: what a feedback click (US-015)
   * and a typed question (US-019) are addressed to, both of which happen
   * after a replay has ended as readily as during one.
   */
  private last: LastSession | undefined;
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
    this.createVoice = options.createVoice ?? ((): VoiceOut | null => null);
    // V2-006: playback can end after generation, with no new ASR frame to
    // re-check held cards. The bus has already folded the voice state here.
    this.bus.subscribe((event) => {
      if (event.type === "voice") this.current?.policy?.playbackChanged();
    });
    this.liveClock = options.liveClock ?? systemClock;
    this.wallClock = options.wallClock ?? systemClock;
    this.replaySpeed = options.replaySpeed ?? "1x";
    // The bus is where the settings a browser is caught up with are
    // remembered, so they start from there and are only published when this
    // manager was built with something else in mind.
    this.currentSettings = options.chattiness === undefined
      ? this.bus.settingsState()
      : { ...defaultSettings(), chattiness: options.chattiness };
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
      this.currentSettings = { ...this.currentSettings, chattiness };
      this.bus.setSettings(this.currentSettings);
      this.current?.policy?.setChattiness(chattiness);
      this.current?.store.writer?.setSettings(this.currentSettings);
    }
    return this.currentSettings;
  }

  setVoiceMuted(voiceMuted: boolean): SessionSettings {
    this.currentSettings = { ...this.currentSettings, voiceMuted };
    this.bus.setSettings(this.currentSettings);
    this.current?.store.writer?.setSettings(this.currentSettings);
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

    const store: StoreSlot = { writer: null, artifacts: 0 };
    const running =
      source.kind === "events"
        ? this.startReplay(info, source.fixture, store)
        : this.startLive(info, source, store);
    store.writer = this.openStore(info);
    // The folder records the context the session ran in, so the eval harness
    // (US-016) can read a report's chattiness off the disk.
    store.writer?.setSettings(this.currentSettings);

    this.current = running;
    // The newest session takes over: its predecessor's cards have just left
    // the stage, since a session *starting* is what clears it, so there is
    // nothing left to say to the old answer agent either.
    this.last?.answers?.stop();
    this.last = {
      sessionId: info.id,
      store,
      clock: running.clock,
      cards: running.deliveries,
      answers: running.answers,
    };
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
    running.address?.stop();
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
    const voice = this.createVoice();
    const loops = this.modelLoops(
      info,
      clock,
      store,
      () => assembler.pauseState(),
      () => assembler.finalTurns(),
      () => assembler.streamNow(),
      voice,
    );
    const assembler = this.assembler(info, clock, store, loops, voice);
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
      clock,
      transcription: ["active", `replaying ${fixture} events at ${this.replaySpeed}`],
      model: modelStatus(loops.board),
      stop: () => source.stop(),
      // V2-006: raw frames pass through the same echo boundary as turns.
      done: source
        .run({
          onFrame: (record) => {
            if (record.frame["type"] === "speechEnd" || record.frame["type"] === "speechComplete") store.writer?.appendTiming?.({ stage: `asr_${record.frame["type"]}`, atMs: clock.now(), turnId: `${record.session}:${record.frame["turnId"]}`, audioProcessedMs: record.frame["audioProcessedMs"], frameAtMs: record.atMs });
            assembler.accept(record);
          },
          onEnd: () => {},
        })
        // The last few turns of a conversation never reach four, so the board
        // gets one more update — and the observer one more look — before the
        // session is declared over. The capture runs out a few milliseconds
        // after the last word, so the silence the conversation really ended
        // in is handed to the policy before it accounts for what is left.
        .finally(() => assembler.finish())
        .then(() => drainLoops(loops, () => clock.advanceBy(REPLAY_TRAILING_SILENCE_MS))),
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
    const voice = this.createVoice();
    const loops = this.modelLoops(
      info,
      this.liveClock,
      store,
      () => assembler.pauseState(),
      () => assembler.finalTurns(),
      () => assembler.streamNow(),
      voice,
    );
    const assembler = this.assembler(info, this.liveClock, store, loops, voice);
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
        if (record.frame["type"] === "speechEnd" || record.frame["type"] === "speechComplete") store.writer?.appendTiming?.({ stage: `asr_${record.frame["type"]}`, atMs: this.liveClock.now(), turnId: `${record.session}:${record.frame["turnId"]}`, audioProcessedMs: record.frame["audioProcessedMs"], frameAtMs: record.atMs });
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
      clock: this.liveClock,
      transcription: [
        "connecting",
        source.kind === "mic"
          ? "waiting for the microphone"
          : "opening transcription session",
      ],
      model: modelStatus(loops.board),
      stop: () => client.stop(),
      done: client.run(audio)
        .finally(() => assembler.finish())
        .then(() => drainLoops(loops)),
      stopRequested: false,
    };
  }

  private assembler(
    info: SessionInfo,
    clock: Clock,
    store: StoreSlot,
    loops: ModelLoops,
    voice: VoiceOut | null,
  ): SessionTranscription {
    const wake = this.wakeWatcher(info, loops, clock, store);
    const barge = new BargeIn({
      clock,
      speaking: () => voice?.playback?.().playing === true || this.bus.voiceState().speaking,
      answering: () => (loops.answers?.pending() ?? 0) > 0,
      interrupt: () => loops.answers?.interrupt() ?? voice?.interrupt?.() ?? Promise.resolve(null),
      command: (asked) => loops.answers?.command(asked),
      onTiming: (record) => store.writer?.appendTiming?.(record),
      onListening: (listening) => {
        this.bus.setListening(listening);
        if (listening) loops.policy?.wakePhraseDetected();
      },
    });
    return new SessionTranscription({
      clock,
      playback: () => voice?.playback?.() ?? { playing: false, recent: [] },
      logger: this.logger,
      onHuman: (turn, record, duringPlayback) => {
        if (this.current?.info.id === info.id) barge.accept(turn, record, duringPlayback);
      },
      onEvent: (record) => store.writer?.appendEvent(record),
      onEcho: (turn) => {
        wake.ignoreTurn(turn.turnId);
        if (barge.owns(turn.turnId)) this.bus.setListening(false);
        store.writer?.appendTiming?.({ stage: "self_echo", atMs: clock.now(), ...turn });
        // The last echo can close after playback ended. Re-read the pause
        // without counting Sotto as another human turn toward expiry.
        loops.policy?.playbackChanged();
      },
      onUpdate: (turn, suppressTriggers) => {
        if (turn.final) store.writer?.appendTiming?.({ stage: "turn_final", atMs: clock.now(), turnId: turn.turnId, turnStartMs: turn.startMs, turnEndMs: turn.endMs });
        this.bus.publish({ type: "turn", turn });
        // Partials are dropped by all three of these; only final turns are
        // saved, and only final turns can trigger a board update.
        store.writer?.appendTurn(turn);
        if (turn.final && turn.speaker !== null && !turn.speakerMappingUncertain && this.current?.info.id === info.id && this.bus.speakerNames()[turn.speaker] === undefined) {
          const name = introducedName(turn.text);
          if (name !== null) this.renameSpeaker(turn.speaker, name);
        }
        loops.board?.acceptTurn(turn);
        loops.observer?.acceptTurn(turn);
        if (turn.final && loops.board && loops.observer) {
          // The board reads Sotto's own lines (V2-008a) and the observer must
          // not: an interjection arguing with Sotto's last answer is the one
          // contradiction nobody in the room needs pointing out.
          const uncovered = loops.board.uncoveredTurns().filter((one) => !isSottoTurn(one));
          loops.observer.observe(loops.board.board(), uncovered);
        }
        // The policy is the one that wants the partials too: a `speechEnd`
        // arrives as one, and it is what opens a pause (US-014).
        loops.policy?.acceptTurn(turn);
        // And so does the wake phrase: the indicator is the point of reading
        // a partial at all (US-017).
        // V2-007 privately owns interrupted commands; ordinary side talk stays suppressed.
        if (suppressTriggers || barge.owns(turn.turnId)) {
          wake.ignoreTurn(turn.turnId);
          loops.address?.remember(turn);
        } else {
          wake.acceptTurn(turn);
        }
      },
    });
  }

  /**
   * Watches the turns for somebody addressing Sotto by name (US-017).
   *
   * It exists whether or not there is a model client, because the indicator
   * and the courtesy hook are not model work: a session with no key still
   * shows that it heard its name and still holds its (nonexistent)
   * interjections out of the way. The question goes to the answer agent
   * (US-018), which is `null` in that case, so nothing is answered.
   */
  private wakeWatcher(
    info: SessionInfo,
    loops: ModelLoops,
    clock: Clock,
    store: StoreSlot,
  ): WakeWatcher | AddressWatcher {
    const current = (): boolean => this.current?.info.id === info.id;
    const effects: WakeWatcherOptions = {
      onListening: (listening) => {
        // As with the transcription dot: a frame that lands after Stop must
        // not put the indicator back up. The bus takes it down on the
        // `session` event either way.
        if (!current()) return;
        if (listening) store.writer?.appendTiming?.({ stage: "wake_listening", atMs: clock.now() });
        this.bus.setListening(listening);
        // Whoever is talking to Sotto has the floor for the courtesy window,
        // from the moment they start asking rather than when they finish.
        if (listening) loops.policy?.wakePhraseDetected();
      },
      onQuestion: (trigger) => {
        if (!current()) return;
        store.writer?.appendTiming?.({ stage: "wake_question", atMs: clock.now(), turnId: trigger.turnId });
        // Asking again refreshes the window; from here the answer agent holds
        // the floor itself, with `setAnswerThinking` (US-018).
        loops.policy?.wakePhraseDetected();
        this.logger.log(
          `[wake] ${info.id} ${trigger.turnId} asked: ${trigger.question}`,
        );
        loops.answers?.ask({
          question: trigger.question,
          askedBy: trigger.speaker,
          turnId: trigger.turnId,
          // V2-008b: where the acknowledgment latency the room feels is
          // measured from, which only the watcher that read `speechEnd` knows.
          ...(trigger.heardAtMs === undefined ? {} : { heardAtMs: trigger.heardAtMs }),
        });
      },
    };
    const model = loops.modelClient;
    if (model === null) return new WakeWatcher(effects);
    const address = new AddressWatcher({
      ...effects,
      clock,
      wallClock: this.wallClock,
      classify: (input, signal) => classifyAddress(model, input, signal),
      speakers: () => this.bus.speakerNames(),
      onTiming: (record) => store.writer?.appendTiming?.(record),
    });
    loops.address = address;
    return address;
  }

  /**
   * Builds everything a session does with a model, sharing one client: the
   * board update loop (US-009), the observer (US-012), the fact check
   * (US-013), the interjection policy (US-014) and the answer agent
   * (US-018). All five are `null` when there is no client — in which case the
   * session still transcribes and still saves, it just has no board, notices
   * nothing and answers nothing.
   *
   * The board writes `board.json`/`board.md` and pushes the board to every
   * attached browser; the observer looks on finalized turns using the latest
   * board plus uncovered turns. A claim that looks wrong goes to
   * the verifier first and everything else straight to the policy, which
   * decides whether and when it is worth saying. Every candidate, check and
   * decision lands in `candidates.jsonl` on the way past. The answer agent
   * hangs off the side of all that, reading the board and the transcript but
   * waiting for none of it.
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
    transcript: () => readonly TurnUpdate[],
    streamNow: () => number,
    voice: VoiceOut | null,
  ): ModelLoops {
    const model = this.createModel();
    if (model === null) {
      this.logger.warn(
        `[board] ${info.id} has no model client (MODEL_API_KEY is missing); the board will stay empty`,
      );
      return {
        modelClient: null,
        board: null,
        observer: null,
        verifier: null,
        policy: null,
        answers: null,
        deliveries: new Map(),
      };
    }
    const onModelState = (state: "connecting" | "active" | "error", detail: string): void => {
      if (this.current?.info.id === info.id) this.bus.setStatus("model", state, detail);
    };
    const deliveries = new Map<string, Delivered>();
    const onTiming = (event: Record<string, unknown>): void => store.writer?.appendTiming?.(event);
    const policy = new InterjectionPolicy({
      clock,
      pauseState,
      chattiness: this.currentSettings.chattiness,
      logger: this.logger,
      onRecord: (record) => { store.writer?.appendCandidate(record); onTiming({ stage: "policy_decision", ...record }); },
      // The stage (US-015). The level the policy chose becomes the card's
      // variant, and the card is kept so a 👍 can find its way back to it.
      onDeliver: (interjection) => { this.deliver(info, deliveries, interjection); onTiming({ stage: "interjection_publish", atMs: clock.now(), candidateId: interjection.candidate.id, published: this.current?.info.id === info.id }); },
    });
    const verifier = new Verifier({
      clock,
      model,
      logger: this.logger,
      onRecord: (record) => { store.writer?.appendCandidate(record); onTiming({ stage: "verification_complete", ...record }); },
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
        if (candidate.type === "factual_error") { onTiming({ stage: "verification_start", atMs: clock.now(), candidateId: candidate.id }); verifier.verify(candidate); }
        else policy.accept(candidate);
      },
      onModelState,
      onTiming,
    });
    const board = new BoardUpdater({
      clock,
      model,
      logger: this.logger,
      onTiming,
      onUpdate: (update) => {
        store.writer?.writeBoard(update.board, update.markdown);
        this.bus.publish({
          type: "board",
          board: update.board,
          changedIds: update.changedIds,
          updatedAtMs: update.atMs,
        });
      },
      onModelState,
    });
    // Its own queue, on purpose: an answer must not wait behind a board
    // update, and the group must not wait for the board loop to let go of the
    // model (US-018).
    const answers = new AnswerAgent({
      clock,
      model,
      logger: this.logger,
      onTiming,
      // Said out loud as well as shown (V2-005). A hub with no page attached,
      // or a muted session, turns every utterance into `null` on its own, so
      // there is nothing to check here.
      ...(voice === null ? {} : { voice }),
      // Real time: `ackMs` and `firstAudioMs` are latencies the room felt,
      // and a `max` replay's session clock stands still during a model call.
      wallClock: this.wallClock,
      // V2-008a: Sotto's own line goes on the conversation's timeline, which
      // in a live session is offset from the clock by the server's uptime.
      streamNow,
      onSpoken: (turn) => this.recordSottoSpeech(info, store, board, turn),
      board: () => board.board(),
      transcript,
      speakers: () => this.bus.speakerNames(),
      // Published while this session still owns the stage — which it does
      // until the next one starts, not only while it is running: a question
      // typed after Stop (US-019) must put its answer somewhere.
      onCard: (card, answer) => {
        if (this.last?.sessionId === info.id) this.bus.publishCard(card);
        onTiming({ stage: "answer_card", atMs: clock.now(), answerId: answer.id, status: answer.status, hasHeadline: answer.headline !== "", latencyMs: answer.latencyMs, published: this.last?.sessionId === info.id });
      },
      onRecord: (record) => store.writer?.appendAnswer(record),
      // Generated HTML goes into this session's folder and is served back
      // from it (US-020), so the numbering is per session and so is the URL.
      onArtifact: ({ title, html }) => this.saveArtifact(info, store, title, html),
      // Sotto does not interject over its own answer.
      onThinking: (thinking) => policy.setAnswerThinking(thinking),
      onModelState,
    });
    return { modelClient: model, board, observer, verifier, policy, answers, deliveries };
  }

  /**
   * Writes one line of Sotto's own speech into the conversation (V2-008a).
   *
   * It goes exactly where a human turn goes — the live transcript, the
   * session folder's `transcript.md`, and the board, which reads it labeled
   * `Sotto` so a fact Sotto established can reach the notes. It goes nowhere
   * near the things that listen to the room: no wake or address check, no
   * barge-in, no speaker introduction, no observer and no policy. Sotto
   * reacting to its own voice is the one loop none of them could get out of,
   * and the floor is already held for the length of playback by the voice
   * state the policy reads.
   *
   * Addressed to the most recent session rather than only a running one, as
   * cards and feedback are: a question typed after Stop (US-019) is answered
   * aloud against the conversation that just happened, and that answer
   * belongs in its transcript.
   */
  private recordSottoSpeech(
    info: SessionInfo,
    store: StoreSlot,
    board: BoardUpdater,
    turn: TurnUpdate,
  ): void {
    if (this.last?.sessionId !== info.id) return;
    this.logger.log(
      `[transcript] ${info.id} Sotto said ${turn.text.length} characters` +
        `${turn.interrupted === true ? " before being cut off" : ""}`,
    );
    this.bus.publish({ type: "turn", turn });
    store.writer?.appendTurn(turn);
    board.acceptTurn(turn);
  }

  /**
   * Puts one delivered interjection on the stage (US-015).
   *
   * The card is recorded whatever happens, so feedback can be filed on it,
   * but it is only published while this is still the running session: a
   * decision that lands after Stop must not make a card appear on a stage the
   * user has already finished with, the same rule late frames follow.
   */
  private deliver(
    info: SessionInfo,
    deliveries: Map<string, Delivered>,
    interjection: Interjection,
  ): void {
    const candidate = interjection.candidate;
    const card = cardForInterjection(interjection, this.bus.speakerNames());
    deliveries.set(card.id, {
      card,
      candidateId: candidate.id,
      level: interjection.level,
      type: candidate.type,
    });
    this.logger.log(
      `[stage] ${info.id} ${interjection.level} ${card.id}: ${card.headline}`,
    );
    if (this.current?.info.id === info.id) this.bus.publishCard(card);
  }

  /**
   * Files the group's verdict on a delivered card (US-015): one line in the
   * session folder's `feedback.jsonl`.
   *
   * It answers for the most recent session rather than only for a running
   * one, because the cards stay on the stage after a replay ends and that is
   * when they are read. A session whose folder could not be opened still
   * accepts the click — as a rename does — it simply has nowhere to put it.
   */
  recordFeedback(cardId: string, verdict: FeedbackVerdict): FeedbackOutcome {
    const target = this.last;
    if (target === undefined || target.cards.size === 0) return "no-cards";
    const delivered = target.cards.get(cardId);
    if (delivered === undefined) return "unknown-card";
    const record: FeedbackLogRecord = {
      kind: "feedback",
      atMs: target.clock.now(),
      cardId,
      candidateId: delivered.candidateId,
      level: delivered.level,
      type: delivered.type,
      headline: delivered.card.headline,
      deliveredAtMs: delivered.card.createdAtMs,
      verdict,
    };
    target.store.writer?.appendFeedback(record);
    this.logger.log(`[stage] ${target.sessionId} ${cardId} is ${verdict}`);
    return "recorded";
  }

  /**
   * Asks Sotto a question somebody typed (US-019).
   *
   * It is the spoken path with a different front door: the same
   * {@link AnswerAgent}, the same queue, the same card on the stage and the
   * same line in `answers.jsonl` — only `askedBy` differs, because nobody
   * said it out loud and there is no turn it belongs to.
   *
   * Like feedback, it is addressed to the most recent session rather than
   * only to a running one. A group reads the board after a replay has ended
   * and that is exactly when somebody types the question they meant to ask,
   * so the answer is given against the conversation that just happened.
   */
  askQuestion(question: string): AskOutcome {
    const target = this.last;
    if (target === undefined) return "no-session";
    if (target.answers === null) return "no-model";
    target.answers.ask({ question, askedBy: TYPED_ASKER, turnId: null });
    return "asked";
  }

  /**
   * Writes one piece of generated HTML into a session's folder (US-020).
   *
   * `null` when there is nowhere to put it — a session whose folder could not
   * be opened, or a disk that refused the write — because the card's frame is
   * served from that file and an answer with a broken frame in it is worse
   * than the same answer in words.
   */
  private saveArtifact(
    info: SessionInfo,
    store: StoreSlot,
    title: string,
    html: string,
  ): Artifact | null {
    const writer = store.writer;
    if (writer === null) return null;
    store.artifacts += 1;
    const fileName = artifactFileName(store.artifacts, title);
    const path = writer.writeArtifact(fileName, html);
    if (path === null) return null;
    return { title, path, url: artifactUrl(info.id, fileName) };
  }

  /**
   * The file one artifact URL names, or `null` if there is no such artifact.
   *
   * Only the most recent session is reachable, which is the same session a
   * feedback click and a typed question are addressed to: starting a new one
   * clears the stage, so no earlier session has a card left that could point
   * here. The file name is matched against {@link ARTIFACT_FILE_PATTERN}
   * rather than cleaned up — this reads a path out of a URL, so anything that
   * is not a name the server itself would have written is simply not found.
   */
  artifactFile(sessionId: string, fileName: string): string | null {
    const target = this.last;
    if (target === undefined || target.sessionId !== sessionId) return null;
    const dir = target.store.writer?.dir;
    if (dir === undefined) return null;
    if (!ARTIFACT_FILE_PATTERN.test(fileName)) return null;
    return join(dir, ARTIFACTS_DIR, fileName);
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
    running.address?.stop();
    // Not `running.answers`: a question typed after Stop is answered against
    // the conversation that just ended (US-019), so the agent is only
    // retired when the next session supersedes it.
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
 *
 * `beforePolicy` is where a replay hands over its trailing silence
 * ({@link REPLAY_TRAILING_SILENCE_MS}) — after the checks have come back, so
 * everything the conversation produced is in the policy's hands, and before
 * the policy's own last look, which is what that silence is for.
 */
async function drainLoops(loops: ModelLoops, beforePolicy?: () => void): Promise<void> {
  await loops.address?.flush();
  await loops.board?.flush();
  await loops.observer?.flush();
  await loops.verifier?.flush();
  // An answer asked in the last seconds of a conversation is still owed to
  // whoever asked for it, and the policy must not be left thinking one is
  // still being written.
  await loops.answers?.flush();
  beforePolicy?.();
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
