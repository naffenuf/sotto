/**
 * Keeps a verdict about every answer waiting to be spoken (PRD V3-004).
 *
 * One watcher per session. {@link StillCurrentWatcher.watch} starts the first
 * check the moment a packet is ready, and every later final turn starts
 * another, so {@link StillCurrentWatcher.verdict} is always a cached answer
 * that {@link Reservations} can read in the instant between noticing a pause
 * and opening an utterance. Nothing here is ever awaited by the speaking
 * path: the PRD's "never in the critical path" is the whole shape of it.
 *
 * Three decisions worth knowing about.
 *
 * **No turns since the question means `current`, with no call.** The room has
 * not said anything that could have moved on, so there is nothing to classify
 * and nothing to pay for.
 *
 * **One check at a time per answer, and the next turn re-arms it.** A turn
 * arriving while a check is in flight marks it stale rather than starting a
 * second call about the same question, and the check that comes back starts
 * the fresh one. Two people talking over a twenty-second search would
 * otherwise be five calls about one answer.
 *
 * **A failed check keeps the last verdict.** Or `current`, when there is none:
 * the same rule the candidate gate follows, because losing the check should
 * cost judgment rather than speech.
 */
import type { SpeakerNames } from "../../shared/events.js";
import type { StillCurrentState } from "../../shared/spoken.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { systemClock, type Clock } from "../clock.js";
import {
  StillCurrentSchema,
  type StillCurrentClassifier,
  type StillCurrentKind,
  type StillCurrentResult,
  type StillCurrentVerdict,
} from "./stillCurrent.js";

/** A check nobody is waiting for still must not run forever. */
export const STILL_CURRENT_TIMEOUT_MS = 8_000;

/** Turns the check is given. Enough to see the subject change, and no more. */
export const STILL_CURRENT_CONTEXT_TURNS = 8;

/**
 * The cached answer about one waiting answer.
 *
 * Shared (`shared/spoken.ts`) because a spoken line records the verdict it was
 * decided on and the eval scores that record (V3-010).
 */
export type { StillCurrentState } from "../../shared/spoken.js";

/** What is being watched: one question, and the answer Sotto found for it. */
interface Watched {
  /** A correction (V3-008) is framed differently to the model. */
  kind: StillCurrentKind;
  question: string;
  answer: string;
  /** Session clock when the question went final; later turns are the context. */
  askedAtMs: number;
  state: StillCurrentState;
  /** A turn arrived while a check was in flight, so the verdict is stale. */
  stale: boolean;
  inFlight: boolean;
}

export interface StillCurrentWatcherOptions {
  clock: Clock;
  /** Real time, because a replay's clock stands still inside a model call. */
  wallClock?: Clock;
  classify: StillCurrentClassifier;
  speakers: () => SpeakerNames;
  /** Every verdict, for `timing.jsonl`. */
  onTiming: (record: Record<string, unknown>) => void;
  /** A verdict landed: whoever is holding a line on it can look again. */
  onVerdict?: (ideaId: string) => void;
}

/** The verdict a question starts with, and the one a failed check leaves. */
const CURRENT: StillCurrentState = {
  verdict: "current",
  agrees: false,
  latencyMs: 0,
  fallback: true,
  turns: 0,
  coversTurnId: null,
};

