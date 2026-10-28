/**
 * The observer: noticing things worth raising (PRD US-012).
 *
 * It runs **right after each board update** (US-009), because that is the
 * moment the conversation has just been organized: the board holds what the
 * group stated and decided, which is what a contradiction collides with and
 * where a dropped thread sits, so the observer gets the memory for free and
 * costs one model call per board update rather than one per turn.
 *
 * Every candidate it gets back is written to `candidates.jsonl` before
 * anything decides what to do with it — the file is the record of what Sotto
 * noticed, not only of what it said — and then the ones that are not repeats
 * of something already raised are handed on to the policy (US-014).
 *
 * Like the board loop, only one call is ever in flight, the whole cycle is
 * wrapped in {@link Clock.track} so a `max`-speed replay stops at it, and a
 * failed call puts its turns back rather than losing them.
 */
import {
  MAX_CANDIDATES_PER_RUN,
  OBSERVER_SCHEMA_NAME,
  ObserverCandidateSchema,
  ObserverReplySchema,
  observerCandidatesJsonSchema,
  type Candidate,
  type CandidateLogRecord,
  type ObserverCandidate,
} from "../../shared/candidates.js";
import type { Board, Item } from "../../shared/board.js";
import { boardSections } from "../../shared/board.js";
import type { TurnUpdate } from "../../shared/turns.js";
import type { Clock } from "../clock.js";
import { ModelCallError, type ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";

/** How many final turns are marked as "what they are talking about now". */
export const CURRENT_TOPIC_TURNS = 3;

/** The label the cycle is tracked under on the clock, and in the model logs. */
export const OBSERVER_TRACK_LABEL = "observer";

/** How many already-raised candidates the request lists back to the model. */
export const RAISED_HISTORY = 10;

/**
 * Two candidates of the same type whose headlines share at least this much of
 * their vocabulary are the same thought in different words.
 */
export const HEADLINE_OVERLAP = 0.6;

type Logger = Pick<Console, "log" | "warn">;

export interface ObserverOptions {
  /** The session's clock — simulated for a replay, real for a live session. */
  clock: Clock;
  model: ModelClient;
  /**
   * Records one candidate, duplicate or not. Called for every candidate
   * before {@link ObserverOptions.onCandidate} is called for any of them, so
   * `candidates.jsonl` is always ahead of the policy.
   */
  onRecord: (record: CandidateLogRecord) => void;
  /** Hands on a candidate that is not a repeat. The policy's input (US-014). */
  onCandidate: (candidate: Candidate) => void;
  /** The model status dot, shared with the board loop. */
  onModelState?: (state: "connecting" | "active" | "error", detail: string) => void;
  logger?: Logger;
}

export class Observer {
  private readonly clock: Clock;
  private readonly model: ModelClient;
  private readonly onRecord: (record: CandidateLogRecord) => void;
  private readonly onCandidate: (candidate: Candidate) => void;
  private readonly onModelState: ObserverOptions["onModelState"];
  private readonly logger: Logger;

  /** Every final turn so far, oldest first; the current topic is its tail. */
  private readonly turns: TurnUpdate[] = [];
  /** Final turns the observer has not looked at yet. */
  private pending: TurnUpdate[] = [];
  /** Candidates already passed on, oldest first: the duplicate check's memory. */
  private readonly raised: Candidate[] = [];
  /** The board as of the most recent update, waiting to be looked at. */
  private nextBoard: Board | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private runCount = 0;
  private candidateCount = 0;

  constructor(options: ObserverOptions) {
    this.clock = options.clock;
    this.model = options.model;
    this.onRecord = options.onRecord;
    this.onCandidate = options.onCandidate;
    this.onModelState = options.onModelState;
    this.logger = options.logger ?? console;
  }

  /** How many observer runs have completed. */
  runs(): number {
    return this.runCount;
  }

  /** The candidates passed on to the policy, oldest first. */
  passed(): readonly Candidate[] {
    return this.raised;
  }

  /**
   * Takes one turn snapshot. Partials are ignored: the observer reasons about
   * what people finished saying, as the board does.
   */
  acceptTurn(turn: TurnUpdate): void {
    if (this.stopped || !turn.final) return;
    this.turns.push(turn);
    this.pending.push(turn);
  }

  /**
   * Looks at the conversation, with the board as it stands after an update.
   *
   * Returns as soon as a cycle is under way — the board loop must not wait on
   * the observer — but the call is tracked on the clock, so a `max`-speed
   * replay does.
   */
  observe(board: Board): void {
    if (this.stopped) return;
    this.nextBoard = board;
    if (this.running !== undefined) return;
    this.running = this.clock.track(OBSERVER_TRACK_LABEL, this.cycle());
  }

  /** Waits for the cycle in flight, and for anything it queued behind it. */
  async flush(): Promise<void> {
    while (this.running !== undefined) await this.running;
  }

  /** No more runs. Idempotent. */
  stop(): void {
    this.stopped = true;
  }

  /** Runs looks back to back for as long as board updates keep arriving. */
  private async cycle(): Promise<void> {
    try {
      while (this.nextBoard !== undefined && !this.stopped) {
        const board = this.nextBoard;
        this.nextBoard = undefined;
        await this.runOnce(board);
      }
    } finally {
      this.running = undefined;
    }
  }

  private async runOnce(board: Board): Promise<void> {
    const newTurns = this.pending;
    this.pending = [];
    // The current topic is the tail of the whole conversation, not of the new
    // turns: right after a slow stretch there may be only one new turn.
    const topic = this.turns.slice(-CURRENT_TOPIC_TURNS);
    this.onModelState?.("connecting", "looking for something worth saying");

    let candidates: ObserverCandidate[];
    try {
      candidates = await this.request(board, newTurns, topic);
    } catch (error) {
      const detail = message(error);
      this.logger.warn(`[observer] run ${this.runCount + 1} failed: ${detail}`);
      this.onModelState?.("error", detail);
      // Never looked at, so they go back at the front for the next board
      // update to bring along.
      this.pending = [...newTurns, ...this.pending];
      return;
    }

    this.runCount += 1;
    const atMs = this.clock.now();
    if (candidates.length > MAX_CANDIDATES_PER_RUN) {
      this.logger.warn(
        `[observer] run ${this.runCount} returned ${candidates.length} candidates; keeping the first ${MAX_CANDIDATES_PER_RUN}`,
      );
      candidates = candidates.slice(0, MAX_CANDIDATES_PER_RUN);
    }

    // Every candidate is written down first, duplicates included, so nothing
    // downstream can act on something the file does not know about.
    const identified = candidates.map((candidate) => this.identify(candidate, atMs));
    for (const candidate of identified) {
      this.onRecord({ kind: "candidate", atMs, candidate });
    }
    this.logger.log(
      `[observer] run ${this.runCount}: ${identified.length} candidate(s) from ${newTurns.length} turns` +
        summarize(identified),
    );
    for (const candidate of identified) {
      if (candidate.duplicateOf !== undefined) continue;
      this.raised.push(candidate);
      this.onCandidate(candidate);
    }
    this.onModelState?.("active", "model client ready");
  }

  /**
   * Gives a candidate its id and marks it as a repeat if it is one.
   *
   * Duplicates are checked against what has already been *passed on*, and
   * within a reply against the candidates ahead of it, so a model that says
   * the same thing twice in one breath only gets through once.
   */
  private identify(candidate: ObserverCandidate, atMs: number): Candidate {
    this.candidateCount += 1;
    const duplicateOf = findDuplicate(candidate, this.raised);
    const identified: Candidate = {
      ...candidate,
      id: `cand-${this.candidateCount}`,
      createdAtMs: atMs,
      run: this.runCount,
      ...(duplicateOf === undefined ? {} : { duplicateOf }),
    };
    if (duplicateOf !== undefined) {
      this.logger.log(
        `[observer] ${identified.id} repeats ${duplicateOf}: ${identified.headline}`,
      );
    }
    return identified;
  }

  /** One call, with each candidate validated on its own. */
  private async request(
    board: Board,
    newTurns: readonly TurnUpdate[],
    topic: readonly TurnUpdate[],
  ): Promise<ObserverCandidate[]> {
    const reply = await this.model.structured({
      label: OBSERVER_TRACK_LABEL,
      system: loadPrompt(PROMPTS.observer),
      user: renderObserverRequest(board, newTurns, topic, this.raised),
      schemaName: OBSERVER_SCHEMA_NAME,
      schema: observerCandidatesJsonSchema,
    });
    const parsed = ObserverReplySchema.safeParse(reply);
    if (!parsed.success) {
      throw new ModelCallError(
        `observer reply did not match the schema: ${issues(parsed.error.issues)}`,
      );
    }
    const candidates: ObserverCandidate[] = [];
    for (const [index, raw] of parsed.data.candidates.entries()) {
      // A candidate the model got wrong is dropped on its own; the ones beside
      // it are perfectly good.
      const one = ObserverCandidateSchema.safeParse(raw);
      if (!one.success) {
        this.logger.warn(`[observer] ignored candidate ${index}: ${issues(one.error.issues)}`);
        continue;
      }
      candidates.push(one.data);
    }
    return candidates;
  }
}

/**
 * Whether `candidate` repeats one of `earlier`, and which.
 *
 * Two kinds of repeat count, both from the PRD: the same type pointing at an
 * overlapping set of board items, and the same type with a headline that says
 * the same thing. The second is measured on content words rather than judged
 * by a model, because an extra call per candidate to find out that the
 * observer said "the budget doesn't fit" twice is not worth making.
 */
export function findDuplicate(
  candidate: ObserverCandidate,
  earlier: readonly Candidate[],
): string | undefined {
  const items = new Set(candidate.relatedBoardItemIds);
  const words = contentWords(candidate.headline);
  for (const previous of earlier) {
    if (previous.type !== candidate.type) continue;
    if (previous.relatedBoardItemIds.some((id) => items.has(id))) return previous.id;
    if (overlap(words, contentWords(previous.headline)) >= HEADLINE_OVERLAP) return previous.id;
  }
  return undefined;
}

/** Words of a headline worth comparing: lowercased, unpunctuated, not filler. */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does", "doesn't", "for",
  "from", "has", "have", "in", "is", "isn't", "it", "its", "no", "not", "of", "on", "or", "our",
  "that", "the", "their", "them", "there", "they", "this", "to", "was", "we", "what", "which",
  "will", "with", "won't", "you", "your",
]);

