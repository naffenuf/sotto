/**
 * What Sotto decides to research, and how much of it (PRD V2-012).
 *
 * Ideas arrive from two places — a `research_hook` candidate the observer
 * noticed (V2-011) and the planner's own two-minute look — and go through the
 * same three stages here:
 *
 *   1. **Dedupe.** Every idea the session has ever had is remembered, so an
 *      idea that repeats one is written down and goes no further. Because a
 *      packet (V2-013) is built from an idea that is still in that list, this
 *      is also the deduplication against earlier packets the PRD asks for.
 *   2. **Gate.** One judgment call per idea, one at a time: Glimmer is a
 *      single local GPU and a conversation would otherwise have three
 *      seventeen-second calls racing each other for it. Below threshold is
 *      the normal outcome.
 *   3. **Budget.** An idea the gate passed is *queued*, not started. At most
 *      {@link MAX_CONCURRENT_JOBS} jobs run at once and at most
 *      {@link MAX_JOBS_PER_WINDOW} start in any {@link RESEARCH_WINDOW_MS},
 *      so a conversation full of hooks cannot turn into a search engine.
 *
 * Nothing here blocks the conversation. {@link ResearchManager.acceptHook}
 * and the planner's callback return immediately and the work registers itself
 * with {@link Clock.track}, which is what makes a `max`-speed replay wait for
 * it without the pipeline ever awaiting it.
 *
 * The runner itself is V2-013's: this story starts jobs through the injected
 * {@link ResearchManagerOptions.run}, and with none supplied an approved idea
 * sits in the queue — which is exactly what the budget is counting.
 */
import type { Board } from "../../shared/board.js";
import type { Candidate } from "../../shared/candidates.js";
import {
  MAX_CONCURRENT_JOBS,
  MAX_JOBS_PER_WINDOW,
  RESEARCH_WINDOW_MS,
  findDuplicateIdea,
  hookIdea,
  type PlannerIdea,
  type ResearchIdea,
  type ResearchLogLine,
  type ResearchOrigin,
} from "../../shared/research.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { isSottoTurn } from "../../shared/turns.js";
import type { Clock } from "../clock.js";
import type { ModelClient } from "../model/client.js";
import type { JudgmentClient } from "../model/judgment.js";
import { ResearchGate } from "./ResearchGate.js";
import { ResearchPlanner } from "./ResearchPlanner.js";

/** The label the gate queue is tracked under on the clock. */
export const RESEARCH_TRACK_LABEL = "research";

type Logger = Pick<Console, "log" | "warn">;

export interface ResearchManagerOptions {
  /** The session's clock — simulated for a replay, real for a live session. */
  clock: Clock;
  /** Muse Spark, for the planner's look. */
  model: ModelClient;
  /** Where a gate call goes (V2-010): Glimmer on this Mac, else Muse Spark. */
  client: () => Promise<JudgmentClient | null>;
  /** The board as the last update left it. */
  board: () => Board;
  /** One line of `research.jsonl`: every idea, every gate verdict, every start. */
  onRecord: (record: ResearchLogLine) => void;
  /**
   * Starts one research job and resolves when it has finished, whatever it
   * found (V2-013). Absent here, so an approved idea waits in the queue.
   */
  run?: (idea: ResearchIdea) => Promise<unknown>;
  /** The model status dot, shared with the board loop and the observer. */
  onModelState?: (state: "connecting" | "active" | "error", detail: string) => void;
  /** Real time, for the latency a gate verdict took. */
  wallClock?: Clock;
  logger?: Logger;
  threshold?: number;
  plannerIntervalMs?: number;
  plannerMinNewTurns?: number;
  maxConcurrent?: number;
  maxPerWindow?: number;
  windowMs?: number;
}

export class ResearchManager {
  private readonly clock: Clock;
  private readonly onRecord: (record: ResearchLogLine) => void;
  private readonly run: ResearchManagerOptions["run"];
  private readonly logger: Logger;
  private readonly maxConcurrent: number;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;

  readonly planner: ResearchPlanner;
  readonly gate: ResearchGate;