export class StillCurrentWatcher {
  private readonly wall: Clock;
  private readonly watched = new Map<string, Watched>();
  /** Final turns of the conversation, newest last: the checks' context. */
  private readonly history: TurnUpdate[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;

  constructor(private readonly options: StillCurrentWatcherOptions) {
    this.wall = options.wallClock ?? systemClock;
  }

  /**
   * A sourced answer is ready for one of the room's own questions: start
   * watching whether the room still wants it.
   *
   * V3-008 watches one more thing the same way — a correction a `bold`
   * session may say out loud — keyed by its candidate id. The only difference
   * is `kind`, which decides how the two are described to the model.
   */
  watch(
    ideaId: string,
    asked: {
      kind?: StillCurrentKind;
      question: string;
      answer: string;
      askedAtMs: number;
    },
  ): void {
    if (this.stopped || this.watched.has(ideaId)) return;
    this.watched.set(ideaId, {
      kind: asked.kind ?? "question",
      question: asked.question,
      answer: asked.answer,
      askedAtMs: asked.askedAtMs,
      state: CURRENT,
      stale: true,
      inFlight: false,
    });
    this.check(ideaId);
  }

  /** The cached verdict, or `undefined` for an answer nobody is watching. */
  verdict(ideaId: string): StillCurrentState | undefined {
    return this.watched.get(ideaId)?.state;
  }

  /** The newest human final turn this watcher has seen, or `null`. */
  latestTurnId(): string | null {
    return this.history.at(-1)?.turnId ?? null;
  }

  /**
   * Whether the cached verdict was made over everything the room has said:
   * the one question the speaking path asks before saying a line unasked.
   * A question nobody is watching is covered (there is nothing to judge);
   * one whose last check failed is not, until a check succeeds — losing the
   * check costs the line its turn, not the room an answer nobody wants.
   */
  covers(ideaId: string): boolean {
    const watched = this.watched.get(ideaId);
    if (watched === undefined) return true;
    if (watched.state.fallback && watched.state.turns > 0) return false;
    return (watched.state.coversTurnId ?? null) === this.latestTurnId();
  }

  /** Nothing more to say about this question: stop paying for verdicts on it. */
  forget(ideaId: string): void {
    this.watched.delete(ideaId);
  }

  /** Final turns only: a partial is the same words arriving again. */
  acceptTurn(turn: TurnUpdate): void {
    if (this.stopped || !turn.final || isSottoTurn(turn)) return;
    if (this.history.some((previous) => previous.turnId === turn.turnId)) return;
    this.history.push(turn);
    if (this.history.length > STILL_CURRENT_CONTEXT_TURNS) this.history.shift();
    for (const ideaId of this.watched.keys()) this.check(ideaId);
  }

  /** Session drain waits for what is in flight, so a last verdict is not lost. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Aborts what is in flight; a verdict that lands afterwards changes nothing. */
  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  /** Starts one check, unless one is already out or nothing has changed. */
  private check(ideaId: string): void {
    const watched = this.watched.get(ideaId);
    if (watched === undefined || this.stopped) return;
    if (watched.inFlight) {
      watched.stale = true;
      return;
    }
    const since = this.history.filter(
      (turn) => (turn.endMs ?? turn.startMs) > watched.askedAtMs,
    );
    // Nobody has spoken since the question, so nothing can have moved on.
    if (since.length === 0) {
      watched.state = { ...CURRENT, turns: 0, coversTurnId: null };
      watched.stale = false;
      this.options.onVerdict?.(ideaId);
      return;
    }
    watched.inFlight = true;
    watched.stale = false;
    const work = this.decide(ideaId, watched, since);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    void this.options.clock.track("still-current", work);
  }

  /** One verdict, logged whichever way it comes out. */
  private async decide(
    ideaId: string,
    watched: Watched,
    since: readonly TurnUpdate[],
  ): Promise<void> {
    const started = this.wall.now();
    const result = await this.run(watched, since);
    const latencyMs = this.wall.now() - started;
    watched.inFlight = false;
    if (this.stopped || !this.watched.has(ideaId)) return;
    // A failed check keeps whatever was decided last; it must not silence the
    // answer, which is what a `moved_on` default would amount to.
    const covers = since.at(-1)?.turnId ?? null;
    const state: StillCurrentState =
      result === null
        ? { ...watched.state, latencyMs, fallback: true, turns: since.length }
        : {
            verdict: result.verdict,
            agrees: result.agrees,
            latencyMs,
            fallback: false,
            turns: since.length,
            coversTurnId: covers,
          };
    watched.state = state;
    this.options.onTiming({
      stage: "still_current",
      atMs: this.options.clock.now(),
      ideaId,
      verdict: state.verdict,
      agrees: state.agrees,
      turns: since.length,
      latencyMs,
      ...(result === null ? { fallback: true } : { why: result.why }),
    });
    // Turns arrived while this was out: the verdict they would have changed is
    // the one being spoken from, so ask again rather than wait for the next.
    if (watched.stale) this.check(ideaId);
    else this.options.onVerdict?.(ideaId);
  }

  /** Bounded by real time, because a replay's clock stands still inside a call. */
  private async run(
    watched: Watched,
    since: readonly TurnUpdate[],
  ): Promise<StillCurrentResult | null> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("still-current check cancelled or timed out")),
        { once: true },
      );
    });
    const cancelTimeout = this.wall.setTimeout(
      () => controller.abort(),
      STILL_CURRENT_TIMEOUT_MS,
    );
    try {
      return StillCurrentSchema.parse(
        await Promise.race([
          this.options.classify(
            {
              kind: watched.kind,
              question: watched.question,
              answer: watched.answer,
              since,
              speakers: this.options.speakers(),
            },
            controller.signal,
          ),
          cancelled,
        ]),
      );
    } catch {
      return null;
    } finally {
      cancelTimeout();
      this.controllers.delete(controller);
    }
  }
}
