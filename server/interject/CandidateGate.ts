/**
 * The judgment gate in front of the policy (PRD V2-016).
 *
 * The observer proposes candidates *and* scores them, which is a model
 * marking its own homework: having just decided something is worth raising,
 * it is the worst available judge of whether it is. So every candidate on its
 * way to the policy stops here and a second model answers the four questions
 * that actually decide it — true, new, worth saying, still relevant — and
 * those answers replace the observer's own four
 * ({@link scoresFromGate} maps them). The observer's stay on the candidate
 * and in `candidates.jsonl`, so a report can say what the second opinion
 * changed.
 *
 * It is a **judgment call** (V2-010), so it goes to Muse Glimmer on this Mac
 * when there is one and to Muse Spark when there is not. Private, free, and
 * nobody is waiting out loud — but somebody *is* waiting: a candidate is
 * about a moment that is passing, and the gate's seconds come out of the few
 * the policy has to find a pause in. That is why this is the one judgment
 * call made at `low` reasoning effort with the smallest context that can
 * answer it, and why the eval measures its latency
 * (`npm run eval -- --gate glimmer`).
 *
 * Unlike the research gate, a call that does not come back is **not** a
 * rejection: the candidate goes on with the observer's own scores, which is
 * exactly the behaviour the gate replaced. Losing the gate should cost
 * judgment, not speech. Checks run concurrently and each is registered with
 * {@link Clock.track} before {@link CandidateGate.accept} returns, the way
 * the verifier's are, so a `max`-speed replay still stops for all of them.
 */
import type { Board, Item } from "../../shared/board.js";
import { boardSections } from "../../shared/board.js";
import {
  CANDIDATE_GATE_SCHEMA_NAME,
  CandidateGateReplySchema,
  DEFAULT_GATE_MODE,
  candidateGateJsonSchema,
  type Candidate,
  type CandidateGateLogRecord,
  type CandidateGateWhere,
  type GateMode,
  type GateScores,
} from "../../shared/candidates.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { systemClock, type Clock } from "../clock.js";
import { ModelCallError } from "../model/client.js";
import type { JudgmentClient } from "../model/judgment.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";
import { candidateScore, scoresFromGate } from "./policy.js";

/** Re-exported so the gate's vocabulary can be imported from the gate. */
export { DEFAULT_GATE_MODE, type GateMode };

/** The label a gate call is tracked under on the clock, and in the model logs. */
export const CANDIDATE_GATE_TRACK_LABEL = "gate";

/**
 * Reasoning + output budget for one gate call.
 *
 * Four numbers is a tiny reply, so this is all reasoning headroom. Measured
 * at 180 completion tokens on Glimmer at `low` effort for the research gate's
 * three; Muse Spark spends 1,300–3,200 on a short structured prompt. Unused
 * budget is not billed and costs no time, while a truncated reply loses the
 * verdict and the candidate falls back to the observer's scores.
 */
export const CANDIDATE_GATE_MAX_TOKENS = 4_096;

/** How many of the latest turns the gate reads as "where they are now". */
export const GATE_CONTEXT_TURNS = 6;

/** How many of a candidate's evidence quotes are shown. The point rests on these. */
export const GATE_EVIDENCE_QUOTES = 4;

type Logger = Pick<Console, "log" | "warn">;

export interface CandidateGateOptions {
  /** The session's clock: what a record's `atMs` is on. */
  clock: Clock;
  /** `spark` leaves the observer's own scores alone and makes no call. */
  mode?: GateMode;
  /**
   * Where a judgment call goes (V2-010), resolved per call. `null` means
   * there is no model to ask, which is a fallback rather than a rejection.
   */
  client: () => Promise<JudgmentClient | null>;
  /** The board as the last update left it. */
  board: () => Board;
  /** Final turns so far, oldest first. The tail is the gate's context. */
  turns: () => readonly TurnUpdate[];
  /** Every call, scored or failed, into `candidates.jsonl`. */
  onRecord: (record: CandidateGateLogRecord) => void;
  /** The policy (US-014), with whichever scores it ends up with. */
  onScored: (candidate: Candidate) => void;
  /**
   * Real time, for the latency the verdict took. The session clock cannot
   * answer that: a `max`-speed replay's clock stands still during a call.
   */
  wallClock?: Clock;
  logger?: Logger;
}