  /** Final turns, oldest first: the gate's context and the planner's input. */
  private readonly turns: TurnUpdate[] = [];
  /** Every idea that was not a duplicate, oldest first. The dedupe's memory. */
  private readonly allIdeas: ResearchIdea[] = [];
  /** Ideas waiting for the gate, oldest first. */
  private readonly toScore: ResearchIdea[] = [];
  /** Ideas the gate passed, waiting for a budget slot. */
  private readonly toRun: ResearchIdea[] = [];
  /** Jobs in flight, so {@link flush} can wait for them. */
  private readonly inFlight = new Set<Promise<unknown>>();
  /** When each job started, on the session clock: the ten-minute window. */
  private readonly starts: number[] = [];
  private scoring: Promise<void> | undefined;
  private cancelWindowTimer: (() => void) | undefined;
  private stopped = false;
  private ideaCount = 0;

  constructor(options: ResearchManagerOptions) {
    this.clock = options.clock;
    this.onRecord = options.onRecord;
    this.run = options.run;
    this.logger = options.logger ?? console;
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_JOBS;
    this.maxPerWindow = options.maxPerWindow ?? MAX_JOBS_PER_WINDOW;
    this.windowMs = options.windowMs ?? RESEARCH_WINDOW_MS;
    this.gate = new ResearchGate({
      clock: options.clock,
      client: options.client,
      board: options.board,
      turns: () => this.turns,
      ...(options.wallClock === undefined ? {} : { wallClock: options.wallClock }),
      logger: this.logger,
      ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    });
    this.planner = new ResearchPlanner({
      clock: options.clock,
      model: options.model,
      board: options.board,
      known: () => this.allIdeas,
      onIdeas: (ideas) => this.acceptPlannerIdeas(ideas),
      ...(options.onModelState === undefined ? {} : { onModelState: options.onModelState }),
      logger: this.logger,
      ...(options.plannerIntervalMs === undefined ? {} : { intervalMs: options.plannerIntervalMs }),
      ...(options.plannerMinNewTurns === undefined
        ? {}
        : { minNewTurns: options.plannerMinNewTurns }),
    });
  }

  /** Every idea the session has had that was not a repeat, oldest first. */
  ideas(): readonly ResearchIdea[] {
    return this.allIdeas;
  }

  /** Ideas the gate passed that the budget has not started yet. */
  queued(): readonly ResearchIdea[] {
    return this.toRun;
  }

  /** How many jobs are running. */
  running(): number {
    return this.inFlight.size;
  }

  /** How many jobs started inside the last {@link RESEARCH_WINDOW_MS}. */
  startedInWindow(): number {
    return this.recentStarts().length;
  }

  /**
   * Takes one turn snapshot: the planner's input and the gate's context.
   *
   * Partials are ignored, and so are Sotto's own lines (V2-008a) — what Sotto
   * said is not the group telling the planner what they need.
   */
  acceptTurn(turn: TurnUpdate): void {
    if (this.stopped || !turn.final || isSottoTurn(turn)) return;
    this.turns.push(turn);
    this.planner.acceptTurn(turn);
  }

  /**
   * Takes one `research_hook` candidate (V2-011).
   *
   * The hook's `headline` is already the question to look up, so there is no
   * second model call between a hook and an idea. Returns immediately.
   */
  acceptHook(candidate: Candidate): void {
    if (this.stopped) return;
    this.submit("hook", hookIdea(candidate), candidate.id);
  }

  /** Waits for the planner, the gate queue and every job in flight. */
  async flush(): Promise<void> {
    await this.planner.flush();
    while (this.scoring !== undefined) await this.scoring;
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** No more looks, no more gate calls, no more jobs. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.planner.stop();
    const cancel = this.cancelWindowTimer;
    this.cancelWindowTimer = undefined;
    cancel?.();
  }

  private acceptPlannerIdeas(ideas: readonly PlannerIdea[]): void {
    for (const idea of ideas) this.submit("planner", idea);
  }

