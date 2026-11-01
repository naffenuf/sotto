/**
 * What `npm run e2e` observes and reports (PRD US-021).
 *
 * The end-to-end check is the only thing in the project that drives the whole
 * loop from *audio* against the real APIs: five fixture WAVs streamed at
 * real-time pace into the real transcription, the real board, observer,
 * verifier, policy, research pipeline, answer agent and voice, and the real
 * session folder. Everything else either replays captured events
 * (`npm run eval`, the integration tests) or fakes a seam.
 *
 * So these are the shapes of what one run saw. They are deliberately split in
 * three — what came over the bus ({@link E2eObserved}), what landed on disk
 * ({@link E2eFiles}), and what was made of the two ({@link E2eCheck},
 * {@link E2eLatency}) — because only the first two need a network, and
 * everything that decides whether the run passed is a pure function of them.
 */
import type { AnswerLogRecord } from "./answers.js";
import type { Board } from "./board.js";
import type { DecisionLogRecord } from "./candidates.js";
import type { StageCard } from "./cards.js";
import type { MomentRecord, RunTokenUsage, SpokenRecord } from "./eval.js";
import type { ResearchLogLine } from "./research.js";
import type { SpokenContributionKind, SpokenContributionRecord } from "./spoken.js";
import type { SessionRecord } from "./session.js";
import type { TurnUpdate } from "./turns.js";

/**
 * The conversation V2-021 added: the one with background research in it.
 *
 * Named, because three things key off it — the checks it gets, the latencies
 * worth printing for it, and the budget, since three web searches and a
 * spoken briefing cost several times what the core four do.
 */
export const RESEARCH_FIXTURE = "research-business-idea";

/**
 * The conversation V3-003 added: the one where the room wonders something
 * aloud.
 *
 * Named for the same reason {@link RESEARCH_FIXTURE} is. The fast path's
 * target — a question going final to a packet being ready — is a latency, and
 * the max-speed eval cannot measure a latency: simulated time stands still
 * inside a model call. This is the fixture that charges real seconds for it.
 */
export const QUESTION_FIXTURE = "offsite-plan";

/**
 * The conversations the check drives, in the order it runs them.
 *
 * The two long ones first: `brainstorm` is where a false interjection shows
 * up and `moment-contradiction` is where a real one has to, and both are
 * cheaper to diagnose before an answer has been paid for.
 * {@link RESEARCH_FIXTURE} runs last for the same reason, from the other end:
 * it is three minutes of audio, three web searches and a spoken briefing, so
 * it is the one worth reaching with everything else already known good.
 * {@link QUESTION_FIXTURE} is second to last on the same logic.
 */
export const E2E_FIXTURES = [
  "brainstorm",
  "moment-contradiction",
  "ask-search",
  "ask-diagram",
  QUESTION_FIXTURE,
  RESEARCH_FIXTURE,
] as const;

/**
 * One thing that reached the browser, with the wall-clock moment it did.
 *
 * The wall clock is the only timeline the two halves of a latency share. A
 * turn's `startMs`/`endMs` are offsets into the audio stream (US-008), while a
 * card's `createdAtMs` is read off the live `Clock`, whose origin is the
 * process rather than the session — so "the trigger line was transcribed at
 * X and the card appeared at Y" can only be subtracted here.
 */
export interface Stamped<T> {
  value: T;
  /** Milliseconds since {@link E2eObserved}'s session was started. */
  atMs: number;
}

