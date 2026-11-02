/**
 * V3-014: the few seconds after an answer in which the room needs no wake
 * word.
 *
 * Once Sotto has answered out loud, "why's that?" is obviously addressed to
 * it and "okay EJ, what do you think?" obviously is not — and no lexical rule
 * can tell them apart, because neither says the name. So while the window is
 * open every final human turn is read by {@link FollowUpClassifier}: a
 * `to_sotto` is answered exactly as a wake question is, and anything else
 * closes the window without a word.
 *
 * Everything here leans one way. The whole feature is a false-positive risk —
 * answering a question meant for a person is worse than making somebody say
 * "Sotto" again — so:
 *
 *   - a verdict that is not `to_sotto`, a verdict that does not parse, a
 *     classification that failed and one that timed out all **close** the
 *     window;
 *   - a turn that names somebody else in the room closes it with **no call at
 *     all**, because that is the one case the room has already decided;
 *   - {@link FOLLOWUP_TIMEOUT_MS} of nobody saying anything closes it, and so
 *     does {@link FOLLOWUP_MAX_HUMAN_TURNS} turns going by without one of them
 *     being a follow-up.
 *
 * A turn that *does* say Sotto's name stays the address path's (V2-008): it
 * is owed an answer whatever the window is doing, and classifying it here
 * would answer it twice. That is also what keeps the cost at one call per
 * turn — {@link QuestionWatcher} skips a turn in the window for the mirror
 * reason, since the room is talking to Sotto rather than wondering aloud.
 *
 * The clock is the session's, like the policy's pause: the window is a length
 * of *conversation*, and a `max`-speed replay must see the same twenty
 * seconds a room would.
 */
import type { SpeakerNames } from "../../shared/events.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { systemClock, type Clock } from "../clock.js";
import { detectsAddress } from "../wake.js";
import type { WakeTrigger } from "../wakeWatcher.js";
import {
  FollowUpSchema,
  type FollowUpClassifier,
  type FollowUpResult,
  type LastAnswer,
} from "./followUp.js";

/** How long the window survives with nobody saying anything. */
export const FOLLOWUP_TIMEOUT_MS = 20_000;

/**
 * How many final turns may go by in one window without a follow-up among
 * them.
 *
 * A verdict that is not `to_sotto` closes the window on its own, so in the
 * ordinary case the first turn between two humans is the one that closes it.
 * This is the backstop for the turns that have no verdict yet: two people
 * carrying on their own conversation faster than the classifier can answer
 * must not leave Sotto listening across it. The count is reset by a follow-up
 * and by the window reopening after an answer, so a second and a third
 * follow-up are as welcome as the first.
 */
export const FOLLOWUP_MAX_HUMAN_TURNS = 2;

/** A slow classifier must not hold the window open; the verdict is then `to_room`. */
export const FOLLOWUP_TIMEOUT_CALL_MS = 6_000;

/** Why a window closed, as `timing.jsonl` records it. */
export type FollowUpCloseReason =
  | "to_room"
  | "closing"
  | "named_person"
  | "unsure"
  | "timeout"
  | "human_turns"
  | "session_ended";

export interface FollowUpWindowOptions {
  clock: Clock;
  /** Real time, for the latency the room would have felt. */
  wallClock?: Clock;
  classify: FollowUpClassifier;
  speakers: () => SpeakerNames;
  /** Whether the indicator should show that Sotto is still in the conversation. */
  onInConversation: (open: boolean) => void;
  /** A follow-up, to be answered exactly as a wake question is (US-018). */
  onFollowUp: (trigger: WakeTrigger) => void;
  onTiming: (record: Record<string, unknown>) => void;
}

/** One open window. */
interface OpenWindow {
  answer: LastAnswer;
  /** Session clock when it opened, for the log. */
  openedAtMs: number;
  /** Final turns accepted since it last opened. */
  turns: number;
  /** Cancels the inactivity timer. */
  cancel: () => void;
}