  /** Records one idea and, unless it repeats an earlier one, gates it. */
  private submit(
    origin: ResearchOrigin,
    proposed: Omit<ResearchIdea, "id">,
    candidateId?: string,
  ): void {
    const duplicateOf = findDuplicateIdea(proposed, this.allIdeas);
    this.ideaCount += 1;
    const idea: ResearchIdea = { ...proposed, id: `idea-${this.ideaCount}` };
    this.onRecord({
      kind: "idea",
      atMs: this.clock.now(),
      origin,
      idea,
      ...(duplicateOf === undefined ? {} : { duplicateOf }),
      ...(candidateId === undefined ? {} : { candidateId }),
    });
    if (duplicateOf !== undefined) {
      this.logger.log(`[research] ${idea.id} repeats ${duplicateOf}: ${idea.question}`);
      return;
    }
    this.logger.log(`[research] ${idea.id} (${origin}) ${idea.topic}: ${idea.question}`);
    this.allIdeas.push(idea);
    this.toScore.push(idea);
    this.pumpGate();
  }

  /**
   * Scores the waiting ideas, one at a time.
   *
   * Registered with {@link Clock.track} before the caller gets control back,
   * so a `max`-speed replay stops for a verdict that has only just been asked
   * for — the same contract the verifier's checks have.
   */
  private pumpGate(): void {
    if (this.stopped || this.scoring !== undefined || this.toScore.length === 0) return;
    this.scoring = this.scoreQueue().finally(() => {
      this.scoring = undefined;
      // An idea submitted while the queue was draining starts a new one.
      this.pumpGate();
    });
    void this.clock.track(RESEARCH_TRACK_LABEL, this.scoring);
  }

  private async scoreQueue(): Promise<void> {
    while (!this.stopped) {
      const idea = this.toScore.shift();
      if (idea === undefined) return;
      const record = await this.gate.score(idea);
      this.onRecord(record);
      if (record.decision !== "queued") continue;
      this.toRun.push(idea);
      this.pumpJobs();
    }
  }

  /**
   * Starts as many queued jobs as the budget allows.
   *
   * Two caps, checked in that order because they fail differently: a
   * concurrency slot frees when a job finishes, which calls back here, while
   * the ten-minute window frees with the clock, which nothing would otherwise
   * notice — hence the timer armed for the moment the oldest start ages out.
   */
  private pumpJobs(): void {
    if (this.stopped || this.run === undefined) return;
    while (this.toRun.length > 0) {
      if (this.inFlight.size >= this.maxConcurrent) {
        this.logger.log(
          `[research] holding ${this.toRun.length} idea(s): ${this.inFlight.size} job(s) already running`,
        );
        return;
      }
      const recent = this.recentStarts();
      const oldest = recent[0];
      if (recent.length >= this.maxPerWindow && oldest !== undefined) {
        const freesAt = oldest + this.windowMs;
        this.logger.log(
          `[research] holding ${this.toRun.length} idea(s): ${recent.length} job(s) started in the last ` +
            `${Math.round(this.windowMs / 60_000)} min, next slot in ${Math.max(0, Math.round((freesAt - this.clock.now()) / 1000))} s`,
        );
        this.armWindowTimer(freesAt);
        return;
      }
      const idea = this.toRun.shift();
      if (idea === undefined) return;
      this.start(idea);
    }
  }

  private start(idea: ResearchIdea): void {
    const run = this.run;
    if (run === undefined) return;
    this.starts.push(this.clock.now());
    const job = run(idea).finally(() => {
      this.inFlight.delete(job);
      this.pumpJobs();
    });
    this.inFlight.add(job);
    this.onRecord({
      kind: "start",
      atMs: this.clock.now(),
      ideaId: idea.id,
      question: idea.question,
      running: this.inFlight.size,
      startedInWindow: this.recentStarts().length,
    });
    this.logger.log(`[research] started ${idea.id}: ${idea.question}`);
  }

  /** Start times still inside the window, oldest first. */
  private recentStarts(): number[] {
    const since = this.clock.now() - this.windowMs;
    return this.starts.filter((at) => at > since);
  }

  /** One timer, for the moment the oldest start leaves the window. */
  private armWindowTimer(freesAt: number): void {
    if (this.cancelWindowTimer !== undefined) return;
    const delay = Math.max(1, freesAt - this.clock.now() + 1);
    this.cancelWindowTimer = this.clock.setTimeout(() => {
      this.cancelWindowTimer = undefined;
      this.pumpJobs();
    }, delay);
  }
}