/** What one live run of one fixture put on the event bus. */
export interface E2eObserved {
  fixture: string;
  /** Every final turn, in the order it went final. */
  turns: Stamped<TurnUpdate>[];
  /** Every card push, in arrival order: a card arrives more than once. */
  cards: Stamped<StageCard>[];
  /** When the wake indicator went up (US-017). */
  wakeAtMs: number[];
  /** How many board updates were pushed (US-009). */
  boardPushes: number;
  /** Seconds of audio streamed to the transcription API, for the bill. */
  audioSeconds: number;
  /** Anything that put a status dot into `error`. */
  errors: string[];
  sessionDir: string | null;
  /** Wall-clock length of the run, start to the session ending. */
  elapsedMs: number;
  /** What Sotto handed to the voice, which is what ElevenLabs bills per. */
  voice: VoiceSpend;
  /**
   * Sotto's own lines in the transcript (V2-008a), with when each was pushed.
   *
   * One of these exists only because something reported *playing* the
   * utterance: it is written at playback start and carries the text that was
   * heard. So it is the evidence that the spoken-so-far tracking worked, which
   * is why it is kept apart from {@link turns} rather than counted among them.
   */
  sottoTurns: Stamped<TurnUpdate>[];
  /** Set when the session could not be started or run at all. */
  error?: string;
}

/** The session folder (US-008) read back after the run. */
export interface E2eFiles {
  session: SessionRecord | null;
  /** Lines in `transcript.md`. */
  transcriptLines: number;
  /** Lines in `events.jsonl`: raw transcription frames. */
  events: number;
  board: Board | null;
  boardMarkdown: string;
  answers: AnswerLogRecord[];
  /** The decisions that delivered a card, by candidate id (US-014). */
  decisions: Record<string, DecisionLogRecord>;
  /** How many candidates the observer filed. */
  candidates: number;
  /** File names in `artifacts/` (US-020). */
  artifacts: string[];
  /** Those files' HTML, by file name: one check reads the document itself. */
  artifactHtml: Record<string, string>;
  /** `research.jsonl`, parsed: the ideas, the verdicts and the packets (V2-021). */
  research: ResearchLogLine[];
  /**
   * The `spoken_contribution` lines of `timing.jsonl` (V3-010).
   *
   * The only record of what Sotto said unasked and of what it decided against
   * saying, which is why the end-to-end check reads it: this is the one clock
   * that charges a spoken line for the seconds it waited.
   */
  spoken: SpokenContributionRecord[];
  /** File names in `research/`: one `.json` and one `.md` per packet (FR-V9). */
  researchFiles: string[];
}

/** One assertion, and why it came out that way. */
export interface E2eCheck {
  name: string;
  ok: boolean;
  /** Short enough for a terminal line; it is the whole failure message. */
  detail: string;
}

/** How long a planted moment took to reach the stage. */
export interface MomentLatency {
  momentId: string;
  /** Wall-clock ms from the trigger line being transcribed to the card. */
  deliveredAfterMs: number | null;
  /** Whether the card landed before the deadline line finished. */
  beforeDeadline: boolean | null;
}

/** The latencies the story asks to be printed. */
export interface E2eLatency {
  /** Wake phrase heard → a headline on the stage. */
  wakeToHeadlineMs: number | null;
  /** Wake phrase heard → the answer finished. */
  wakeToDoneMs: number | null;
  /**
   * The question arriving → the acknowledgment's first audio, in **real**
   * milliseconds (V2-021), off `answers.jsonl`.
   *
   * `null` when nothing was acknowledged out loud, which is the normal case
   * for a briefing: a question Sotto has already done the work for skips both
   * the acknowledgment and the holding line and goes straight to speech
   * (V2-015), so {@link firstAudioMs} is the number that says it answered.
   */
  ackMs: number | null;
  /** The question arriving → the first audio of the answer itself, in real ms. */
  firstAudioMs: number | null;
  moments: MomentLatency[];
  /** What became of each moment Sotto was meant to speak about (V3-010). */
  spokenMoments: SpokenMomentOutcome[];
}

/**
 * One planted `speak` moment, as a live run scored it (V3-010).
 *
 * Structural rather than judged, like every other end-to-end assertion: the
 * line Sotto said about this moment is the one whose question turn is one of
 * the moment's own, which is the same rule {@link MomentLatency} uses for a
 * card. Everything here is on the transcription stream's timeline, because
 * that is the only clock a spoken line and a scripted line share — Sotto's
 * transcript row carries stream time and a planted window is resolved from
 * the turns the script's lines produced.
 */