/** One window per session, closed on Stop so a late verdict cannot answer. */
export class FollowUpWindow {
  private readonly wall: Clock;
  private readonly seen = new Set<string>();
  private readonly ignored = new Set<string>();
  private readonly history: TurnUpdate[] = [];
  private open: OpenWindow | undefined;
  private pending: Promise<void> = Promise.resolve();
  /** The classifications in flight, by turn, so Stop can abandon all of them. */
  private readonly inFlight = new Map<string, AbortController>();
  private stopped = false;
  private announced = false;

  constructor(private readonly options: FollowUpWindowOptions) {
    this.wall = options.wallClock ?? systemClock;
  }

  /** Whether the room may carry on without the wake word right now. */
  isOpen(): boolean {
    return this.open !== undefined;
  }

  /**
   * Sotto finished answering: the room may follow up.
   *
   * Called for an answer the room was given — spoken or on screen — whether
   * it was asked by name, by a follow-up, or by the pipeline itself. Opening
   * it again resets the inactivity timer and the turn count, which is what
   * "the window stays open from the end of that answer" means.
   */
  answered(answer: LastAnswer): void {
    if (this.stopped) return;
    const reopened = this.open !== undefined;
    this.open?.cancel();
    const openedAtMs = this.options.clock.now();
    this.open = { answer, openedAtMs, turns: 0, cancel: this.arm() };
    this.options.onTiming({
      stage: "followup_window",
      event: "opened",
      atMs: openedAtMs,
      reopened,
      question: answer.question,
    });
    this.announce();
  }

  /** Human side talk is context for the next follow-up without being one. */
  remember(turn: TurnUpdate): void {
    if (!turn.final || isSottoTurn(turn)) return;
    if (this.history.some((previous) => previous.turnId === turn.turnId)) return;
    this.history.push(turn);
    if (this.history.length > 4) this.history.shift();
  }

  /** Echoes and anything the barge-in owns inform the context but ask nothing. */
  ignoreTurn(turnId: string): void {
    this.ignored.add(turnId);
    this.inFlight.get(turnId)?.abort();
    this.inFlight.delete(turnId);
  }

  /**
   * Reads one final turn.
   *
   * Partials are not read: nothing here is urgent enough to be worth acting
   * on half a sentence, and the indicator is already up for as long as the
   * window is.
   */
  acceptTurn(turn: TurnUpdate): void {
    // Sotto's own line (V2-008a) is in the transcript, never in its ears.
    if (isSottoTurn(turn) || !turn.final) return;
    if (this.stopped || this.seen.has(turn.turnId) || this.ignored.has(turn.turnId)) return;
    this.seen.add(turn.turnId);
    const previous = [...this.history];
    this.remember(turn);
    if (this.open === undefined) return;
    // The room said the name: V2-008 owes it an answer whatever kind of
    // question it is, and the window has nothing to add.
    if (detectsAddress(turn.text)) {
      this.options.onTiming({
        stage: "followup",
        atMs: this.options.clock.now(),
        turnId: turn.turnId,
        kind: "addressed",
      });
      return;
    }
    this.open.turns += 1;
    // Read synchronously, because this is the one rule about turns the
    // classifier has not answered yet: verdicts are serialized, and the
    // first one that is not a follow-up closes the window on its own, so the
    // count can only run away when people are talking faster than the
    // classifier can keep up.
    if (this.open.turns > FOLLOWUP_MAX_HUMAN_TURNS) {
      this.close("human_turns");
      return;
    }
    const window = this.open;
    this.pending = this.pending.then(() => this.decide(turn, previous, window));
    void this.options.clock.track("followup", this.pending);
  }

  /** Session drain waits for a verdict, so a last follow-up still gets answered. */
  async flush(): Promise<void> {
    await this.pending;
  }

  /** Closes the window and abandons what is in flight. Idempotent. */
  stop(): void {
    this.stopped = true;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.close("session_ended");
  }

