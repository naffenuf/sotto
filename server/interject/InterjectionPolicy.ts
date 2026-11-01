/**
 * The policy in motion (PRD US-014): what is waiting, what has been said, and
 * when to look again.
 *
 * `policy.ts` next door holds the rules and is pure. This is the part with a
 * memory — the candidates holding out for a pause, the interjects already
 * spent, the frequency and boldness the header last set (V2-017) — and the
 * part with a clock, because two of the rules change their mind with nothing
 * arriving to say so: silence crosses {@link PAUSE_MS} while nobody is
 * talking, and the courtesy window after a wake phrase runs out. Both are
 * timers, so a held candidate is re-checked at the moment it becomes
 * deliverable rather than at the next frame, which would be the next person
 * starting to speak — exactly the wrong moment.
 *
 * Every decision goes to `candidates.jsonl`, but only when it *changes*: a
 * candidate waiting through four turns of conversation is one `hold` line and
 * then whatever became of it, not forty identical ones.
 */
import type { Candidate, DecisionLogRecord } from "../../shared/candidates.js";
import {
  defaultPolicySettings,
  type Decision,
  type DecisionReason,
  type DeliveredLevel,
  type PolicyDecision,
  type PolicySettings,
} from "../../shared/policy.js";
import type { PauseState, TurnUpdate } from "../../shared/turns.js";
import type { Clock } from "../clock.js";
import { decide, nextCheckDelay, type PolicyHistory, type PolicyInput } from "./policy.js";

type Logger = Pick<Console, "log" | "warn">;

/** Something the policy decided to put on the stage (US-015 delivers it). */
export interface Interjection {
  candidate: Candidate;
  /** The level it is shown at — which the budget may have turned down. */
  level: DeliveredLevel;
  /** The whole decision, so a card can show why it is a glow and not more. */
  decision: PolicyDecision;
  /** When it was decided, on the session clock. */
  atMs: number;
}

export interface InterjectionPolicyOptions {
  /** The session's clock — simulated for a replay, real for a live session. */
  clock: Clock;
  /** Whether anybody is talking, read straight off the turn assembler. */
  pauseState: () => PauseState;
  /** Where the session starts; the header can change both live (V2-017). */
  settings?: PolicySettings;
  /** Records every decision in `candidates.jsonl`. */
  onRecord: (record: DecisionLogRecord) => void;
  /** Hands a delivered candidate to the stage (US-015). */
  onDeliver: (interjection: Interjection) => void;
  logger?: Logger;
}

/** One candidate the policy has not finished with. */
interface Held {
  candidate: Candidate;
  /** When the policy first saw it, which is what expiry counts from. */
  seenAtMs: number;
  /** {@link InterjectionPolicy.turnsSeen} when it arrived. */
  turnsAtSeen: number;
  /** The last decision written down for it, so a repeat is not written twice. */
  logged: { decision: Decision; reason: DecisionReason } | undefined;
}

export class InterjectionPolicy {
  private readonly clock: Clock;
  private readonly pauseState: () => PauseState;
  private readonly onRecord: (record: DecisionLogRecord) => void;
  private readonly onDeliver: (interjection: Interjection) => void;
  private readonly logger: Logger;

  private policySettings: PolicySettings;
  /** Candidates waiting for a better moment, oldest first. */
  private holding: Held[] = [];
  /** Final turns in the whole session: the other half of the expiry rule. */
  private turnsSeen = 0;
  /** When each visible interject went out, oldest first. */
  private readonly interjectedAtMs: number[] = [];
  /** True while an answer is being written (US-018); set from outside. */
  private answerThinking = false;
  /** When the wake phrase was last heard (US-017); set from outside. */
  private wakeAtMs: number | null = null;
  /** Cancels the pending re-check, if there is one. */
  private cancelTimer: (() => void) | undefined;
  private stopped = false;
  private deliveredCount = 0;

  constructor(options: InterjectionPolicyOptions) {
    this.clock = options.clock;
    this.pauseState = options.pauseState;
    this.onRecord = options.onRecord;
    this.onDeliver = options.onDeliver;
    this.policySettings = options.settings ?? defaultPolicySettings();
    this.logger = options.logger ?? console;
  }

  /** How often and how boldly the session is set to contribute. */
  settings(): PolicySettings {
    return this.policySettings;
  }

  /**
   * Changes the frequency or the boldness mid-conversation, and re-decides
   * whatever is waiting: turning Sotto up should let a held thought through
   * now, not at the next turn.
   */
  setSettings(settings: PolicySettings): void {
    if (
      settings.frequency === this.policySettings.frequency &&
      settings.boldness === this.policySettings.boldness
    ) {
      return;
    }
    this.policySettings = settings;
    this.logger.log(`[policy] now ${settings.frequency}/${settings.boldness}`);
    this.review();
  }

  /** How many candidates are still waiting for a moment. */
  heldCount(): number {
    return this.holding.length;
  }

  /** How many cards the policy has put on the stage. */
  delivered(): number {
    return this.deliveredCount;
  }

  /** When each visible interject went out, oldest first. */
  interjects(): readonly number[] {
    return this.interjectedAtMs;
  }

