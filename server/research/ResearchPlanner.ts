/**
 * The research planner (PRD V2-012).
 *
 * The observer notices when the group *asks* for something to be looked up;
 * the planner is for the question they have not thought to ask. Every two
 * minutes, if at least three new final turns have gone by, it reads the board
 * and the transcript since its last look and proposes at most two concrete,
 * checkable things to search for.
 *
 * Two minutes is a long interval on purpose. A research answer is useful for
 * the rest of a conversation rather than for the next ten seconds, so there
 * is nothing to gain from looking more often, and every look costs a model
 * call that the board, the observer and any answer in flight are competing
 * for. The three-turn floor is what stops a quiet stretch from being looked
 * at twice.
 *
 * Like the board loop and the observer: one call in flight at a time, the
 * whole cycle wrapped in {@link Clock.track} so a `max`-speed replay stops at
 * it, and a failed call puts its turns back rather than losing them.
 */
import type { Board, Item } from "../../shared/board.js";
import { boardSections } from "../../shared/board.js";
import {
  MAX_PLANNER_IDEAS,
  PlannerIdeaSchema,
  PlannerReplySchema,
  RESEARCH_PLANNER_SCHEMA_NAME,
  researchPlannerJsonSchema,
  type PlannerIdea,
  type ResearchIdea,
} from "../../shared/research.js";
import type { TurnUpdate } from "../../shared/turns.js";
import type { Clock } from "../clock.js";
import { ModelCallError, type ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";

/** How often the planner looks, when there is anything new to look at. */
export const PLANNER_INTERVAL_MS = 2 * 60_000;

/** New final turns a look needs. Fewer than this and the tick does nothing. */
export const PLANNER_MIN_NEW_TURNS = 3;

/** How many turns before the new ones go along for context. */
export const PLANNER_CONTEXT_TURNS = 8;

/** How many ideas already thought of are listed back to the model. */
export const PLANNER_KNOWN_HISTORY = 10;

/** The label the cycle is tracked under on the clock, and in the model logs. */
export const PLANNER_TRACK_LABEL = "research-planner";

type Logger = Pick<Console, "log" | "warn">;

export interface ResearchPlannerOptions {
  /** The session's clock — simulated for a replay, real for a live session. */
  clock: Clock;
  /** Muse Spark: the planner is a reading-comprehension job, not a judgment. */
  model: ModelClient;
  /** The board as the last update left it. */
  board: () => Board;
  /** Every idea the session has had, so a look does not repeat one. */
  known: () => readonly ResearchIdea[];
  /** Hands on what one look proposed, in the order the model ranked it. */
  onIdeas: (ideas: PlannerIdea[]) => void;
  /** The model status dot, shared with the board loop and the observer. */
  onModelState?: (state: "connecting" | "active" | "error", detail: string) => void;
  logger?: Logger;
  intervalMs?: number;
  minNewTurns?: number;
}

export class ResearchPlanner {
  private readonly clock: Clock;
  private readonly model: ModelClient;
  private readonly board: () => Board;
  private readonly known: () => readonly ResearchIdea[];
  private readonly onIdeas: (ideas: PlannerIdea[]) => void;
  private readonly onModelState: ResearchPlannerOptions["onModelState"];
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly minNewTurns: number;

  /** Every final turn so far, oldest first; the context comes off the end. */
  private readonly turns: TurnUpdate[] = [];
  /** Final turns the planner has not looked at yet. */
  private pending: TurnUpdate[] = [];
  private running: Promise<void> | undefined;
  private cancelTimer: (() => void) | undefined;
  private stopped = false;
  private runCount = 0;

  constructor(options: ResearchPlannerOptions) {
    this.clock = options.clock;
    this.model = options.model;
    this.board = options.board;
    this.known = options.known;
    this.onIdeas = options.onIdeas;
    this.onModelState = options.onModelState;
    this.logger = options.logger ?? console;
    this.intervalMs = options.intervalMs ?? PLANNER_INTERVAL_MS;
    this.minNewTurns = options.minNewTurns ?? PLANNER_MIN_NEW_TURNS;
  }

  /** How many looks have completed. */
  runs(): number {
    return this.runCount;
  }

  /**
   * Takes one turn snapshot, and starts the clock on the first one.
   *
   * Partials are ignored, as everywhere else that reasons about what was
   * said. The timer is armed lazily so that a session nobody talks in has no
   * timer pending, and re-armed after every tick for as long as the session
   * lasts — the interval is the planner's whole trigger, unlike the board's,
   * which also fires on a turn count.
   */
  acceptTurn(turn: TurnUpdate): void {
    if (this.stopped || !turn.final) return;
    this.turns.push(turn);
    this.pending.push(turn);
    this.armTimer();
  }

  /**
   * Waits for a look in flight.
   *
   * Deliberately does *not* start one, unlike {@link BoardUpdater.flush}: a
   * conversation that has ended has nothing left for a search to inform, so
   * the last few turns are worth saving but not worth researching.
   */
  async flush(): Promise<void> {
    while (this.running !== undefined) await this.running;
  }

  /** No more looks. The one in flight still finishes. Idempotent. */
  stop(): void {
    this.stopped = true;
    const cancel = this.cancelTimer;
    this.cancelTimer = undefined;
    cancel?.();
  }

  /** One tick of the interval: look if enough has been said, then re-arm. */
  private tick(): void {
    this.cancelTimer = undefined;
    if (this.stopped) return;
    if (this.pending.length >= this.minNewTurns && this.running === undefined) {
      this.running = this.clock.track(PLANNER_TRACK_LABEL, this.cycle());
    }
    this.armTimer();
  }

  private async cycle(): Promise<void> {
    try {
      await this.runOnce();
    } finally {
      this.running = undefined;
    }
  }

  private async runOnce(): Promise<void> {
    const newTurns = this.pending;
    this.pending = [];
    const context = this.turns
      .slice(0, this.turns.length - newTurns.length)
      .slice(-PLANNER_CONTEXT_TURNS);
    this.onModelState?.("connecting", "looking for something worth researching");

    let ideas: PlannerIdea[];
    try {
      ideas = await this.request(newTurns, context);
    } catch (error) {
      const detail = message(error);
      this.logger.warn(`[research] planner run ${this.runCount + 1} failed: ${detail}`);
      this.onModelState?.("error", detail);
      // Never looked at, so they go back at the front for the next tick.
      this.pending = [...newTurns, ...this.pending];
      return;
    }

    this.runCount += 1;
    if (ideas.length > MAX_PLANNER_IDEAS) {
      this.logger.warn(
        `[research] planner run ${this.runCount} proposed ${ideas.length} ideas; keeping the first ${MAX_PLANNER_IDEAS}`,
      );
      ideas = ideas.slice(0, MAX_PLANNER_IDEAS);
    }
    this.logger.log(
      `[research] planner run ${this.runCount}: ${ideas.length} idea(s) from ${newTurns.length} turns` +
        (ideas.length === 0 ? "" : `: ${ideas.map((idea) => idea.topic).join(", ")}`),
    );
    this.onModelState?.("active", "model client ready");
    if (ideas.length > 0) this.onIdeas(ideas);
  }

  /** One call, with each idea validated on its own. */
  private async request(
    newTurns: readonly TurnUpdate[],
    context: readonly TurnUpdate[],
  ): Promise<PlannerIdea[]> {
    const reply = await this.model.structured({
      label: PLANNER_TRACK_LABEL,
      system: loadPrompt(PROMPTS.researchPlanner),
      user: renderPlannerRequest(this.board(), newTurns, context, this.known()),
      schemaName: RESEARCH_PLANNER_SCHEMA_NAME,
      schema: researchPlannerJsonSchema,
    });
    const parsed = PlannerReplySchema.safeParse(reply);
    if (!parsed.success) {
      throw new ModelCallError(
        `research planner reply did not match the schema: ${issues(parsed.error.issues)}`,
      );
    }
    const ideas: PlannerIdea[] = [];
    for (const [index, raw] of parsed.data.ideas.entries()) {
      const one = PlannerIdeaSchema.safeParse(raw);
      if (!one.success) {
        this.logger.warn(`[research] ignored planner idea ${index}: ${issues(one.error.issues)}`);
        continue;
      }
      ideas.push(one.data);
    }
    return ideas;
  }

  private armTimer(): void {
    if (this.stopped) return;
    if (this.cancelTimer !== undefined) return;
    if (this.turns.length === 0) return;
    this.cancelTimer = this.clock.setTimeout(() => this.tick(), this.intervalMs);
  }
}

/**
 * The user message for one look: the board, what has already been thought of,
 * the turns before the new ones, and the new ones.
 *
 * The already-thought-of list is the first line of defence against proposing
 * the same search twice; {@link findDuplicateIdea} behind it catches what gets
 * through. Turn ids are printed exactly as the assembler made them, because
 * `sourceTurnIds` are resolved downstream by string match.
 */
export function renderPlannerRequest(
  board: Board,
  newTurns: readonly TurnUpdate[],
  context: readonly TurnUpdate[],
  known: readonly ResearchIdea[],
): string {
  const blocks = ["## The board right now", renderBoard(board)];
  if (known.length > 0) {
    blocks.push(
      "## Already being looked up",
      "Do not propose these again, in any wording.",
      known
        .slice(-PLANNER_KNOWN_HISTORY)
        .map((idea) => `- (${idea.topic}) ${idea.question}`)
        .join("\n"),
    );
  }
  if (context.length > 0) {
    blocks.push("## Earlier turns, for context only", context.map(renderTurn).join("\n"));
  }
  blocks.push(
    "## The transcript since you last looked",
    newTurns.length === 0 ? "_nothing new_" : newTurns.map(renderTurn).join("\n"),
    "Reply with the research items worth looking up. An empty list is a good answer.",
  );
  return blocks.join("\n\n");
}

/** The board as lines rather than JSON, as the observer's request renders it. */
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

function issues(list: readonly { path: PropertyKey[]; message: string }[]): string {
  return list.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