export class CandidateGate {
  private readonly clock: Clock;
  private readonly mode: GateMode;
  private readonly client: () => Promise<JudgmentClient | null>;
  private readonly board: () => Board;
  private readonly turns: () => readonly TurnUpdate[];
  private readonly onRecord: (record: CandidateGateLogRecord) => void;
  private readonly onScored: (candidate: Candidate) => void;
  private readonly wallClock: Clock;
  private readonly logger: Logger;

  /** The calls in flight, so {@link flush} can wait for all of them. */
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;
  private callCount = 0;

  constructor(options: CandidateGateOptions) {
    this.clock = options.clock;
    this.mode = options.mode ?? DEFAULT_GATE_MODE;
    this.client = options.client;
    this.board = options.board;
    this.turns = options.turns;
    this.onRecord = options.onRecord;
    this.onScored = options.onScored;
    this.wallClock = options.wallClock ?? systemClock;
    this.logger = options.logger ?? console;
  }

  /** Which gate is running. Read by the log and by the eval record. */
  setting(): GateMode {
    return this.mode;
  }

  /** How many gate calls have come back. */
  calls(): number {
    return this.callCount;
  }

  /** How many are still out. */
  pending(): number {
    return this.inFlight.size;
  }

  /**
   * Scores one candidate and hands it on.
   *
   * Returns at once, and in `spark` mode hands it on *synchronously*: not
   * gating must cost the candidate nothing at all, since that is the timing
   * the rest of the pipeline was tuned against.
   */
  accept(candidate: Candidate): void {
    if (this.stopped) return;
    if (this.mode === "spark") {
      this.onScored(candidate);
      return;
    }
    const call = this.score(candidate).finally(() => this.inFlight.delete(call));
    this.inFlight.add(call);
    // Registered before returning, so a `max`-speed replay does not run past
    // a call that has only just started.
    void this.clock.track(CANDIDATE_GATE_TRACK_LABEL, call);
  }

  /** Waits for every call in flight, including ones started while waiting. */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** No more calls. The ones in flight still finish. Idempotent. */
  stop(): void {
    this.stopped = true;
  }

  /** One call, start to handed-on finish. Never rejects. */
  private async score(candidate: Candidate): Promise<void> {
    const startedAt = this.wallClock.now();
    const observerScores = candidate.scores;
    /** The record every path writes, with the latency the call really took. */
    const record = (
      gate: CandidateGateWhere | null,
      scores: GateScores | undefined,
      error: string | undefined,
    ): CandidateGateLogRecord => {
      // A verdict replaces the observer's scores; no verdict leaves them.
      const effective = scores === undefined ? observerScores : scoresFromGate(scores);
      return {
        kind: "gate",
        atMs: this.clock.now(),
        candidateId: candidate.id,
        headline: candidate.headline,
        type: candidate.type,
        observerScores,
        ...(scores === undefined ? {} : { gateScores: scores }),
        gate,
        scores: effective,
        score: candidateScore(effective),
        latencyMs: Math.round(this.wallClock.now() - startedAt),
        ...(error === undefined ? {} : { error }),
      };
    };
    /** The candidate goes on with the observer's own scores and no verdict. */
    const fallback = (gate: CandidateGateWhere | null, error: string): void => {
      this.callCount += 1;
      const line = record(gate, undefined, error);
      this.onRecord(line);
      this.logger.warn(
        `[gate] ${candidate.id} could not be scored (${error}); keeping the observer's` +
          ` ${line.score.toFixed(2)}: ${candidate.headline}`,
      );
      if (!this.stopped) this.onScored(candidate);
    };
    const scored = (gate: CandidateGateWhere, scores: GateScores): void => {
      this.callCount += 1;
      const line = record(gate, scores, undefined);
      this.onRecord(line);
      this.logger.log(
        `[gate] ${candidate.id} scored ${line.score.toFixed(2)} on ${gate}` +
          ` in ${line.latencyMs} ms (was ${candidateScore(observerScores).toFixed(2)}):` +
          ` true ${scores.true.toFixed(2)}, new ${scores.new.toFixed(2)},` +
          ` worth ${scores.worthSaying.toFixed(2)},` +
          ` relevant ${scores.stillRelevant.toFixed(2)} — ${candidate.headline}`,
      );
      if (this.stopped) return;
      this.onScored({
        ...candidate,
        scores: line.scores,
        observerScores,
        gate: { gate, scores, latencyMs: line.latencyMs },
      });
    };

    const client = await this.client();
    if (client === null) {
      fallback(null, "no model is configured for judgment calls");
      return;
    }
    const gate: CandidateGateWhere = client.where === "local" ? "glimmer" : "spark-fallback";
    try {
      scored(gate, await this.request(client, candidate));
    } catch (error) {
      fallback(gate, error instanceof Error ? error.message : String(error));
    }
  }

