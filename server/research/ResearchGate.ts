/**
 * The research gate (PRD V2-012).
 *
 * One idea in, three probabilities out: is the answer useful to this group
 * now, do they not already know it, and could a web search actually answer
 * it. {@link researchScore} folds those into one number and anything below
 * {@link RESEARCH_GATE_THRESHOLD} is dropped — which is most of them, and the
 * point: noticing something worth looking up is cheap, searching for it is a
 * model call plus a card the group did not ask for.
 *
 * It is a **judgment call** (V2-010), so it goes to Muse Glimmer on this Mac
 * when there is one and to Muse Spark when there is not, and the caller is
 * told which answered. Nobody is waiting on a verdict out loud — a research
 * answer is for the rest of the conversation, not for the next ten seconds —
 * which is exactly what makes it the right kind of call to spend seventeen
 * seconds of local GPU on.
 *
 * A gate call never throws: a verdict that did not come back is a `failed`
 * record and the idea stops there. Treating it as a pass would let a model
 * outage turn into a screen full of searches nobody vetted.
 */
import type { Board, Item } from "../../shared/board.js";
import { boardSections } from "../../shared/board.js";
import {
  RESEARCH_GATE_SCHEMA_NAME,
  RESEARCH_GATE_THRESHOLD,
  ResearchGateReplySchema,
  researchGateJsonSchema,
  researchScore,
  type ResearchGateRecord,
  type ResearchGateScores,
  type ResearchIdea,
} from "../../shared/research.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { systemClock, type Clock } from "../clock.js";
import { ModelCallError } from "../model/client.js";
import type { JudgmentClient } from "../model/judgment.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";

/** The label a gate call is tracked under on the clock, and in the model logs. */
export const GATE_TRACK_LABEL = "research-gate";

/**
 * Reasoning + output budget for one gate call.
 *
 * Three numbers is a tiny reply, so this is all reasoning headroom: measured
 * at 180 completion tokens on Glimmer at `low` effort, and Muse Spark spends
 * 1,300–3,200 on a short structured prompt. Unused budget is not billed and
 * costs no time; a truncated reply loses the verdict.
 */
export const GATE_MAX_TOKENS = 4_096;

/** How many of the latest turns the gate reads as "what they are doing now". */
export const GATE_CONTEXT_TURNS = 6;

type Logger = Pick<Console, "log" | "warn">;

export interface ResearchGateOptions {
  /** The session's clock: what the record's `atMs` is on. */
  clock: Clock;
  /**
   * Where a judgment call goes (V2-010), resolved per call. `null` means
   * there is no model at all, which is a `failed` verdict rather than a pass.
   */
  client: () => Promise<JudgmentClient | null>;
  /** The board as the last update left it. */
  board: () => Board;
  /** Final turns so far, oldest first. The tail is the gate's context. */
  turns: () => readonly TurnUpdate[];
  /**
   * Real time, for the latency the verdict took. The session clock cannot
   * answer that: a `max`-speed replay's clock stands still during a call.
   */
  wallClock?: Clock;
  logger?: Logger;
  threshold?: number;
}

export class ResearchGate {
  private readonly clock: Clock;
  private readonly client: () => Promise<JudgmentClient | null>;
  private readonly board: () => Board;
  private readonly turns: () => readonly TurnUpdate[];
  private readonly wallClock: Clock;
  private readonly logger: Logger;
  private readonly threshold: number;

  constructor(options: ResearchGateOptions) {
    this.clock = options.clock;
    this.client = options.client;
    this.board = options.board;
    this.turns = options.turns;
    this.wallClock = options.wallClock ?? systemClock;
    this.logger = options.logger ?? console;
    this.threshold = options.threshold ?? RESEARCH_GATE_THRESHOLD;
  }

  /** The score an idea has to beat. Read by the log and by the tests. */
  scoreThreshold(): number {
    return this.threshold;
  }

  /**
   * Scores one idea. Never rejects: the record *is* the answer, failure
   * included.
   */
  async score(idea: ResearchIdea): Promise<ResearchGateRecord> {
    const startedAt = this.wallClock.now();
    const fail = (error: string, where: ResearchGateRecord["where"]): ResearchGateRecord => {
      this.logger.warn(`[research] gate could not score ${idea.id}: ${error}`);
      return {
        kind: "gate",
        atMs: this.clock.now(),
        ideaId: idea.id,
        question: idea.question,
        decision: "failed",
        where,
        score: 0,
        threshold: this.threshold,
        latencyMs: Math.round(this.wallClock.now() - startedAt),
        error,
      };
    };

    const client = await this.client();
    if (client === null) return fail("no model is configured for judgment calls", null);

    let scores: ResearchGateScores;
    try {
      scores = await this.request(client, idea);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), client.where);
    }

    const score = researchScore(scores);
    const decision = score >= this.threshold ? "queued" : "rejected";
    const latencyMs = Math.round(this.wallClock.now() - startedAt);
    this.logger.log(
      `[research] gate ${decision} ${idea.id} (${score.toFixed(2)} vs ${this.threshold}) on ${client.where}` +
        ` in ${latencyMs} ms: useful ${scores.useful.toFixed(2)}, unknown ${scores.unknown.toFixed(2)}` +
        `, answerable ${scores.answerable.toFixed(2)} — ${idea.question}`,
    );
    return {
      kind: "gate",
      atMs: this.clock.now(),
      ideaId: idea.id,
      question: idea.question,
      decision,
      where: client.where,
      scores,
      score,
      threshold: this.threshold,
      latencyMs,
    };
  }

  /** One call, validated. */
  private async request(client: JudgmentClient, idea: ResearchIdea): Promise<ResearchGateScores> {
    const reply = await client.structured({
      label: GATE_TRACK_LABEL,
      system: loadPrompt(PROMPTS.researchGate),
      user: renderGateRequest(this.board(), this.turns().slice(-GATE_CONTEXT_TURNS), idea),
      schemaName: RESEARCH_GATE_SCHEMA_NAME,
      schema: researchGateJsonSchema,
      maxTokens: GATE_MAX_TOKENS,
      // Nothing is waiting out loud, but seventeen seconds of local GPU is
      // long enough; the judgement here is a reading, not a derivation.
      reasoningEffort: "low",
    });
    const parsed = ResearchGateReplySchema.safeParse(reply);
    if (!parsed.success) {
      throw new ModelCallError(
        `research gate reply did not match the schema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  }
}

/**
 * The user message for one gate call: the board, the last few turns, and the
 * question.
 *
 * Short on purpose. Glimmer generates about thirteen tokens a second on this
 * Mac, so every paragraph of context is paid for twice — once reading it and
 * once reasoning about it — and the three questions the gate answers are all
 * answerable from the board plus where the conversation has got to.
 */
export function renderGateRequest(
  board: Board,
  recent: readonly TurnUpdate[],
  idea: ResearchIdea,
): string {
  const blocks = ["## The board right now", renderBoard(board)];
  if (recent.length > 0) {
    blocks.push("## The last few things they said", recent.map(renderTurn).join("\n"));
  }
  blocks.push(
    "## The proposed research",
    `Topic: ${idea.topic}`,
    `Question: ${idea.question}`,
    `Why it was proposed: ${idea.why}`,
    "Reply with the three probabilities, each between 0 and 1.",
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

/** No ids here: the gate answers about the question, never about a turn. */
function renderTurn(turn: TurnUpdate): string {
  return `${turn.speaker ?? "?"}: ${turn.text.replace(/\s+/g, " ").trim()}`;
}