export interface SpokenMomentOutcome {
  momentId: string;
  /** The spoken line that caught it, or `null` if nothing was said about it. */
  spokenId: string | null;
  kind: SpokenContributionKind | null;
  /** The trigger turn's end to Sotto's first word. */
  afterTriggerMs: number | null;
  /** Whether it landed before the deadline line finished. */
  beforeDeadline: boolean | null;
  /** The same for the claim Sotto made first, if it made one (V3-015). */
  reservedAfterMs: number | null;
}

/**
 * What Sotto said out loud, counted the way ElevenLabs bills it (V2-021).
 *
 * Characters *handed to* the voice rather than characters heard: a cancelled
 * utterance was still synthesized and is still on the invoice.
 */
export interface VoiceSpend {
  /** Utterances opened on the socket: a hello, an acknowledgment, an answer. */
  utterances: number;
  characters: number;
}

/**
 * What the research pipeline did in one live run (V2-021), off
 * `research.jsonl` and the stage.
 *
 * Two of the three outcomes never become a card — a `rejected` idea never
 * searches and an `unsourced` packet is discarded (V2-013) — so the counts
 * come from the log, and only the cards come from the bus, which is where
 * "before the wake question" can be measured.
 */
export interface E2eResearch {
  /** Ideas the session thought of, duplicates included. */
  ideas: number;
  /** Ideas the gate let through, turned down, and could not score. */
  queued: number;
  rejected: number;
  gateFailed: number;
  /** Gate verdicts that ran on the local model (V2-010), billed at nothing. */
  localGateCalls: number;
  /** Sourced packets: searches that produced something showable. */
  packets: number;
  /** Packets discarded for having no source the search really returned. */
  unsourced: number;
  /** Searches that did not come back at all. */
  failed: number;
  /** Wall-clock arrival of each research-ready card's first push, oldest first. */
  cardAtMs: number[];
  /**
   * The fast path's end-to-end latency, one per finished job the room asked
   * for out loud (V3-003), oldest first.
   *
   * Session-clock milliseconds from the question turn going final to the job
   * finishing, read straight off `research.jsonl`. This is the only clock in
   * the project that charges a search for the time it takes, which is why the
   * PRD's 25-second target is measured here and not in `npm run eval`.
   */
  questionToPacketMs: number[];
}

/** Everything one fixture's run produced. */
export interface E2eFixtureReport {
  fixture: string;
  sessionDir: string | null;
  elapsedMs: number;
  audioSeconds: number;
  finalTurns: number;
  /** Distinct cards that reached the stage, not pushes. */
  cards: number;
  candidates: number;
  checks: E2eCheck[];
  latency: E2eLatency;
  moments: MomentRecord[];
  /** What the research pipeline did (V2-021). All zeros for most fixtures. */
  research: E2eResearch;
  /** Every unprompted line, placed in the conversation (V3-010). */
  spoken: SpokenRecord[];
  /** What was spoken, and what it is billed as (V2-021). */
  voice: VoiceSpend;
  /**
   * What this conversation's own model calls spent (V2-021).
   *
   * Per fixture rather than only per run, because the conversations differ by
   * several times — one that searches resends its whole request each round —
   * and "which one is expensive" is the question a reader has.
   */
  usage: RunTokenUsage;
  error?: string;
}

/** The whole run, and what it cost. */
export interface E2eRunReport {
  id: string;
  fixtures: E2eFixtureReport[];
  /** What the model calls spent. */
  usage: RunTokenUsage;
  /** Audio sent to the transcription API across every fixture. */
  audioSeconds: number;
  modelCostUsd: number;
  asrCostUsd: number;
  /** Characters handed to ElevenLabs across every fixture (V2-021). */
  ttsCharacters: number;
  ttsCostUsd: number;
  totalCostUsd: number;
  /** Every check passed, every fixture ran, and the cost stayed under budget. */
  passed: boolean;
}
