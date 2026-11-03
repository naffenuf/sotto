/**
 * V3-002: watches the room's final turns for a question Sotto could look up.
 *
 * The shape is V2-008's `AddressWatcher` minus the arming and the early
 * check: a question is classified when the turn goes final, once per turn, and
 * the whole budget for being useful is the PRD's four seconds — a ~2 s Spark
 * call inside a 6 s wall-clock deadline, after which the verdict is `none` and
 * the line says `fallback: true`.
 *
 * The same call answers V3-013's question too — whether a `decision` turn
 * *settled* something — so a read-back arrives with the turn rather than with
 * the board update a dozen seconds later, and costs nothing extra.
 *
 * Every human turn reaches the model (post-V3-011): the word check that used
 * to gate it missed every need said as a statement, and a low-effort call per
 * turn is a few dollars a meeting. Two things never do. A turn that addresses
 * Sotto by name is the address path's — the room asked *Sotto*, so an answer
 * is owed whatever kind of question it is, and classifying it here would
 * duplicate the answer. And an echo of Sotto's own voice, a playback command
 * or anything the barge-in owns is excluded by the caller, exactly as the wake
 * watcher's turns are.
 *
 * Unlike the address check the calls are not serialized: two people wondering
 * two things in four seconds is two lookups, and making the second wait for
 * the first costs it the only thing it has. Each call is registered with
 * `clock.track`, so a `max`-speed replay still waits for it rather than
 * running the conversation past a question it has only just heard.
 */
import type { SpeakerNames } from "../../shared/events.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { systemClock, type Clock } from "../clock.js";
import { detectsAddress } from "../wake.js";
import {
  QuestionSchema,
  type DecisionClosing,
  type OpenQuestion,
  type QuestionClassifier,
  type QuestionResult,
} from "./question.js";

/**
 * The classifier's deadline, on the wall clock. Nothing in the room waits on
 * this verdict — a late `open_question` starts its lookup late, which beats
 * never — so it is generous: the API answered the bus turns in 6–14 s on a
 * slow afternoon (`2026-11-03`), and the old 6 s would have dropped every one.
 */
export const QUESTION_TIMEOUT_MS = 20_000;

/** How many previous final turns the classifier is given, as V3-002 specifies. */
export const QUESTION_CONTEXT_TURNS = 4;

export interface QuestionWatcherOptions {
  clock: Clock;
  /** Real time, for the latency the room would have felt. */
  wallClock?: Clock;
  classify: QuestionClassifier;
  speakers: () => SpeakerNames;
  /**
   * Whether this turn belongs to the follow-up window (V3-014), in which case
   * it is the address path's: the room is still talking *to* Sotto.
   */
  inFollowUpWindow?: (turn: TurnUpdate) => boolean;
  /** Something the room wondered aloud that a lookup can answer (V3-003). */
  onOpenQuestion: (question: OpenQuestion) => void;
  /**
   * The group just settled something (V3-013), off the same call: a decision
   * read back the instant it lands rather than a board update later.
   */
  onDecisionClosing?: (closing: DecisionClosing) => void;
  /** Every classification, including the ones that cost nothing. */
  onTiming: (record: Record<string, unknown>) => void;
}