  /**
   * Takes a candidate from the observer (US-012) or from the fact check
   * (US-013) and decides about it there and then — which, mid-sentence, is
   * usually a `hold`.
   */
  accept(candidate: Candidate): void {
    if (this.stopped) return;
    this.holding.push({
      candidate,
      seenAtMs: this.clock.now(),
      turnsAtSeen: this.turnsSeen,
      logged: undefined,
    });
    this.review();
  }

  /**
   * Takes one turn snapshot. Final turns count towards expiry; every snapshot,
   * partials included, is a chance that the pause state changed — a
   * `speechEnd` arrives as a partial, and it is the one that opens a pause.
   */
  acceptTurn(turn: TurnUpdate): void {
    if (this.stopped) return;
    if (turn.final) this.turnsSeen += 1;
    this.review();
  }

  /**
   * The courtesy hook the answer agent (US-018) calls: nothing is delivered
   * while an answer is still being written, and whatever was waiting is
   * re-decided the moment it finishes.
   */
  setAnswerThinking(thinking: boolean): void {
    if (this.stopped || thinking === this.answerThinking) return;
    this.answerThinking = thinking;
    this.review();
  }

  /** Playback can end without an ASR frame; reconsider its held cards (V2-006). */
  playbackChanged(): void {
    this.review();
  }

  /**
   * The courtesy hook wake-phrase detection (US-017) calls: for the next
   * {@link COURTESY_MS} the floor belongs to whoever just addressed Sotto.
   */
  wakePhraseDetected(): void {
    if (this.stopped) return;
    this.wakeAtMs = this.clock.now();
    this.review();
  }

  /**
   * Closes the session out: one last look — a conversation ends in silence, so
   * the last pause is a real one — and then everything still waiting is
   * written down rather than left unaccounted for.
   */
  flush(): void {
    if (this.stopped) return;
    this.review();
    const nowMs = this.clock.now();
    const stranded = this.holding;
    this.holding = [];
    this.disarm();
    for (const held of stranded) {
      const decision = decide(this.inputFor(held, nowMs, this.pauseState()));
      this.write(held, { ...decision, decision: "silent", reason: "session_ended" }, nowMs);
    }
  }

  /** No more decisions. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  /** Re-decides everything that is waiting, and arms the next re-check. */
  private review(): void {
    if (this.stopped || this.holding.length === 0) return;
    const nowMs = this.clock.now();
    const pause = this.pauseState();
    const waiting: Held[] = [];
    for (const held of this.holding) {
      // Each candidate sees the history the ones before it have just made:
      // two interjects in one pause is one interject and one glow.
      const decision = decide(this.inputFor(held, nowMs, pause));
      this.write(held, decision, nowMs);
      if (decision.decision === "hold") waiting.push(held);
      else if (decision.decision === "glow" || decision.decision === "interject") {
        this.deliver(held, decision.decision, decision, nowMs);
      }
    }
    this.holding = waiting;
    this.schedule(nowMs, pause);
  }

  private inputFor(held: Held, nowMs: number, pause: PauseState): PolicyInput {
    const history: PolicyHistory = {
      seenAtMs: held.seenAtMs,
      turnsWaited: this.turnsSeen - held.turnsAtSeen,
      interjectedAtMs: this.interjectedAtMs,
      answerThinking: this.answerThinking,
      wakeAtMs: this.wakeAtMs,
    };
    return {
      scores: held.candidate.scores,
      type: held.candidate.type,
      verified: held.candidate.verification !== undefined,
      nowMs,
      pause,
      settings: this.policySettings,
      history,
    };
  }

  private deliver(
    held: Held,
    level: DeliveredLevel,
    decision: PolicyDecision,
    nowMs: number,
  ): void {
    if (level === "interject") this.interjectedAtMs.push(nowMs);
    this.deliveredCount += 1;
    this.onDeliver({ candidate: held.candidate, level, decision, atMs: nowMs });
  }

  /** Writes a decision down, unless it is the same one as last time. */
  private write(held: Held, decision: PolicyDecision, nowMs: number): void {
    if (
      held.logged?.decision === decision.decision &&
      held.logged.reason === decision.reason
    ) {
      return;
    }
    held.logged = { decision: decision.decision, reason: decision.reason };
    this.onRecord({
      kind: "decision",
      atMs: nowMs,
      candidateId: held.candidate.id,
      headline: held.candidate.headline,
      type: held.candidate.type,
      heldForMs: nowMs - held.seenAtMs,
      turnsWaited: this.turnsSeen - held.turnsAtSeen,
      ...decision,
    });
    this.logger.log(
      `[policy] ${held.candidate.id} ${decision.decision} (${decision.reason},` +
        ` score ${decision.score.toFixed(2)} vs ${decision.thresholds.glow}/` +
        `${decision.thresholds.interject}): ${held.candidate.headline}`,
    );
  }

  /**
   * Arms one timer for the soonest thing that could change a held decision.
   * One timer for all of them: the earliest due time is the only one that
   * matters, and the re-check it causes arms the next.
   */
  private schedule(nowMs: number, pause: PauseState): void {
    this.disarm();
    if (this.holding.length === 0) return;
    const delays = this.holding.map((held) => nextCheckDelay(this.inputFor(held, nowMs, pause)));
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = undefined;
      this.review();
    }, Math.min(...delays));
  }

  private disarm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
}
