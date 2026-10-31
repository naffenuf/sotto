/**
 * The board update loop (PRD US-009).
 *
 * It watches final turns go by and decides when the board is worth a model
 * call: **four new turns, or forty-five seconds with at least one**. The first
 * rule keeps up with a fast exchange, the second stops a slow one from leaving
 * the board behind — and together they are about one call a minute of talk,
 * which is what the rate the API can be asked at allows.
 *
 * Only one update is ever in flight. Turns that arrive during a call are not
 * dropped and do not start a second call: they pile up in `pending` and go
 * into the next run, which starts straight away if a trigger fired while the
 * last one was out.
 *
 * Everything time-related reads the injected {@link Clock}, and the whole
 * cycle is wrapped in {@link Clock.track}, so a `max`-speed event replay
 * (US-006) stops at the moment a call was made and the board's timestamps come
 * out the same as they would in a live session.
 */
import {
  BOARD_OPS_SCHEMA_NAME,
  BoardUpdateSchema,
  boardOpsJsonSchema,
  emptyBoard,
  type Board,
  type BoardOp,
} from "../../shared/board.js";
import type { TurnUpdate } from "../../shared/turns.js";
import type { Clock } from "../clock.js";
import { ModelCallError, type ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";
import { applyOps, type IgnoredOp } from "./applyOps.js";
import { renderBoardMarkdown } from "./markdown.js";

/** New final turns that trigger an update on their own. */
export const NEW_TURNS_PER_UPDATE = 4;

/** How long the board may lag behind a slow conversation. */
export const UPDATE_INTERVAL_MS = 45_000;

/** How many turns before the new ones go along for context. */
export const CONTEXT_TURNS = 10;

/** The label the cycle is tracked under on the clock. */
export const BOARD_TRACK_LABEL = "board";

type Logger = Pick<Console, "log" | "warn">;

/** One applied update, as the bus and the session folder want it. */
export interface AppliedBoardUpdate {
  /** The board after the update. */
  board: Board;
  /** The same board as `board.md`. */
  markdown: string;
  /** Ids the update added or changed. */
  changedIds: string[];
  summaryChanged: boolean;
  /** When it was applied, on the session clock. */
  atMs: number;
  /** Turn ids the update was built from, oldest first. */
  turnIds: string[];
  /** Operations that changed nothing. Already logged. */
  ignored: IgnoredOp[];
}

export interface BoardUpdaterOptions {
  /** The session's clock — simulated for a replay, real for a live session. */
  clock: Clock;
  model: ModelClient;
  /** Called after every update, whether or not anything changed. */
  onUpdate: (update: AppliedBoardUpdate) => void;
  /**
   * The model status dot: `connecting` while a call is out, `active` when it
   * came back, `error` when it didn't.
   */
  onModelState?: (state: "connecting" | "active" | "error", detail: string) => void;
  logger?: Logger;
  newTurnsPerUpdate?: number;
  intervalMs?: number;
  onTiming?: (event: Record<string, unknown>) => void;
}

export class BoardUpdater {
  private readonly clock: Clock;
  private readonly model: ModelClient;
  private readonly onUpdate: (update: AppliedBoardUpdate) => void;
  private readonly onModelState: BoardUpdaterOptions["onModelState"];
  private readonly logger: Logger;
  private readonly newTurnsPerUpdate: number;
  private readonly intervalMs: number;
  private readonly onTiming: BoardUpdaterOptions["onTiming"];
  private attemptCount = 0;

  private current: Board = emptyBoard();
  /** Every final turn so far, oldest first; the context window comes off the end. */
  private readonly turns: TurnUpdate[] = [];
  /** Turns included in successful board updates. */
  private readonly coveredTurnIds = new Set<string>();
  /** Final turns the board has not been shown yet. */
  private pending: TurnUpdate[] = [];
  /** The cycle that is running, or `undefined`. */
  private running: Promise<void> | undefined;
  /** A trigger that arrived while a call was out, to be merged into the next run. */
  private queued = false;
  private cancelTimer: (() => void) | undefined;
  private stopped = false;
  private updateCount = 0;

  constructor(options: BoardUpdaterOptions) {
    this.clock = options.clock;
    this.model = options.model;
    this.onUpdate = options.onUpdate;
    this.onModelState = options.onModelState;
    this.logger = options.logger ?? console;
    this.newTurnsPerUpdate = options.newTurnsPerUpdate ?? NEW_TURNS_PER_UPDATE;
    this.intervalMs = options.intervalMs ?? UPDATE_INTERVAL_MS;
    this.onTiming = options.onTiming;
  }

  /** The board as the last update left it. */
  board(): Board {
    return this.current;
  }

  /** Final turns absent from the latest successfully applied board. */
  uncoveredTurns(): readonly TurnUpdate[] {
    return this.turns.filter((turn) => !this.coveredTurnIds.has(turn.turnId));
  }

  /** How many updates have been applied. */
  updates(): number {
    return this.updateCount;
  }

  /**
   * Takes one turn snapshot. Partials are ignored — the board is built out of
   * what people finished saying — and a final turn may trigger an update.
   */
  acceptTurn(turn: TurnUpdate): void {
    if (this.stopped || !turn.final) return;
    this.turns.push(turn);
    this.pending.push(turn);
    if (this.pending.length >= this.newTurnsPerUpdate) {
      this.kick();
      return;
    }
    this.armTimer();
  }

  /**
   * Runs a last update for whatever is still pending and waits for the loop to
   * go quiet. Called when a session ends, so the final turns of a conversation
   * reach the board even though they never hit a trigger.
   */
  async flush(): Promise<void> {
    if (this.pending.length > 0) this.kick();
    while (this.running !== undefined) await this.running;
  }

  /** No more updates. Leaves the board as it is; idempotent. */
  stop(): void {
    this.stopped = true;
    this.disarmTimer();
  }

  /** Starts a cycle, or notes that one is owed. */
  private kick(): void {
    if (this.stopped) return;
    this.disarmTimer();
    if (this.running !== undefined) {
      this.queued = true;
      return;
    }
    // Tracked as a whole rather than just around the call: the apply, the
    // write and the push happen at the moment the call came back, and a
    // `max`-speed replay must not step over them either.
    this.running = this.clock.track(BOARD_TRACK_LABEL, this.cycle());
  }

  /** Runs updates back to back for as long as triggers keep arriving. */
  private async cycle(): Promise<void> {
    try {
      do {
        this.queued = false;
        await this.runOnce();
      } while (this.queued && this.pending.length > 0 && !this.stopped);
    } finally {
      this.running = undefined;
      // Turns left over — a failed call put its own back — get the clock.
      this.armTimer();
    }
  }

  private async runOnce(): Promise<void> {
    const newTurns = this.pending;
    this.pending = [];
    const attempt = ++this.attemptCount;
    const startedAtMs = this.clock.now();
    const turnIds = newTurns.map((turn) => turn.turnId);
    this.onTiming?.({ stage: "board_start", atMs: startedAtMs, attempt, turnIds });
    const context = this.turns.slice(0, this.turns.length - newTurns.length).slice(-CONTEXT_TURNS);
    this.onModelState?.("connecting", "updating the board");

    let ops: BoardOp[];
    try {
      ops = await this.requestOps(newTurns, context);
    } catch (error) {
      const detail = message(error);
      this.onTiming?.({ stage: "board_error", atMs: this.clock.now(), attempt, durationMs: this.clock.now() - startedAtMs, turnIds, error: detail });
      this.logger.warn(`[board] update ${this.updateCount + 1} failed: ${detail}`);
      this.onModelState?.("error", detail);
      // The turns were never shown to the board, so they go back at the front
      // of the queue; the interval timer will try them again.
      this.pending = [...newTurns, ...this.pending];
      return;
    }

    const atMs = this.clock.now();
    this.onTiming?.({ stage: "board_complete", atMs, attempt, durationMs: atMs - startedAtMs, turnIds });
    const result = applyOps(this.current, ops, atMs);
    this.current = result.board;
    for (const turn of newTurns) this.coveredTurnIds.add(turn.turnId);
    for (const skipped of result.ignored) {
      this.logger.warn(
        `[board] ignored ${skipped.op.op}${skipped.id === undefined ? "" : ` ${skipped.id}`}: ${skipped.reason}`,
      );
    }
    this.updateCount += 1;
    this.logger.log(
      `[board] update ${this.updateCount}: ${ops.length} ops from ${newTurns.length} turns` +
        `, ${result.changedIds.length} items changed${result.summaryChanged ? ", new summary" : ""}`,
    );
    this.onUpdate({
      board: this.current,
      markdown: renderBoardMarkdown(this.current),
      changedIds: result.changedIds,
      summaryChanged: result.summaryChanged,
      atMs,
      turnIds: newTurns.map((turn) => turn.turnId),
      ignored: result.ignored,
    });
    this.onModelState?.("active", "model client ready");
  }

  /** One call, validated. Anything the model got wrong arrives as a throw. */
  private async requestOps(
    newTurns: readonly TurnUpdate[],
    context: readonly TurnUpdate[],
  ): Promise<BoardOp[]> {
    const reply = await this.model.structured({
      label: BOARD_TRACK_LABEL,
      system: loadPrompt(PROMPTS.board),
      user: renderBoardRequest(this.current, newTurns, context),
      schemaName: BOARD_OPS_SCHEMA_NAME,
      schema: boardOpsJsonSchema,
    });
    const parsed = BoardUpdateSchema.safeParse(reply);
    if (!parsed.success) {
      throw new ModelCallError(
        `board operations did not match the schema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data.operations;
  }

  /**
   * Arms the interval timer, if there is anything waiting for it. Measured
   * from the first turn the board has not seen, so it means "the group has
   * been talking for 45 s without saying four things".
   */
  private armTimer(): void {
    if (this.stopped) return;
    if (this.cancelTimer !== undefined || this.running !== undefined) return;
    if (this.pending.length === 0) return;
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = undefined;
      this.kick();
    }, this.intervalMs);
  }

  private disarmTimer(): void {
    const cancel = this.cancelTimer;
    this.cancelTimer = undefined;
    cancel?.();
  }
}

/**
 * The user message for one update: the board, the turns just before the new
 * ones, and the new ones.
 *
 * Turn ids are printed exactly as the assembler produced them, because
 * `sourceTurnIds` are the model's way of pointing back at the transcript and
 * everything downstream — the evidence quotes on an interjection card, the
 * eval harness — resolves them by string match.
 */
export function renderBoardRequest(
  board: Board,
  newTurns: readonly TurnUpdate[],
  context: readonly TurnUpdate[],
): string {
  const blocks = [
    "## The board right now",
    "```json",
    JSON.stringify(board, null, 2),
    "```",
  ];
  if (context.length > 0) {
    blocks.push(
      "## Earlier turns, for context only",
      "Already on the board, or deliberately not. Do not add anything for these.",
      context.map(renderTurn).join("\n"),
    );
  }
  blocks.push(
    "## New turns",
    newTurns.length === 0 ? "_none_" : newTurns.map(renderTurn).join("\n"),
    "Reply with the operations that bring the board up to date.",
  );
  return blocks.join("\n\n");
}

/** `[0:7] A (01:23): text` — the id first, since that is what gets copied back. */
function renderTurn(turn: TurnUpdate): string {
  return `[${turn.turnId}] ${turn.speaker ?? "?"} (${stamp(turn.startMs)}): ${turn.text.replace(/\s+/g, " ").trim()}`;
}

function stamp(offsetMs: number): string {
  const seconds = Math.max(0, Math.round(offsetMs / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