  /** One turn's verdict, logged whichever way it comes out. */
  private async decide(
    turn: TurnUpdate,
    previous: readonly TurnUpdate[],
    window: OpenWindow,
  ): Promise<void> {
    // The window may have closed while this turn waited its place in the
    // queue; a verdict about a closed window answers nothing.
    if (this.stopped || this.open !== window || this.ignored.has(turn.turnId)) return;
    const named = this.namesSomebodyElse(turn);
    if (named !== null) {
      this.options.onTiming({
        stage: "followup",
        atMs: this.options.clock.now(),
        turnId: turn.turnId,
        kind: "to_room",
        named,
        latencyMs: 0,
      });
      this.close("named_person");
      return;
    }
    const started = this.wall.now();
    const result = await this.run(turn, previous, window.answer);
    if (this.stopped || this.open !== window || this.ignored.has(turn.turnId)) return;
    this.options.onTiming({
      stage: "followup",
      atMs: this.options.clock.now(),
      turnId: turn.turnId,
      kind: result?.kind ?? "unsure",
      latencyMs: this.wall.now() - started,
      ...(result === null ? { fallback: true } : {}),
    });
    if (result === null) {
      // When unsure, close: a verdict nobody could read is not permission to
      // answer a question that may have been meant for a person.
      this.close("unsure");
      return;
    }
    if (result.kind !== "to_sotto") {
      this.close(result.kind);
      return;
    }
    // Still talking to Sotto. The window stays open — the inactivity timer is
    // re-armed from the end of the answer this is about to produce — and the
    // question goes the same way a wake question does.
    window.turns = 0;
    window.cancel();
    window.cancel = this.arm();
    this.options.onFollowUp({
      turnId: turn.turnId,
      speaker: turn.speaker,
      question: result.question,
    });
  }

  /** One classification, bounded by real time. Never rejects. */
  private async run(
    turn: TurnUpdate,
    previous: readonly TurnUpdate[],
    answer: LastAnswer,
  ): Promise<FollowUpResult | null> {
    const controller = new AbortController();
    this.inFlight.set(turn.turnId, controller);
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("follow-up classification cancelled or timed out")),
        { once: true },
      );
    });
    const cancelTimeout = this.wall.setTimeout(
      () => controller.abort(),
      FOLLOWUP_TIMEOUT_CALL_MS,
    );
    try {
      return FollowUpSchema.parse(
        await Promise.race([
          this.options.classify(
            { turn, previous, speakers: this.options.speakers(), answer },
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

  /**
   * The name of somebody else in the room this turn speaks to, or `null`.
   *
   * Deterministic and free: a turn that says a colleague's name has already
   * been addressed, so there is nothing for a model to weigh. Only the names
   * the group gave its own voices count — a label like `A` is not a name
   * anybody says out loud, and Sotto's own name is the address path's.
   */
  private namesSomebodyElse(turn: TurnUpdate): string | null {
    for (const [label, name] of Object.entries(this.options.speakers())) {
      if (label === turn.speaker) continue;
      const trimmed = name.trim();
      if (trimmed.length < 2) continue;
      const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}($|[^\\p{L}\\p{N}])`, "iu");
      if (pattern.test(turn.text)) return trimmed;
    }
    return null;
  }

  /** Arms the inactivity timer, returning its cancel. */
  private arm(): () => void {
    return this.options.clock.setTimeout(() => this.close("timeout"), FOLLOWUP_TIMEOUT_MS);
  }

  private close(reason: FollowUpCloseReason): void {
    const window = this.open;
    if (window === undefined) {
      this.announce();
      return;
    }
    this.open = undefined;
    window.cancel();
    this.options.onTiming({
      stage: "followup_window",
      event: "closed",
      atMs: this.options.clock.now(),
      reason,
      openMs: Math.max(0, this.options.clock.now() - window.openedAtMs),
      turns: window.turns,
    });
    this.announce();
  }

  /** Publishes the indicator, on a change only. */
  private announce(): void {
    const open = !this.stopped && this.open !== undefined;
    if (open === this.announced) return;
    this.announced = open;
    this.options.onInConversation(open);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
