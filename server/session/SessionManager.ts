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
import type { CandidateLogLine, CandidateType } from "../../shared/candidates.js";
import { MIC_AWAY_DETAIL, type StatusState } from "../../shared/events.js";
import type { FeedbackLogRecord, FeedbackVerdict } from "../../shared/feedback.js";
import {
  limitsFor,
  type Boldness,
  type DeliveredLevel,
  type Frequency,
  type PolicySettings,
} from "../../shared/policy.js";
import {
  RESEARCH_CONFIRMED_NOTE,
  RESEARCH_DISAGREES_NOTE,
  type ResearchLogLine,
} from "../../shared/research.js";
import type { SessionInfo, SessionSettings, SessionSource } from "../../shared/session.js";
import { defaultSettings, describeSource, sourceSlug } from "../../shared/session.js";
import { isSottoTurn, type PauseState, type TurnUpdate } from "../../shared/turns.js";
import {
  EventReplaySource,
  type EventReplayOptions,
  type ReplaySpeed,
} from "../asr/EventReplaySource.js";
import { RealtimeTranscriptionClient } from "../asr/realtimeClient.js";
import { recordedSource, type AudioSource } from "../audio/AudioSource.js";
import { MicSource } from "../audio/MicSource.js";
import { WavReplaySource } from "../audio/WavReplaySource.js";
import { AnswerAgent } from "../answer/AnswerAgent.js";
import { BoardUpdater } from "../board/BoardUpdater.js";
import { SimulatedClock, systemClock, type Clock } from "../clock.js";
import type { EventBus } from "../events/bus.js";
import { CandidateGate, DEFAULT_GATE_MODE, type GateMode } from "../interject/CandidateGate.js";
import { correctedClaim, spokenCorrection } from "../interject/corrections.js";
import {
  NOTHING_RAISED_LINE,
  RaisedHand,
  calledOnCardLine,
  calledOnPacketLine,
} from "./raisedHand.js";
import { cardForInterjection, deliveredCardId } from "../interject/delivery.js";
import { InterjectionPolicy, type Interjection } from "../interject/InterjectionPolicy.js";
import { Observer } from "../interject/Observer.js";
import { Verifier } from "../interject/Verifier.js";
import { MuseClient, type ModelClient } from "../model/client.js";
import type { GlimmerClient } from "../model/GlimmerClient.js";
import { JudgmentRouter } from "../model/judgment.js";
import { ResearchCards } from "../research/ResearchCards.js";
import { ResearchManager } from "../research/ResearchManager.js";
import { ResearchRunner } from "../research/ResearchRunner.js";
import type { VoiceOut } from "../voice/voiceOut.js";
import { WakeWatcher, type WakeWatcherOptions } from "../wakeWatcher.js";
import { AddressWatcher } from "../answer/AddressWatcher.js";
import { classifyQuestion, type OpenQuestion } from "../question/question.js";
import { QuestionWatcher } from "../question/QuestionWatcher.js";
import { Reservations } from "../question/Reservations.js";
import { ReadBacks } from "../decision/ReadBacks.js";
import { decisionNote } from "../decision/readback.js";
import { StillCurrentWatcher } from "../question/StillCurrentWatcher.js";
import { classifyStillCurrent } from "../question/stillCurrent.js";
import { classifyAddress } from "../answer/address.js";
import { BargeIn } from "../answer/BargeIn.js";
import { FollowUpWindow } from "../answer/FollowUpWindow.js";
import { classifyFollowUp } from "../answer/followUp.js";
import { Greeting } from "./Greeting.js";
import { introducedNames } from "./speakerIntroductions.js";
import { ARTIFACTS_DIR, SessionStore, type SessionWriter } from "./SessionStore.js";
import { SessionDigest, asksForWrapUp } from "./digest.js";
import { WrapUp } from "./WrapUp.js";
import { SessionTranscription } from "./SessionTranscription.js";
import { Steering } from "./Steering.js";

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

/**
 * Builds the local judgment model (V2-010), or returns `null` when Glimmer is
 * not configured. A `null` is not a failure: the session's judgment calls go
 * to Muse Spark instead, which is what the header's judgment dot reports.
 */
export type GlimmerClientFactory = () => GlimmerClient | null;

/**
 * Builds the source an `events` session replays (US-006).
 *
 * Defaults to {@link EventReplaySource.forFixture}, which reads
 * `fixtures/events/<name>.jsonl`. The shadow run (V3-016) passes its own, so a
 * past session folder's `events.jsonl` goes through the pipeline exactly as a
 * fixture capture does — the frames are the same shape, only the path differs.
 */
