/**
 * What `npm run e2e` observes and reports (PRD US-021).
 *
 * The end-to-end check is the only thing in the project that drives the whole
 * loop from *audio* against the real APIs: four fixture WAVs streamed at
 * real-time pace into the real transcription, the real board, observer,
 * verifier, policy and answer agent, and the real session folder. Everything
 * else either replays captured events (`npm run eval`, the integration tests)
 * or fakes a seam.
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
import type { MomentRecord, RunTokenUsage } from "./eval.js";
import type { SessionRecord } from "./session.js";
import type { TurnUpdate } from "./turns.js";

/**
 * The conversations the check drives, in the order it runs them.
 *
 * The two long ones first: `brainstorm` is where a false interjection shows
 * up and `moment-contradiction` is where a real one has to, and both are
 * cheaper to diagnose before an answer has been paid for.
 */
export const E2E_FIXTURES = [
  "brainstorm",
  "moment-contradiction",
  "ask-search",
  "ask-diagram",
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

/** The three latencies the story asks to be printed. */
export interface E2eLatency {
  /** Wake phrase heard → a headline on the stage. */
  wakeToHeadlineMs: number | null;
  /** Wake phrase heard → the answer finished. */
  wakeToDoneMs: number | null;
  moments: MomentLatency[];
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
  totalCostUsd: number;
  /** Every check passed, every fixture ran, and the cost stayed under budget. */
  passed: boolean;
}