  /** One call, validated. */
  private async request(client: JudgmentClient, candidate: Candidate): Promise<GateScores> {
    const reply = await client.structured({
      label: CANDIDATE_GATE_TRACK_LABEL,
      system: loadPrompt(PROMPTS.gate),
      user: renderGateRequest(this.board(), this.turns().slice(-GATE_CONTEXT_TURNS), candidate),
      schemaName: CANDIDATE_GATE_SCHEMA_NAME,
      schema: candidateGateJsonSchema,
      maxTokens: CANDIDATE_GATE_MAX_TOKENS,
      // The moment is passing while this is thought about: four readings of
      // the transcript, not a derivation.
      reasoningEffort: "low",
    });
    const parsed = CandidateGateReplySchema.safeParse(reply);
    if (!parsed.success) {
      throw new ModelCallError(
        `gate reply did not match the schema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  }
}

/**
 * The user message for one gate call: the board, the last few turns, the
 * quotes the point rests on, and the point.
 *
 * Short on purpose, and the quotes are the reason. Glimmer generates about
 * thirteen tokens a second on this Mac, so every paragraph is paid for twice
 * — once reading it and once reasoning about it — and `true` is a question
 * about the cited turns rather than about the whole conversation. No turn ids
 * anywhere: the gate answers about the point, never about a turn, and has
 * nothing to copy back.
 */
export function renderGateRequest(
  board: Board,
  recent: readonly TurnUpdate[],
  candidate: Candidate,
): string {
  const blocks = ["## The board right now", renderBoard(board)];
  if (recent.length > 0) {
    blocks.push("## The last few things they said", recent.map(renderTurn).join("\n"));
  }
  const quotes = candidate.evidence.slice(-GATE_EVIDENCE_QUOTES);
  blocks.push(
    "## What the point rests on",
    quotes.length === 0
      ? "_nothing was cited, which is itself worth knowing_"
      : quotes
          .map((quote) => `${quote.speaker ?? "?"}: ${quote.quote.replace(/\s+/g, " ").trim()}`)
          .join("\n"),
  );
  blocks.push(
    "## The point it wants to raise",
    `Kind: ${candidate.type}`,
    `Headline: ${candidate.headline}`,
    `Reasoning: ${candidate.detail}`,
    `Why now: ${candidate.whyNow}`,
    "Reply with the four probabilities, each between 0 and 1.",
  );
  return blocks.join("\n\n");
}

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
  return `- ${item.text}${item.status === "open" ? "" : ` (${item.status})`}`;
}

function renderTurn(turn: TurnUpdate): string {
  return `${turn.speaker ?? "?"}: ${turn.text.replace(/\s+/g, " ").trim()}`;
}