export type ReplaySourceFactory = (
  fixture: string,
  options: EventReplayOptions,
) => EventReplaySource;

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
   * Makes the local judgment model (V2-010). Defaults to none, so a
   * SessionManager built without one judges with Muse Spark and `npm test`
   * never dials the local server; `server/app.ts` passes
   * {@link glimmerFromEnv}.
   */
  createGlimmer?: GlimmerClientFactory;
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
  /**
   * Where an `events` session's frames come from. Defaults to a fixture
   * capture; `npm run shadow` (V3-016) points it at a past session folder.
   */
  createReplaySource?: ReplaySourceFactory;
  /**
   * How often and how boldly the policy starts out (US-014, split in two by
   * V2-017). The header changes both live.
   */
  settings?: PolicySettings;
  /**
   * Who scores a candidate before the policy sees it (V2-016). Defaults to
   * {@link DEFAULT_GATE_MODE}, which V3-001 made `spark`: the observer's own
   * scores stand and no second call is made, because a local verdict's
   * 24–34 s is wider than the moment it is judging. `glimmer` forces the
   * local gate on, which is what `npm run eval -- --gate glimmer` and
   * `npm run e2e -- --gate glimmer` measure.
   */
  gate?: GateMode;
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
   * What the session ends with (V2-018), collected from the same records the
   * folder is written from.
   *
   * It lives beside the writer rather than inside it because it is wanted
   * even when there is no folder: a laptop that could not open one still
   * answers "Sotto, wrap us up".
   */
  digest: SessionDigest;
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
  /**
   * Which model the session's judgment calls go to (V2-010). Built even when
   * there is no model client at all, so the dot tells the truth either way.
   */
  judgment: JudgmentRouter;
  /** Retired with the session so late classifications cannot restart speech. */
  address?: AddressWatcher;
  /**
   * What the room wondered aloud (V3-002), or `null` with no model client.
   *
   * It is deliberately beside the observer rather than inside it: an open
   * question is noticed per final turn, in about two seconds, where the
   * observer looks once per board update.
   */
  questions: QuestionWatcher | null;
  /**
   * The few seconds after an answer in which the room needs no wake word
   * (V3-014), or `null` with no model client — there is nothing to follow up
   * on without one.
   */
  followUp: FollowUpWindow | null;
  board: BoardUpdater | null;
  observer: Observer | null;
  verifier: Verifier | null;
  /**
   * The judgment gate in front of the policy (V2-016), or `null` when there
   * is no model client. Every candidate but a `research_hook` comes through
   * it, including one the verifier has just checked.
   */
  gate: CandidateGate | null;
  policy: InterjectionPolicy | null;
  /** The answer agent (US-018), or `null` when there is no model client. */
  answers: AnswerAgent | null;
  /** Every card the policy delivered, by card id (US-015). */
  deliveries: Map<string, Delivered>;
  /**
   * What Sotto is holding and has not said (V3-017), with the sentence each
   * one would be read out in. Built even without a model client, so that
   * "Sotto, go ahead" always has somewhere to land.
   */
  hand: RaisedHand;
  /**
   * What Sotto decides to look up, and how much of it (V2-012).
   *
   * A `research_hook` candidate never goes to the interjection policy: a hook
   * is an idea to look something up, not something to say, so it comes here
   * to be deduplicated, gated and — within the budget — searched. The
   * planner inside it proposes ideas of its own every two minutes.
   */
  research: ResearchManager | null;
  /**
   * The search itself, and the packets it produced (V2-013).
   *
   * Kept beside the manager because the packets are what a research card is
   * made of (V2-014) and what a spoken briefing is built from (V2-015); the
   * manager only decides *whether* to look something up.
   */
  researchRunner: ResearchRunner | null;
  /**
   * How a finished packet reaches the stage (V2-014).
   *
   * Quietly: a compact card, only in a pause, on a budget of its own. It is
   * the last stage of the research pipeline and the only one the room sees.
   */
  researchCards: ResearchCards | null;
  /**
   * Claiming a question out loud (V3-015), or `null` with no model client.
   *
   * It needs no model of its own — the words are written from the
   * classifier's topic — but a session with no model notices no questions, so
   * there would be nothing for it to claim.
   */
  reservations: Reservations | null;
  /**
   * Whether the room still wants an answer Sotto went and found (V3-004), or
   * `null` with no model client.
   *
   * Never in the critical path: it keeps a verdict per waiting answer, so the
   * instant between a pause being noticed and an utterance being opened costs
   * no model call.
   */
  stillCurrent: StillCurrentWatcher | null;
  /**
   * Read-backs at decision points (V3-013), or `null` with no model client.
   *
   * It makes no call of its own either: the closing decision rides V3-002's
   * classifier and the attachment is matched on words, which is what lets a
   * read-back arrive seconds after the decision rather than after the board
   * update that records it.
   */
  readBacks: ReadBacks | null;
  /**
   * The room turning Sotto down or up by talking to it (V3-006), or `null`
   * with no model client.
   *
   * It needs no model of its own — stepping a setting and showing a note is
   * all it does — but both ways in run through things a session without one
   * does not have: the command classifier (V2-007) and the unprompted lines
   * `Reservations` says.
   */
  steering: Steering | null;
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
  /** V3-002: the per-turn question classifier, retired with the session. */
  questions: QuestionWatcher | null;
  /** V3-014: the follow-up window, closed with the session. */
  followUp: FollowUpWindow | null;
  /** V3-015: the claims waiting for a gap, silenced with the session. */
  reservations: Reservations | null;
  /** V3-004: the cached "is the room still on this?", retired with the session. */
  stillCurrent: StillCurrentWatcher | null;
  /** V3-013: the read-backs, which stop matching decisions with the session. */
  readBacks: ReadBacks | null;
  /** Where this session's judgment calls run: local Glimmer or Spark (V2-010). */
  judgment: JudgmentRouter;
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
  /** The judgment gate the candidates come through (V2-016). */
  gate: CandidateGate | null;
  /** The interjection policy (US-014), or `null` when there is no model client. */
  policy: InterjectionPolicy | null;
  /** The answer agent (US-018), or `null` when there is no model client. */
  answers: AnswerAgent | null;
  /**
   * The opening hello and the name nudge (V2-009), or `null` for an `events`
   * replay — a recording of a conversation that has already happened is not a
   * room to say hello to, and greeting one would put a card the policy never
   * delivered in front of the eval harness.
   */
  greeting: Greeting | null;
  /** The cards this session has put on the stage, by card id (US-015). */
  deliveries: Map<string, Delivered>;
  /** The research planner, gate and job budget (V2-012). */
  research: ResearchManager | null;
  /** The quiet cards the packets become (V2-014). */
  researchCards: ResearchCards | null;
  /** "Sotto, wrap us up" (V2-018). It needs no model, so it is never null. */
  wrapUp: WrapUp;
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
  private readonly createGlimmer: GlimmerClientFactory;
  private readonly createVoice: VoiceFactory;
  private readonly liveClock: Clock;
  private readonly wallClock: Clock;
  private readonly replaySpeed: ReplaySpeed;
  private readonly createReplaySource: ReplaySourceFactory;
  private readonly gateMode: GateMode;

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
    // Defaults to none, like `createVoice`: a SessionManager built without
    // one judges in the cloud, which is what keeps `npm test` off the local
    // server as surely as it is off the network. `server/app.ts` passes
    // {@link glimmerFromEnv}.
    this.createGlimmer = options.createGlimmer ?? ((): GlimmerClient | null => null);
    this.createVoice = options.createVoice ?? ((): VoiceOut | null => null);
    // V2-006: playback can end after generation, with no new ASR frame to
    // re-check held cards. The bus has already folded the voice state here.
    this.bus.subscribe((event) => {
      if (event.type !== "voice") return;
      this.current?.policy?.playbackChanged();
      this.current?.researchCards?.playbackChanged();
    });
    this.liveClock = options.liveClock ?? systemClock;
    this.wallClock = options.wallClock ?? systemClock;
    this.replaySpeed = options.replaySpeed ?? "1x";
    this.createReplaySource =
      options.createReplaySource ??
      ((fixture, replay) => EventReplaySource.forFixture(fixture, replay));
    this.gateMode = options.gate ?? DEFAULT_GATE_MODE;
    // The bus is where the settings a browser is caught up with are
    // remembered, so they start from there and are only published when this
    // manager was built with something else in mind.
    const remembered = this.bus.settingsState();
    this.currentSettings = options.settings === undefined
      ? remembered
      : { ...defaultSettings(), ...options.settings };
    if (
      this.currentSettings.frequency !== remembered.frequency ||
      this.currentSettings.boldness !== remembered.boldness
    ) {
      this.bus.setSettings(this.currentSettings);
    }
  }

  /** The session that is running, or `null`. */
  state(): SessionInfo | null {
    return this.current?.info ?? null;
  }

  /** The settings as they now stand (V2-017's frequency and boldness). */
  settings(): SessionSettings {
    return this.currentSettings;
  }

  /**
   * Changes how often or how boldly Sotto contributes, live (V2-017). A
   * running session's policy picks it up at once — and so do its research
   * cards, which are rationed by the same frequency — and `session.json`
   * records it; with nothing running it is what the next session starts with.
   */
  setPolicySettings(patch: {
    frequency?: Frequency | undefined;
    boldness?: Boldness | undefined;
  }): SessionSettings {
    const frequency = patch.frequency ?? this.currentSettings.frequency;
    const boldness = patch.boldness ?? this.currentSettings.boldness;
    if (
      frequency === this.currentSettings.frequency &&
      boldness === this.currentSettings.boldness
    ) {
      return this.currentSettings;
    }
    this.currentSettings = { ...this.currentSettings, frequency, boldness };
    this.bus.setSettings(this.currentSettings);
    this.current?.policy?.setSettings({ frequency, boldness });
    this.current?.researchCards?.setLimits(limitsFor(frequency));
    this.current?.store.writer?.setSettings(this.currentSettings);
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

    const store: StoreSlot = { writer: null, artifacts: 0, digest: new SessionDigest() };
    const running =
      source.kind === "events"
        ? this.startReplay(info, source.fixture, store)
        : this.startLive(info, source, store);
    store.writer = this.openStore(info);
    // The folder records the context the session ran in, so the eval harness
    // (US-016) can read a report's frequency and boldness off the disk.
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
    // V2-010: which model judges is the answer to a health check, so the dot
    // says "checking" until it comes back. Nothing waits for it — a judgment
    // role awaits `judgment.client()` instead.
    this.bus.setStatus("judgment", "connecting");
    void running.judgment.check();
    this.watch(running);
    // After the `session` event, which is what clears the stage: a card
    // published before it would be swept away by its own session (V2-009).
    running.greeting?.start();
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
    running.questions?.stop();
    running.followUp?.stop();
    running.greeting?.stop();
    running.wrapUp.stop();
    running.research?.stop();
    running.researchCards?.stop();
    running.reservations?.stop();
    running.stillCurrent?.stop();
    running.readBacks?.stop();
    running.judgment.stop();
    this.current = undefined;
    this.logger.log(`[session] ${running.info.id} stopping`);
    running.stop();
    // The UI asked for idle, so say idle now; the drain below is cleanup.
    this.bus.setStatus("transcription", "idle");
    this.bus.setStatus("model", "idle");
    this.bus.setStatus("judgment", "idle");
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
    const wrapUp = this.wrapUp(info, clock, store, voice, () => assembler.streamNow());
    const assembler = this.assembler(info, clock, store, loops, voice, null, wrapUp);
    let source: EventReplaySource;
    try {
      source = this.createReplaySource(fixture, {
        clock,
        speed: this.replaySpeed,
        wallClock: this.wallClock,
      });
    } catch (error) {
      throw new SessionStartError(
        // Not necessarily a fixture path since V3-016: the shadow run's
        // factory reads a past session folder, and its own error says where.
        `cannot replay events for "${fixture}": ${message(error)}`,
        400,
      );
    }

    return {
      info,
      assembler,
      store,
      mic: undefined,
      ...loops,
      greeting: null,
      wrapUp,
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
        .then(() => drainLoops(loops, () => clock.advanceBy(REPLAY_TRAILING_SILENCE_MS), null, wrapUp)),
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
      mic = new MicSource({ clock: this.liveClock });
      // The socket dropping — a refresh, a laptop asleep — holds the session
      // open for `MIC_GRACE_MS` and says so on the dot; it is a dot, not a
      // session event, because the session is still running.
      mic.onConnection = (connected) => {
        if (this.current?.info.id !== info.id) return;
        if (!connected) this.bus.setStatus("transcription", "connecting", MIC_AWAY_DETAIL);
      };
      // The room as the server hears it goes to `audio.wav` (V3-011), so a
      // live session can be replayed, or kept as a take.
      audio = recordedSource(mic, (chunk) => store.writer?.appendAudio?.(chunk));
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
    const greeting = this.greeting(
      info,
      this.liveClock,
      store,
      voice,
      () => assembler.pauseState(),
      () => assembler.streamNow(),
    );
    const wrapUp = this.wrapUp(
      info,
      this.liveClock,
      store,
      voice,
      () => assembler.streamNow(),
    );
    const assembler = this.assembler(info, this.liveClock, store, loops, voice, greeting, wrapUp);
    const client = this.createAsrClient({
      apiKey,
      clock: this.liveClock,
      onFrame: (record) => {
        // The first frame back is the proof the session is really up. A
        // stopped session keeps receiving frames while the API flushes,
        // though, and those must not light the dot again after the UI has
        // been told the session is over.
        // And the API keeps reporting on audio already sent after the mic's
        // socket has dropped, which must not overwrite the cue a reloading
        // page needs in order to dial back in.
        if (this.current?.info.id === info.id) {
          if (mic?.waiting === true) this.bus.setStatus("transcription", "connecting", MIC_AWAY_DETAIL);
          else this.bus.setStatus("transcription", "active", `transcribing ${describeSource(info.source)}`);
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
      greeting,
      wrapUp,
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
        .then(() => drainLoops(loops, undefined, greeting, wrapUp)),
      stopRequested: false,
    };
  }

  private assembler(
    info: SessionInfo,
    clock: Clock,
    store: StoreSlot,
    loops: ModelLoops,
    voice: VoiceOut | null,
    greeting: Greeting | null,
    wrapUp: WrapUp,
  ): SessionTranscription {
    const wake = this.wakeWatcher(info, loops, clock, store, wrapUp);
    /** Labels that have had a final turn, so a new one can be told from a known one. */
    const labelsMet = new Set<string>();
    /** Names introduced inside somebody else's turn, waiting for the voice they belong to. */
    const pendingIntroductions: string[] = [];
    const barge = new BargeIn({
      clock,
      speaking: () => voice?.playback?.().playing === true || this.bus.voiceState().speaking,
      answering: () => (loops.answers?.pending() ?? 0) > 0,
      interrupt: () => {
        // V2-007 on top of V3-004: in practice the first human partial has
        // already yielded, so this mostly records which rule did it.
        loops.reservations?.interrupt();
        return loops.answers?.interrupt() ?? voice?.interrupt?.() ?? Promise.resolve(null);
      },
      command: (asked) => loops.answers?.command(asked),
      onTiming: (record) => store.writer?.appendTiming?.(record),
      onListening: (listening) => {
        this.bus.setListening(listening);
        if (listening) loops.policy?.wakePhraseDetected();
      },
      // V3-006: "Sotto, not now" lands in the quiet after the line it is
      // about, so the command classifier has to be reachable there too.
      unprompted: () => loops.steering?.inWindow() === true,
    });
    return new SessionTranscription({
      clock,
      playback: () => voice?.playback?.() ?? { playing: false, recent: [] },
      logger: this.logger,
      onHuman: (turn, record, duringPlayback) => {
        if (this.current?.info.id !== info.id) return;
        // V3-015: a voice in the room stops anything Sotto is saying unasked,
        // at any point in the utterance — no wake word and no classification.
        // This is the echo-filtered side, so Sotto never yields to itself.
        loops.reservations?.yieldToHuman();
        barge.accept(turn, record, duringPlayback);
      },
      onEvent: (record) => store.writer?.appendEvent(record),
      onEcho: (turn) => {
        wake.ignoreTurn(turn.turnId);
        loops.followUp?.ignoreTurn(turn.turnId);
        if (barge.owns(turn.turnId)) this.bus.setListening(false);
        store.writer?.appendTiming?.({ stage: "self_echo", atMs: clock.now(), ...turn });
        // The last echo can close after playback ended. Re-read the pause
        // without counting Sotto as another human turn toward expiry.
        loops.policy?.playbackChanged();
        loops.researchCards?.playbackChanged();
        loops.reservations?.playbackChanged();
      },
      onUpdate: (turn, suppressTriggers) => {
        if (turn.final) store.writer?.appendTiming?.({ stage: "turn_final", atMs: clock.now(), turnId: turn.turnId, turnStartMs: turn.startMs, turnEndMs: turn.endMs });
        this.bus.publish({ type: "turn", turn });
        // Partials are dropped by all three of these; only final turns are
        // saved, and only final turns can trigger a board update.
        store.writer?.appendTurn(turn);
        if (turn.final && turn.speaker !== null && !turn.speakerMappingUncertain && this.current?.info.id === info.id && !isSottoTurn(turn)) {
          // The service ends a turn on silence, not on a change of voice, so
          // "I'm Craig. I'm EJ." can arrive as one turn under one label: the
          // first name is this speaker's and the rest wait for the next label
          // the session has not met — which is EJ, the moment she speaks alone.
          const [own, ...others] = introducedNames(turn.text);
          const unnamed = this.bus.speakerNames()[turn.speaker] === undefined;
          const unmet = !labelsMet.has(turn.speaker);
          labelsMet.add(turn.speaker);
          if (own !== undefined && unnamed) this.renameSpeaker(turn.speaker, own);
          else if (unmet && unnamed && pendingIntroductions.length > 0) this.renameSpeaker(turn.speaker, pendingIntroductions.shift() as string);
          pendingIntroductions.push(...others);
        }
        // V2-009: who is in the room, and when the room is quiet enough to
        // ask. It skips Sotto's own lines itself.
        greeting?.acceptTurn(turn);
        loops.board?.acceptTurn(turn);
        loops.observer?.acceptTurn(turn);
        // V2-012: the planner's input, and the gate's context. It drops
        // Sotto's own lines itself.
        loops.research?.acceptTurn(turn);
        if (turn.final && loops.board && loops.observer) {
          // The board reads Sotto's own lines (V2-008a) and the observer must
          // not: an interjection arguing with Sotto's last answer is the one
          // contradiction nobody in the room needs pointing out.
          const uncovered = loops.board.uncoveredTurns().filter((one) => !isSottoTurn(one));
          loops.observer.observe(loops.board.board(), uncovered);
        }
        // The policy is the one that wants the partials too: a `speechEnd`
        // arrives as one, and it is what opens a pause (US-014) — and a
        // research card waits for the same pause (V2-014).
        loops.policy?.acceptTurn(turn);
        loops.researchCards?.acceptTurn(turn);
        // And so does a claim waiting for its gap (V3-015), and the answer
        // waiting for a real pause behind it (V3-004).
        loops.reservations?.acceptTurn(turn);
        // V3-004: every later final turn is another look at whether the room
        // still wants an answer that is waiting to be said.
        loops.stillCurrent?.acceptTurn(turn);
        // And so does the wake phrase: the indicator is the point of reading
        // a partial at all (US-017).
        // V2-007 privately owns interrupted commands; ordinary side talk stays suppressed.
        if (suppressTriggers || barge.owns(turn.turnId)) {
          wake.ignoreTurn(turn.turnId);
          loops.address?.remember(turn);
          // Side talk and anything the barge-in owns are context for the next
          // question (V3-002) without being a question themselves.
          loops.questions?.ignoreTurn(turn.turnId);
          loops.questions?.remember(turn);
          // V3-014: the same for the follow-up window. A barge-in's own
          // `new_question` is already on its way to the answer agent, which
          // is what "a barge-in new_question counts as to_sotto" comes to.
          loops.followUp?.ignoreTurn(turn.turnId);
          loops.followUp?.remember(turn);
        } else {
          wake.acceptTurn(turn);
          // V3-002: and whether the room just wondered something aloud. A
          // turn that says Sotto's name is skipped in there, because the
          // address path above already owes it an answer.
          loops.questions?.acceptTurn(turn);
          // V3-014: and whether the room is carrying on talking to Sotto
          // after it answered, which needs no wake word at all.
          loops.followUp?.acceptTurn(turn);
        }
      },
    });
  }

  /**
   * The opening hello and the one nudge for names (V2-009).
   *
   * Live sources only — `mic` and `wav`, as the PRD says. An `events` replay
   * is a conversation that has already happened: there is nobody to say hello
   * to, and the card would reach the eval harness as a delivery the policy
   * never made.
   *
   * It needs no model client: the words are a file, so a session with no
   * `MODEL_API_KEY` still introduces itself.
   */
  private greeting(
    info: SessionInfo,
    clock: Clock,
    store: StoreSlot,
    voice: VoiceOut | null,
    pauseState: () => PauseState,
    streamNow: () => number,
  ): Greeting {
    return new Greeting({
      clock,
      voice,
      streamNow,
      pauseState,
      names: () => this.bus.speakerNames(),
      logger: this.logger,
      onCard: (card) => {
        if (this.current?.info.id === info.id) this.bus.publishCard(card);
      },
      // Not to the board: the hello establishes no fact about the
      // conversation, and V2-009 says to keep it out of the notes. It goes to
      // the transcript like any other line of Sotto's (V2-008a).
      onSpoken: (turn) => this.recordSottoSpeech(info, store, null, turn),
      onTiming: (record) => store.writer?.appendTiming?.(record),
    });
  }

  /**
   * Builds the thing that answers "Sotto, wrap us up" (V2-018).
   *
   * Like the greeting, it says words no model wrote, so it exists whether or
   * not there is a model client — and unlike the greeting it exists for a
   * replay too: a wrap-up is a reply to somebody asking for one, not
   * something Sotto does to a room on its own.
   */
  private wrapUp(
    info: SessionInfo,
    clock: Clock,
    store: StoreSlot,
    voice: VoiceOut | null,
    streamNow: () => number,
  ): WrapUp {
    return new WrapUp({
      clock,
      voice,
      streamNow,
      summary: () => store.digest.spokenSummary(),
      logger: this.logger,
      onCard: (card) => {
        if (this.current?.info.id === info.id) this.bus.publishCard(card);
      },
      // Not to the board: a summary of the notes has nothing to tell them,
      // and reading one back in would be the one loop with no way out.
      onSpoken: (turn) => this.recordSottoSpeech(info, store, null, turn),
      onSaid: (said) => store.digest.spoke(said),
      onTiming: (record) => store.writer?.appendTiming?.(record),
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
    wrapUp: WrapUp,
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
        // "Sotto, wrap us up" (V2-018) is answered from the digest rather
        // than by a model: the material is already in hand, and this is
        // asked for when everybody is standing up. It needs no model client,
        // so it is also the one request a session with no key can answer.
        if (asksForWrapUp(trigger.question)) {
          wrapUp.ask({
            question: trigger.question,
            // The name the group gave the label, as a card and the transcript
            // show it (US-007), not the bare `A`.
            askedBy:
              trigger.speaker === null
                ? null
                : (this.bus.speakerNames()[trigger.speaker] ?? trigger.speaker),
            turnId: trigger.turnId,
          });
          return;
        }
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
      // V3-017: how many things Sotto is holding, which is what lets a turn
      // that is only the name be read as "go on, then".
      raised: () => loops.hand.count(),
      // And the call itself: the newest raised card, read out as it reads.
      // Said under the rules for a question somebody asked out loud, because
      // that is what this is.
      onCallOn: (trigger) => {
        if (!current()) return;
        loops.policy?.wakePhraseDetected();
        const held = loops.hand.latest();
        store.writer?.appendTiming?.({
          stage: "wake_call_on",
          atMs: clock.now(),
          turnId: trigger.turnId,
          raised: loops.hand.count(),
          cardId: held?.cardId ?? null,
        });
        this.logger.log(
          `[wake] ${info.id} ${trigger.turnId} called on Sotto` +
            (held === null ? " with nothing raised" : `: ${held.cardId}`),
        );
        loops.reservations?.calledOn({
          ...(held === null ? {} : { cardId: held.cardId }),
          turnId: trigger.turnId,
          topic: held?.cardId ?? "nothing",
          text: held?.line ?? NOTHING_RAISED_LINE,
        });
      },
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
   * the verifier first, a research hook leaves the interjection path
   * altogether (V2-011), and everything else goes straight to the policy,
   * which decides whether and when it is worth saying. Every candidate, check
   * and decision lands in `candidates.jsonl` on the way past. The answer agent
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
    // Built either way: judgment is its own model (V2-010), and a session
    // with no Muse Spark key can still have Glimmer on this Mac.
    const judgment = this.judgmentRouter(info, model);
    // V3-017: the queue of things Sotto is holding, kept whether or not there
    // is a model — a session with no key notices nothing, so the hand simply
    // stays down.
    const hand = new RaisedHand();
    if (model === null) {
      this.logger.warn(
        `[board] ${info.id} has no model client (MODEL_API_KEY is missing); the board will stay empty`,
      );
      return {
        modelClient: null,
        judgment,
        board: null,
        observer: null,
        verifier: null,
        gate: null,
        policy: null,
        answers: null,
        deliveries: new Map(),
        hand,
        research: null,
        researchRunner: null,
        researchCards: null,
        questions: null,
        followUp: null,
        reservations: null,
        stillCurrent: null,
        readBacks: null,
        steering: null,
      };
    }
    const onModelState = (state: "connecting" | "active" | "error", detail: string): void => {
      if (this.current?.info.id === info.id) this.bus.setStatus("model", state, detail);
    };
    const deliveries = new Map<string, Delivered>();
    /**
     * V3-013: corrections of Sotto's own that a read-back pinned beside a
     * decision, by candidate id, with the decision they bear on.
     *
     * Remembered rather than applied once, because the policy may still be
     * holding the candidate when the decision lands: the card then goes out
     * pinned, rather than going out plain and never catching up.
     */
    const pinnedDecisions = new Map<string, string>();
    const pinToDecision = (candidateId: string, decision: string): void => {
      pinnedDecisions.set(candidateId, decision);
      const cardId = deliveredCardId(candidateId);
      const delivered = deliveries.get(cardId);
      if (delivered === undefined) return;
      const note = decisionNote(decision);
      if (delivered.card.note === note && delivered.card.raised === true) return;
      // Raised and brought forward, open: it is Sotto's question about the
      // thing the room has just decided, which is as prominent as a card
      // gets without anybody being spoken to (V3-008).
      const card: StageCard = { ...delivered.card, raised: true, forward: true, note };
      deliveries.set(cardId, { ...delivered, card });
      hand.observe(card, calledOnCardLine(card), clock.now());
      this.logger.log(`[readback] ${info.id} pinned ${cardId} beside: ${decision}`);
      if (this.current?.info.id === info.id) this.bus.publishCard(card);
    };
    const onTiming = (event: Record<string, unknown>): void => store.writer?.appendTiming?.(event);
    // Every candidate line goes two places: `candidates.jsonl`, and the
    // digest the session ends with (V2-018), which is where "what Sotto
    // almost said" gets its score and its reason.
    const recordCandidate = (record: CandidateLogLine): void => {
      store.writer?.appendCandidate(record);
      store.digest.candidate(record);
      // V3-016: and a third place, the stage's "almost said" tray — the same
      // list, live, so restraint is visible before the digest is written.
      // Against `last` rather than `current`, like an answer card: the
      // policy's final look into the trailing silence happens after Stop, and
      // it is where most of what was held back is accounted for.
      if (this.last?.sessionId === info.id) this.bus.setSuppressed(store.digest.almostSaid());
    };
    // V3-006: the room steering how much Sotto says, by talking to it. Built
    // before everything that feeds it — the policy's deliveries, the
    // reservations' spoken lines and the command classifier all report here —
    // and it only ever moves the frequency, never the boldness.
    const steering = new Steering({
      clock,
      frequency: () => this.currentSettings.frequency,
      // Through the one place a setting changes, so the header, `session.json`
      // and both rationed loops pick it up exactly as a click would.
      setFrequency: (frequency) => {
        if (this.current?.info.id !== info.id) return;
        this.setPolicySettings({ frequency });
      },
      onCard: (card) => {
        if (this.current?.info.id === info.id) this.bus.publishCard(card);
      },
      onTiming,
      logger: this.logger,
    });
    const policy = new InterjectionPolicy({
      clock,
      pauseState,
      // The policy's two settings only: `voiceMuted` is nothing to do with it.
      settings: {
        frequency: this.currentSettings.frequency,
        boldness: this.currentSettings.boldness,
      },
      logger: this.logger,
      onRecord: (record) => { recordCandidate(record); onTiming({ stage: "policy_decision", ...record }); },
      // The stage (US-015). The level the policy chose becomes the card's
      // variant, and the card is kept so a 👍 can find its way back to it.
      //
      // V3-008: everything Sotto notices about the conversation is delivered
      // as a card and nothing else — at every frequency and every boldness —
      // with one exception, which `spokenCorrection` is the whole of: a
      // verified factual error at boldness `bold`, said in one sentence under
      // V3-004's pause, still-current, yield and expiry rules. The card is
      // still shown either way, and `raised` on it (set in
      // `cardForInterjection`) is what V3-017's hand counts.
      onDeliver: (interjection) => {
        this.deliver(info, deliveries, hand, interjection);
        steering.noteContribution();
        // V3-013: a read-back already pinned this one beside a decision while
        // the policy was still holding it, so the card goes out pinned.
        const pinned = pinnedDecisions.get(interjection.candidate.id);
        if (pinned !== undefined) pinToDecision(interjection.candidate.id, pinned);
        onTiming({ stage: "interjection_publish", atMs: clock.now(), candidateId: interjection.candidate.id, published: this.current?.info.id === info.id });
        const line = spokenCorrection(interjection);
        if (line === null) return;
        const candidate = interjection.candidate;
        // Watched before it is queued, so the verdict the pause reads is
        // already there: nothing has been said since the claim, which is
        // `current` with no model call at all.
        stillCurrent.watch(candidate.id, {
          kind: "correction",
          question: correctedClaim(interjection),
          answer: line,
          askedAtMs: candidate.createdAtMs,
        });
        reservations.correction({
          candidateId: candidate.id,
          turnId: candidate.evidence[0]?.turnId ?? candidate.evidenceTurnIds[0] ?? "",
          headline: candidate.headline,
          text: line,
        });
      },
    });
    // The second opinion (V2-016). Every candidate the policy ever sees comes
    // through here, including one the verifier has just checked, so the four
    // numbers the thresholds are applied to are a judge's rather than the
    // proposer's own. `spark` mode hands them straight through.
    const gate = new CandidateGate({
      clock,
      mode: this.gateMode,
      client: () => judgment.client(),
      board: () => board.board(),
      turns: transcript,
      wallClock: this.wallClock,
      logger: this.logger,
      onRecord: (record) => { recordCandidate(record); onTiming({ stage: "candidate_gate", ...record }); },
      // V3-013: and the read-backs, which attach the room's own unsettled
      // question to a decision. The gate having passed it is the PRD's bar
      // for an attachment — whether or not the policy ever delivers a card.
      onScored: (candidate) => {
        readBacks.accept(candidate);
        policy.accept(candidate);
      },
    });
    const verifier = new Verifier({
      clock,
      model,
      logger: this.logger,
      onRecord: (record) => { recordCandidate(record); onTiming({ stage: "verification_complete", ...record }); },
      // A claim that really is wrong has the correction in its detail by now,
      // and goes to the policy like any other candidate — through the gate,
      // which is where "any other candidate" is now defined (V2-016).
      onVerified: (candidate) => gate.accept(candidate),
      onModelState,
    });
    const observer = new Observer({
      clock,
      model,
      logger: this.logger,
      onRecord: (record) => recordCandidate(record),
      // Three destinations. A claim that looks wrong is checked against the
      // web before it can be said to anyone (US-013); a research hook leaves
      // the interjection path altogether for the research gate (V2-012) and
      // is never said to the room at all; and everything else goes straight
      // to the policy.
      onCandidate: (candidate) => {
        if (candidate.type === "research_hook") { research.acceptHook(candidate); onTiming({ stage: "research_hook", atMs: clock.now(), candidateId: candidate.id, headline: candidate.headline }); }
        else if (candidate.type === "factual_error") { onTiming({ stage: "verification_start", atMs: clock.now(), candidateId: candidate.id }); verifier.verify(candidate); }
        else gate.accept(candidate);
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
        store.digest.board(update.board);
        this.bus.publish({
          type: "board",
          board: update.board,
          changedIds: update.changedIds,
          updatedAtMs: update.atMs,
        });
      },
      onModelState,
    });
    // Every line of `research.jsonl`, from either half, mirrored into
    // `timing.jsonl` — minus a packet's own text, which is already in
    // `research.jsonl` and in `research/<id>.md`.
    const onResearch = (record: ResearchLogLine): void => {
      store.writer?.appendResearch(record);
      store.digest.research(record);
      const detail =
        record.kind === "packet"
          ? { ...record, packet: undefined, packetId: record.packet?.id, sources: record.packet?.sources.length ?? 0 }
          : record;
      onTiming({ stage: `research_${record.kind}`, ...detail });
      // V3-006: a card the group did not ask for is an unprompted
      // contribution, so an addressed "that's too much" in the next fifteen
      // seconds is about it. One brought forward (V2-015) or filling in a
      // question's own card (V3-003) was asked for, and is not.
      if (record.kind === "card" && record.broughtForward !== true && record.filledIn !== true) {
        steering.noteContribution();
      }
    };
    // The quiet end of the research pipeline (V2-014): a compact card per
    // packet, shown only in a pause — the policy's own rule, read off the
    // policy's own getter, so Sotto's voice counts as somebody talking — and
    // on a budget of its own. The card is published while this session still
    // owns the stage, which an answer's is too: a search that finishes in the
    // last seconds of a conversation is read after Stop, not before it.
    /**
     * Which card each idea's packet landed on (V3-017), so the hand can come
     * down when the answer to that question is said out loud (V3-004).
     *
     * The card id is not derivable: a question the room wondered aloud fills
     * in the *question's* thinking card rather than taking one of its own
     * (V3-003).
     */
    const researchCardByIdea = new Map<string, string>();
    const researchCards = new ResearchCards({
      clock,
      pauseState,
      // Rationed by the same frequency setting the policy is (V2-017): a
      // group that asked for rare contributions meant all of them.
      limits: limitsFor(this.currentSettings.frequency),
      logger: this.logger,
      onRecord: (record) => onResearch(record),
      onDeliver: (card, packet) => {
        // V3-017: a finished search Sotto has not said out loud is the other
        // half of what the room can call on, read out as the packet's own
        // spoken line. A thinking card and a search that came back with
        // nothing carry no `raised`, so they leave the queue rather than
        // joining it.
        hand.observe(card, packet === null ? "" : calledOnPacketLine(packet), clock.now());
        if (packet !== null) researchCardByIdea.set(packet.ideaId, card.id);
        if (this.last?.sessionId === info.id) this.bus.publishCard(card);
        onTiming({ stage: "research_publish", atMs: clock.now(), packetId: packet?.id ?? null, cardId: card.id, state: card.state, published: this.last?.sessionId === info.id });
      },
    });
    // V3-015: "I'll check the drive time", said at the first gap after the
    // room wonders something aloud. No model call — the words come off the
    // classifier's topic — and one spend against the frequency's cooldown and
    // allowance, because a claim asks for the floor exactly as an
    // interjection does. The answer that follows it (V3-004) is its
    // completion rather than a second contribution.
    // V3-004: whether the room still wants an answer Sotto went and found.
    // One cheap Spark call when the packet lands and after every later final
    // turn, cached — so the instant between noticing a pause and opening an
    // utterance costs no model call, which is the whole point of it.
    const stillCurrent = new StillCurrentWatcher({
      clock,
      // Real time: the latency being recorded is wall-clock work, and a
      // `max`-speed replay's clock stands still inside a model call.
      wallClock: this.wallClock,
      classify: (input, signal) => classifyStillCurrent(model, input, signal),
      speakers: () => this.bus.speakerNames(),
      onTiming,
    });
    const reservations = new Reservations({
      clock,
      voice,
      pauseState,
      streamNow,
      settings: () => policy.settings(),
      allowed: () => policy.unpromptedAllowed(),
      noteContribution: () => policy.noteSpokenContribution(),
      stillCurrent: (ideaId) => stillCurrent.verdict(ideaId),
      // Somebody in the room answered it first (V3-004): nothing is said, and
      // the card carries whether the search agrees with them.
      onAnswered: (ideaId, state) => {
        const packet = researchRunner.packets().find((one) => one.ideaId === ideaId);
        if (packet === undefined) return;
        researchCards.annotate(
          packet,
          state.agrees ? RESEARCH_CONFIRMED_NOTE : RESEARCH_DISAGREES_NOTE,
        );
      },
      // Opening an utterance stops whatever was being said, so a claim waits
      // while Sotto is still writing somebody's answer. The getter closes
      // over the `const` below and is only ever called once a question has
      // been noticed, which is long after this returns.
      answering: () => (answers.pending() ?? 0) > 0,
      onSpoken: (turn) => this.recordSottoSpeech(info, store, null, turn),
      // V3-006: the words have just been handed to the voice, so "during an
      // unprompted contribution" is inside the window too, not only the
      // fifteen seconds after the record is written.
      onSaying: () => steering.noteContribution(),
      onRecord: (record) => {
        onTiming({ ...record });
        // V3-006: everything said here is unprompted, so a line the room
        // actually heard opens the fifteen-second window an addressed "stop"
        // is read inside, and a line a voice in the room cut off is the hint
        // that two of, inside ten minutes, turn Sotto down. Everything but a
        // card the room called for (V3-017), which is an answer to a direct
        // question: neither its "stop" nor its yields are about how much
        // Sotto says unasked.
        if (record.kind !== "called_on") steering.observe(record);
        // V3-004: once the answer has been said, shown or written off, nothing
        // more will be said about this question — so stop paying for a verdict
        // on every remaining final turn. A measured run that left the watcher
        // running made fifty checks about two questions it had already
        // answered on screen.
        if (record.kind === "answer" && record.retrying !== true) {
          stillCurrent.forget(record.ideaId);
        }
        // V3-017: an answer the room heard is no longer something Sotto is
        // holding, so its research card lowers its hand.
        if (record.kind === "answer" && record.spoken) {
          const cardId = researchCardByIdea.get(record.ideaId);
          if (cardId !== undefined) this.lowerHand(info, deliveries, hand, cardId);
        }
        // V3-017: and a card that has just been read out because the room
        // called for it.
        if (record.kind === "called_on" && record.spoken && record.cardId !== undefined) {
          this.lowerHand(info, deliveries, hand, record.cardId);
        }
        // V3-008: a correction Sotto queued and then never said — no pause,
        // cut off twice, the room moved on — is back to being something it is
        // holding, so the hand goes up for it after all.
        if (record.kind === "correction" && record.retrying !== true) {
          stillCurrent.forget(record.ideaId);
          if (!record.spoken) {
            this.raiseHand(info, deliveries, hand, clock.now(), record.ideaId);
          }
        }
        // V3-013: the two limits count what the room really heard, so the
        // read-backs are told what became of each line — and a decision
        // nothing more will be said about needs no further verdicts.
        if (record.kind === "readback") {
          readBacks.observe(record);
          if (record.retrying !== true) stillCurrent.forget(record.ideaId);
        }
      },
      logger: this.logger,
    });
    // V3-013: the scribe's move. A closing decision arrives off V3-002's
    // classifier, the room's own unsettled question is matched to it on
    // words, and the line is said at the next real pause under V3-004's
    // rules. One of Sotto's own corrections is pinned to the stage instead,
    // and only a `bold` session says that one out loud.
    const readBacks = new ReadBacks({
      clock,
      speak: (request) => {
        // Watched before it is queued, so the verdict the pause reads is
        // already there: nothing has been said since the decision, which is
        // `current` with no model call at all.
        stillCurrent.watch(request.id, {
          kind: "decision",
          question: request.decision,
          answer: request.text,
          askedAtMs: clock.now(),
        });
        reservations.readBack(request);
      },
      pinCard: (candidateId, decision) => pinToDecision(candidateId, decision),
      // Whether the room can already see this candidate as a card, which is
      // what decides whether saying its question costs the frequency setting
      // anything (V3-013, following V3-008's rule for a spoken correction).
      delivered: (candidateId) => deliveries.has(deliveredCardId(candidateId)),
      onTiming,
      logger: this.logger,
    });
    // The search (V2-013): one grounded call per approved idea, writing
    // `research/<id>.json`, `research/<id>.md` and any visual into this
    // session's folder. It is handed to the manager as its `run`, so the
    // budget decides when one starts.
    const researchRunner = new ResearchRunner({
      clock,
      model,
      wallClock: this.wallClock,
      logger: this.logger,
      onModelState,
      onRecord: (record) => {
        onResearch(record);
        // V3-003: a question's thinking card has to stop spinning. A search
        // that failed or came back unsourced says so on the card, and V3-015
        // closes the loop out loud — but only to a room that heard Sotto
        // claim the question in the first place.
        if (record.outcome !== "ready") {
          researchCards.failed(record.ideaId);
          reservations.noAnswer(record.ideaId);
        }
      },
      onPacket: (packet, markdown) => {
        store.writer?.writePacket(packet.id, packet, markdown);
        // The one place a packet becomes something the room can see.
        researchCards.accept(packet);
        // V3-004: and, for a question the room wondered aloud, something it
        // can hear. The still-current check starts here rather than at the
        // pause, so that by the time a pause arrives the verdict is cached.
        const asked = reservations.questionFor(packet.ideaId);
        const spoken = packet.spokenAnswer?.trim() ?? "";
        if (asked !== null && spoken !== "") {
          stillCurrent.watch(packet.ideaId, {
            question: asked.question,
            answer: spoken,
            askedAtMs: asked.askedAtMs,
          });
        }
        reservations.answer(packet);
      },
      onArtifact: ({ title, html }) => this.saveArtifact(info, store, title, html),
    });
    // The background half (V2-012): hooks and the planner's own ideas, gated
    // by whichever model judgment runs on, and started a few at a time. It
    // reads the board the same way the observer does and waits for nothing —
    // the gate and the jobs register themselves on the clock, so a replay
    // waits for them without the pipeline ever awaiting them.
    const research = new ResearchManager({
      clock,
      model,
      client: () => judgment.client(),
      board: () => board.board(),
      wallClock: this.wallClock,
      logger: this.logger,
      onModelState,
      onRecord: onResearch,
      run: (idea) => researchRunner.run(idea),
      // V3-003: a question that repeats one already answered is answered from
      // that packet rather than searched for again.
      packets: () => researchRunner.packets(),
    });
    // V3-014: built below, but referenced from the answer agent's
    // `onFinished` — which cannot run before both exist, since the first
    // answer is at least a model call away.
    let followUp: FollowUpWindow | undefined;
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
      // V2-015: the background research is context for every question, and a
      // question that asks for it brings the packets' cards forward on the
      // stage, open, while Sotto briefs the room from them.
      packets: () => researchRunner.packets(),
      onBriefing: (briefed) => researchCards.bringForward(briefed),
      // Published while this session still owns the stage — which it does
      // until the next one starts, not only while it is running: a question
      // typed after Stop (US-019) must put its answer somewhere.
      onCard: (card, answer) => {
        if (this.last?.sessionId === info.id) this.bus.publishCard(card);
        onTiming({ stage: "answer_card", atMs: clock.now(), answerId: answer.id, status: answer.status, hasHeadline: answer.headline !== "", latencyMs: answer.latencyMs, published: this.last?.sessionId === info.id });
      },
      onRecord: (record) => {
        store.writer?.appendAnswer(record);
        store.digest.answer(record);
      },
      // V3-014: Sotto has answered, so for the next few seconds the room can
      // carry on without saying the name. Only while this session still owns
      // the stage — an answer typed after Stop (US-019) has no room to listen
      // to.
      onFinished: (answer) => {
        if (this.current?.info.id !== info.id) return;
        followUp?.answered({
          question: answer.question,
          headline: answer.headline,
          spokenText: answer.spokenText,
        });
      },
      // Generated HTML goes into this session's folder and is served back
      // from it (US-020), so the numbering is per session and so is the URL.
      onArtifact: ({ title, html }) => this.saveArtifact(info, store, title, html),
      // Sotto does not interject over its own answer.
      onThinking: (thinking) => policy.setAnswerThinking(thinking),
      // V3-006: "not now" and "you can jump in more" steer the frequency; a
      // bare "stop" does too, but only when Sotto has just said something
      // unasked — during an answer to a direct question it means this answer.
      onSteer: (command, turnId) => steering.commanded(command, turnId),
      onModelState,
    });
    // V3-002: what the room wonders aloud, noticed per final turn rather than
    // through the observer. V3-003 is what it starts: a search at once, with
    // a card on the stage to say so. V3-015 claims it out loud and V3-004
    // speaks the answer.
    const questions = new QuestionWatcher({
      clock,
      // Real time: the four seconds this story is measured against are
      // seconds the room waited, and a `max` replay's clock stands still
      // inside a model call.
      wallClock: this.wallClock,
      classify: (input, signal) => classifyQuestion(model, input, signal),
      speakers: () => this.bus.speakerNames(),
      onTiming,
      // V3-014: inside the follow-up window the room is talking *to* Sotto,
      // so the turn is the address path's and this one says nothing about it.
      inFollowUpWindow: () => followUp?.isOpen() === true,
      onOpenQuestion: (question) =>
        this.noticeQuestion(info, store, question, research, researchCards, reservations),
      // V3-013: the same call tells us when the group settled something, so
      // the read-back arrives with the turn rather than with the board.
      onDecisionClosing: (closing) => readBacks.closing(closing),
    });
    // V3-014: the window itself. It is built last because it is the only
    // thing here that needs the answer agent, and it needs nothing else.
    followUp = new FollowUpWindow({
      clock,
      // Real time for the latency the room would have felt, as every other
      // classifier does: a `max` replay's clock stands still inside a call.
      wallClock: this.wallClock,
      classify: (input, signal) => classifyFollowUp(model, input, signal),
      speakers: () => this.bus.speakerNames(),
      onTiming,
      onInConversation: (open) => {
        if (this.current?.info.id !== info.id) return;
        this.bus.setInConversation(open);
      },
      // Answered exactly as a question asked by name is, which is also what
      // keeps the floor: the policy holds its own contributions while an
      // answer is being written (US-014).
      onFollowUp: (trigger) => {
        if (this.current?.info.id !== info.id) return;
        store.writer?.appendTiming?.({
          stage: "followup_question", atMs: clock.now(), turnId: trigger.turnId,
        });
        policy.wakePhraseDetected();
        this.logger.log(
          `[followup] ${info.id} ${trigger.turnId} followed up: ${trigger.question}`,
        );
        answers.ask({
          question: trigger.question,
          askedBy: trigger.speaker,
          turnId: trigger.turnId,
        });
      },
    });
    return { modelClient: model, judgment, board, observer, verifier, gate, policy, answers, deliveries, hand, research, researchRunner, researchCards, questions, followUp, reservations, stillCurrent, readBacks, steering };
  }

  /**
   * What happens when the room wonders something aloud (V3-002, V3-003).
   *
   * The question is a record of its own rather than a candidate — it never
   * reaches the observer, the candidate gate or the policy — because it is
   * not something to say, it is something to **look up**. So this is the fast
   * path's one call site: a line in the log, a line in `timing.jsonl`, and
   * the question handed to the research manager, which skips the planner and
   * the gate and searches now.
   *
   * Three things can come back. An accepted question puts a thinking card on
   * the stage at once, which the packet fills in twenty seconds later. The
   * same question asked twice with the answer already in hand brings that
   * packet's card forward instead of paying for the search again. And the
   * same question while the first search is still running stops here: the
   * card it would show is already up.
   */
  private noticeQuestion(
    info: SessionInfo,
    store: StoreSlot,
    question: OpenQuestion,
    research: ResearchManager,
    researchCards: ResearchCards,
    reservations: Reservations | null,
  ): void {
    const started = research.acceptQuestion(question);
    this.logger.log(
      `[question] ${info.id} ${question.turnId} wondered: ${question.question}` +
        ` (${question.topic})` +
        (started === null ? " — the session had stopped" : ` -> ${started.outcome}`),
    );
    store.writer?.appendTiming?.({
      stage: "open_question",
      atMs: question.askedAtMs,
      turnId: question.turnId,
      topic: question.topic,
      question: question.question,
      askedBy: question.askedBy,
      outcome: started?.outcome ?? "stopped",
      ideaId: started?.idea.id ?? null,
    });
    if (started === null) return;
    if (started.outcome === "accepted") {
      researchCards.pending(started.idea);
      // V3-015: and said out loud at the first gap in the next five seconds,
      // so the room knows not to reach for a phone. Only an accepted
      // question: a `reused` one is answered from a packet that already
      // exists, so there is nothing to claim.
      reservations?.claim(started.idea, question);
    }
    // The answer exists already: show it as though they had asked for it,
    // which is what they did (V2-015's own rule, and no second search) — and
    // say it, since the room wondered aloud and Sotto has the answer (V3-004).
    else if (started.outcome === "reused") {
      researchCards.reuse(started.idea, started.packet);
      reservations?.noteQuestion(started.idea, question);
      reservations?.answer(started.packet);
    }
  }

  /**
   * Decides where this session's judgment calls run (V2-010).
   *
   * The check itself is started by {@link SessionManager.start}, after the
   * session is published, so the dot can go from "checking" to `local` or
   * `cloud` while nothing waits. A verdict that lands after this session has
   * gone changes no dot — the same guard every per-callback bus write uses.
   */
  private judgmentRouter(info: SessionInfo, spark: ModelClient | null): JudgmentRouter {
    return new JudgmentRouter({
      glimmer: this.createGlimmer(),
      spark,
      logger: this.logger,
      onWhere: (where) => {
        if (this.current?.info.id !== info.id) return;
        if (where === null) this.bus.setStatus("judgment", "error");
        else this.bus.setStatus("judgment", "active", where);
      },
    });
  }

  /**
   * Writes one line of Sotto's own speech into the conversation (V2-008a).
   *
   * It goes exactly where a human turn goes — the live transcript, the
   * session folder's `transcript.md`, and the board, which reads it labeled
   * `Sotto` so a fact Sotto established can reach the notes. A `null` board is
   * the opening hello (V2-009): it is Sotto's line in the transcript like any
   * other, and it has nothing to tell the notes. It goes nowhere
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
    board: BoardUpdater | null,
    turn: TurnUpdate,
  ): void {
    if (this.last?.sessionId !== info.id) return;
    this.logger.log(
      `[transcript] ${info.id} Sotto said ${turn.text.length} characters` +
        `${turn.interrupted === true ? " before being cut off" : ""}`,
    );
    this.bus.publish({ type: "turn", turn });
    store.writer?.appendTurn(turn);
    board?.acceptTurn(turn);
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
    hand: RaisedHand,
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
    // V3-017: a correction shown and not said is something the room can call
    // on, read out as the card reads.
    hand.observe(card, calledOnCardLine(card), interjection.atMs);
    if (this.current?.info.id === info.id) this.bus.publishCard(card);
  }

  /**
   * A correction Sotto meant to say and did not: put the hand up (V3-008).
   *
   * The card went out with `raised` unset because Sotto was about to speak
   * it, and the sentence was then never said. Published again with the flag —
   * the stage folds a card that arrives twice into the one already there
   * (V2-015), keeping its place and whether it is open, so this changes the
   * hand and nothing else.
   */
  private raiseHand(
    info: SessionInfo,
    deliveries: Map<string, Delivered>,
    hand: RaisedHand,
    atMs: number,
    candidateId: string,
  ): void {
    const cardId = deliveredCardId(candidateId);
    const delivered = deliveries.get(cardId);
    if (delivered === undefined || delivered.card.raised === true) return;
    const card: StageCard = { ...delivered.card, raised: true };
    deliveries.set(cardId, { ...delivered, card });
    hand.observe(card, calledOnCardLine(card), atMs);
    if (this.current?.info.id === info.id) this.bus.publishCard(card);
  }

  /**
   * The hand comes down for one card (V3-017): it has just been said, so the
   * stage is told and the queue forgets it.
   *
   * Republished rather than quietly dropped, because the browser derives the
   * count from the cards it has — and the card itself stays on the stage,
   * which is the whole promise of V3-008.
   */
  private lowerHand(
    info: SessionInfo,
    deliveries: Map<string, Delivered>,
    hand: RaisedHand,
    cardId: string,
  ): void {
    hand.lower(cardId);
    const shown = this.bus.cardState().find((one) => one.id === cardId);
    if (shown === undefined || shown.raised !== true) return;
    const card: StageCard = { ...shown, raised: false };
    const delivered = deliveries.get(cardId);
    if (delivered !== undefined) deliveries.set(cardId, { ...delivered, card });
    if (this.last?.sessionId === info.id) this.bus.publishCard(card);
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
    // "Wrap us up" typed into the box is the same request as the spoken one
    // (V2-018), answered the same way: from the digest, with no model call.
    // Only while the conversation is running, though — once it has ended the
    // wrap-up has stopped talking, and the answer agent can still read the
    // board for whoever asks.
    const running = this.current;
    if (running !== undefined && asksForWrapUp(question)) {
      running.wrapUp.ask({ question: question.trim(), askedBy: TYPED_ASKER, turnId: null });
      return "asked";
    }
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
    running.gate?.stop();
    running.policy?.stop();
    running.address?.stop();
    running.questions?.stop();
    running.followUp?.stop();
    running.greeting?.stop();
    running.research?.stop();
    running.reservations?.stop();
    running.stillCurrent?.stop();
    running.readBacks?.stop();
    running.wrapUp.stop();
    running.judgment.stop();
    // Not `running.answers`: a question typed after Stop is answered against
    // the conversation that just ended (US-019), so the agent is only
    // retired when the next session supersedes it.
    // The digest is the last thing written (V2-018): every section of it is
    // about the whole conversation, and by here every loop has drained.
    running.store.writer?.writeDigest(running.store.digest.render());
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
      this.bus.setStatus("judgment", "idle");
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
async function drainLoops(
  loops: ModelLoops,
  beforePolicy?: () => void,
  greeting?: Greeting | null,
  wrapUp?: WrapUp,
): Promise<void> {
  // The hello is usually long finished; a session stopped two seconds in is
  // the case this covers, so its line still reaches the transcript.
  await greeting?.flush();
  // A wrap-up asked for in the last seconds is still being said, and its
  // line belongs in the transcript it is about.
  await wrapUp?.flush();
  await loops.address?.flush();
  // Before the research manager: a question wondered aloud in the last
  // seconds is still a question, and V3-003 turns the verdict into a search.
  await loops.questions?.flush();
  // A claim being said as the conversation stops still belongs in the
  // transcript it was said into (V3-015).
  await loops.reservations?.flush();
  await loops.board?.flush();
  await loops.observer?.flush();
  await loops.verifier?.flush();
  // After the verifier, because a checked claim reaches the gate rather than
  // the policy (V2-016), and the gate is the last thing between a candidate
  // and the policy's final look.
  await loops.gate?.flush();
  // After the observer, because its last look is where the last hooks come
  // from: every idea gets its gate verdict written down even though nothing
  // will be searched now. The planner does not take a final look (V2-012).
  await loops.research?.flush();
  // And the claims again: the last packet out of that flush may have had an
  // answer worth saying (V3-004), and whatever gets said belongs in the
  // transcript it was said into.
  await loops.reservations?.flush();
  // A follow-up said in the last seconds still needs its verdict, and the
  // verdict is what puts the answer in the queue below (V3-014).
  await loops.followUp?.flush();
  // An answer asked in the last seconds of a conversation is still owed to
  // whoever asked for it, and the policy must not be left thinking one is
  // still being written.
  await loops.answers?.flush();
  beforePolicy?.();
  // Everything the searches found goes up now, pause or no pause: a packet is
  // about the world rather than about a moment, and the stage is read after
  // Stop (V2-014).
  loops.researchCards?.flush();
  // Last, and synchronous: the conversation has ended in silence, so the
  // policy gets one look at that final pause and then accounts for whatever
  // is still waiting.
  loops.policy?.flush();
  // V3-008: that last look is where a correction a `bold` session may say out
  // loud comes from, and the silence a conversation ends in is a real pause —
  // so the line, and the transcript row for it, still happen.
  await loops.reservations?.flush();
  // V3-006: a command classified after this cannot change a setting the next
  // conversation starts with.
  loops.steering?.stop();
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