/** One watcher per session, retired on Stop so a late verdict starts no search. */
export class QuestionWatcher {
  private readonly wall: Clock;
  private readonly seen = new Set<string>();
  private readonly ignored = new Set<string>();
  private readonly history: TurnUpdate[] = [];
  private readonly inFlight = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: QuestionWatcherOptions) {
    this.wall = options.wallClock ?? systemClock;
  }

  /** Echoes, playback commands and side talk inform the context but ask nothing. */
  ignoreTurn(turnId: string): void {
    this.ignored.add(turnId);
    this.inFlight.get(turnId)?.abort();
    this.inFlight.delete(turnId);
  }

  /** Human side talk is context for the next question even when it asks nothing. */
  remember(turn: TurnUpdate): void {
    if (!turn.final || isSottoTurn(turn)) return;
    if (this.history.some((previous) => previous.turnId === turn.turnId)) return;
    this.history.push(turn);
    if (this.history.length > QUESTION_CONTEXT_TURNS) this.history.shift();
  }

  /** Classifies an eligible final turn exactly once. Partials are not read. */
  acceptTurn(turn: TurnUpdate): void {
    // Sotto's own line is in the transcript (V2-008a), never in its ears:
    // answering its own question is the one loop with no way out.
    if (isSottoTurn(turn) || !turn.final) return;
    if (this.stopped || this.seen.has(turn.turnId) || this.ignored.has(turn.turnId)) return;
    this.seen.add(turn.turnId);
    const previous = [...this.history];
    this.remember(turn);
    const atMs = this.options.clock.now();
    // The room addressed Sotto: the address path owes it an answer (V2-008),
    // and a question asked of Sotto is not a question asked of the room.
    if (detectsAddress(turn.text) || this.options.inFollowUpWindow?.(turn) === true) {
      this.options.onTiming({
        stage: "question_skipped", atMs, turnId: turn.turnId, reason: "addressed",
      });
      return;
    }
    // Every turn is read (post-V3-011). The word check that used to stand
    // here — question words, a question mark, "wonder" — let "we need the bus
    // schedules from New York to Philadelphia" go by unread for three minutes
    // (`2026-11-03_0945-mic`): a need is wondered aloud as a statement as
    // often as a question, and only a model can tell. A low-effort call is
    // 1.5–2.5 s and a quarter of a cent; a meeting is a few dollars of them.
    const work = this.decide(turn, previous, atMs);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    void this.options.clock.track("question", work);
  }

  /** Session drain waits for the verdicts, so a last question still starts a search. */
  async flush(): Promise<void> {
    // A verdict can be added while we wait for one, so drain until it is empty.
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Aborts what is in flight; a verdict that lands afterwards changes nothing. */
  stop(): void {
    this.stopped = true;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  /** One classification, logged whichever way it comes out. */
  private async decide(
    turn: TurnUpdate,
    previous: readonly TurnUpdate[],
    atMs: number,
  ): Promise<void> {
    const started = this.wall.now();
    const result = await this.run(turn, previous);
    if (this.stopped || this.ignored.has(turn.turnId)) return;
    const latencyMs = this.wall.now() - started;
    this.options.onTiming({
      stage: "question",
      atMs: this.options.clock.now(),
      turnId: turn.turnId,
      kind: result?.kind ?? "none",
      latencyMs,
      ...(result?.closing === true ? { closing: true, decision: result.decision } : {}),
      ...(result === null ? { fallback: true } : {}),
    });
    if (result === null) return;
    const speaker = turn.speaker;
    const named = speaker === null ? null : this.options.speakers()[speaker] ?? speaker;
    // V3-013: the group settled something. The read-back is the one thing
    // this watcher produces that is not about a question at all.
    if (result.closing) {
      this.options.onDecisionClosing?.({
        turnId: turn.turnId,
        decision: result.decision,
        decidedBy: named,
        decidedAtMs: atMs,
      });
      return;
    }
    if (result.kind !== "open_question") return;
    this.options.onOpenQuestion({
      turnId: turn.turnId,
      question: result.question,
      topic: result.topic,
      askedBy: named,
      askedAtMs: atMs,
    });
  }

  /** Bounded by real time, because a replay's clock stands still inside a call. */
  private async run(
    turn: TurnUpdate,
    previous: readonly TurnUpdate[],
  ): Promise<QuestionResult | null> {
    const controller = new AbortController();
    this.inFlight.set(turn.turnId, controller);
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("question classification cancelled or timed out")),
        { once: true },
      );
    });
    const cancelTimeout = this.wall.setTimeout(() => controller.abort(), QUESTION_TIMEOUT_MS);
    try {
      return QuestionSchema.parse(
        await Promise.race([
          this.options.classify(
            { turn, previous, speakers: this.options.speakers() },
            controller.signal,
          ),
          cancelled,
        ]),
      );
    } catch {
      return null;
    } finally {
      cancelTimeout();
      this.inFlight.delete(turn.turnId);
    }
  }
}