function contentWords(headline: string): Set<string> {
  const words = headline
    .toLowerCase()
    .replace(/[^a-z0-9$%'\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !STOP_WORDS.has(word));
  return new Set(words);
}

/** Jaccard overlap of two word sets; 1 when identical, 0 when disjoint. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * The user message for one look: the board, what has already been raised, the
 * transcript since the last look, and the current topic.
 *
 * The already-raised list is what `novelty` is scored against and the first
 * line of defence against repeating a point — the duplicate check behind it
 * catches what gets through. Turn ids are printed exactly as the assembler
 * made them, because `evidenceTurnIds` are resolved downstream by string
 * match.
 */
export function renderObserverRequest(
  board: Board,
  newTurns: readonly TurnUpdate[],
  topic: readonly TurnUpdate[],
  raised: readonly Candidate[],
): string {
  const blocks = ["## The board right now", renderBoard(board)];
  if (raised.length > 0) {
    blocks.push(
      "## Already raised",
      "You have said these. Do not raise them again, in any wording.",
      raised
        .slice(-RAISED_HISTORY)
        .map((candidate) => `- (${candidate.type}) ${candidate.headline}`)
        .join("\n"),
    );
  }
  blocks.push(
    "## The transcript since you last looked",
    newTurns.length === 0 ? "_nothing new_" : newTurns.map(renderTurn).join("\n"),
  );
  if (topic.length > 0) {
    blocks.push(
      "## The current topic",
      "The last few turns again. This is what they are talking about right now.",
      topic.map(renderTurn).join("\n"),
    );
  }
  blocks.push(
    "Reply with the candidates worth raising. An empty list is the usual answer.",
  );
  return blocks.join("\n\n");
}

/**
 * The board as lines rather than JSON: the observer only needs to read it and
 * cite ids, and prose costs a third of the tokens the board request's JSON
 * does.
 */
function renderBoard(board: Board): string {
  const lines = [board.summary.trim() === "" ? "_no summary yet_" : board.summary.trim()];
  for (const section of boardSections) {
    const items = board[section].filter((item) => item.status !== "dropped");
    if (items.length === 0) continue;
    lines.push(`### ${section}`, items.map(renderItem).join("\n"));
  }
  return lines.join("\n\n");
}

function renderItem(item: Item): string {
  return `- [${item.id}] ${item.text}${item.status === "open" ? "" : ` (${item.status})`}`;
}

/** `[0:7] A (01:23): text` — the id first, since that is what gets copied back. */
function renderTurn(turn: TurnUpdate): string {
  return `[${turn.turnId}] ${turn.speaker ?? "?"} (${stamp(turn.startMs)}): ${turn.text.replace(/\s+/g, " ").trim()}`;
}

function stamp(offsetMs: number): string {
  const seconds = Math.max(0, Math.round(offsetMs / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** `: contradiction (0.72), untested_assumption (duplicate)` for the log. */
function summarize(candidates: readonly Candidate[]): string {
  if (candidates.length === 0) return "";
  const parts = candidates.map((candidate) =>
    candidate.duplicateOf === undefined
      ? `${candidate.type} (c ${candidate.scores.confidence.toFixed(2)})`
      : `${candidate.type} (duplicate of ${candidate.duplicateOf})`,
  );
  return `: ${parts.join(", ")}`;
}

function issues(list: readonly { path: PropertyKey[]; message: string }[]): string {
  return list.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
