/**
 * The rules for speaking up (PRD US-014).
 *
 * Pure: one function, no clock of its own, no state, no I/O. Everything the
 * decision depends on — the moment, whether anybody is talking, what has
 * already been said out loud — arrives as an argument, so the whole policy is
 * testable by table and the eval harness (US-016) can replay a conversation's
 * decisions without the pipeline. {@link InterjectionPolicy} is the stateful
 * part: it holds the clock, the held candidates and the history, and calls
 * this.
 *
 * The order of the rules is the policy:
 *
 *   1. **Score.** `importance × confidence × (0.5 + 0.5 × relevance) ×
 *      novelty`, against the boldness thresholds. Below the glow threshold
 *      is `silent`, and nothing later can bring it back. Since V2-016 those
 *      four numbers are usually the *gate's* rather than the observer's own:
 *      see {@link scoresFromGate} for the mapping.
 *   2. **Expiry.** A candidate that has been waiting too long is about a
 *      moment that has passed: `silent`, reason `stale`.
 *   3. **Courtesy.** While Sotto is already answering, or has just been
 *      addressed, it says nothing else: `hold`.
 *   4. **Timing.** Only in a pause. Otherwise `hold`, and ask again when the
 *      pause state changes.
 *   5. **Budget.** An interject inside the frequency's cooldown, or one past
 *      its allowance for the quarter of an hour, is downgraded to a glow
 *      rather than dropped.
 *
 * Between 1 and 2 since V2-017 there is one more: a `cautious` session says
 * nothing at all about the kinds of thing it cannot point at evidence for
 * ({@link boldnessAllows}).
 */
import type { CandidateScores, CandidateType, GateScores } from "../../shared/candidates.js";
import {
  CAUTIOUS_TYPES,
  limitsFor,
  thresholdsFor,
  type BoldnessThresholds,
  type Boldness,
  type CandidateLevel,
  type PolicyDecision,
  type PolicySettings,
} from "../../shared/policy.js";
import type { PauseState } from "../../shared/turns.js";

/**
 * How long the room must really have been quiet before Sotto will say anything.
 *
 * On the *corrected* silence, not the reported one:
 * `ENDPOINTER_HANGOVER_MS` is subtracted in `TurnAssembler.pauseState`,
 * because `speechEnd` arrives a measured median of 647 ms after the talking
 * actually stopped. So this is milliseconds of quiet in the room, which is the
 * only version of the number worth arguing about.
 *
 * 700 ms is the point at which a gap between turns stops being a handover and
 * becomes a lapse somebody has to fill — comfortably past the ~200 ms that
 * ordinary turn-taking leaves, and short enough to still be the pause the
 * group is in rather than the next one.
 *
 * US-023 arrived here from 1,500 ms via 400 ms, and both of those were
 * thresholds on the *reported* gap, which is a different quantity: 400 ms
 * reported is about 1.05 s of real quiet, and only 1 of the 6 planted moments
 * has that much inside its window after the observer has looked, so recall was
 * capped at 0.17 by the instrument rather than by the conversation. Every one
 * of those windows does contain 0.93–1.61 s of real quiet
 * (`npm run eval:ceiling`, and the WAVs themselves). See
 * `ENDPOINTER_HANGOVER_MS` in `server/asr/turns.ts` for the measurement.
 */
export const PAUSE_MS = 700;

/** How long a candidate may wait for a pause before it is no longer about now. */
export const STALE_MS = 90_000;

/** How many final turns may go by in that wait, which is the faster of the two. */
export const STALE_TURNS = 6;

/** The window the interject budget is counted over. */
export const BUDGET_WINDOW_MS = 900_000;

/** How long after a wake phrase Sotto leaves the floor to the asker. */
export const COURTESY_MS = 5_000;

/** What has happened in the conversation that bears on this decision. */
export interface PolicyHistory {
  /**
   * When the policy first saw the candidate, on the session clock. Expiry is
   * measured from here rather than from when the observer produced it: a
   * `factual_error` spends ten or fifteen seconds being checked (US-013), and
   * that wait is the verifier's, not the group's.
   */
  seenAtMs: number;
  /** Final turns that have gone by since {@link seenAtMs}. */
  turnsWaited: number;
  /**
   * When each visible `interject` was delivered, oldest first. Glows are not
   * in here: they cost the group nothing and are not rationed.
   */
  interjectedAtMs: readonly number[];
  /** True while an answer is still being written (US-018). */
  answerThinking: boolean;
  /** When the wake phrase was last heard (US-017), or `null`. */
  wakeAtMs: number | null;
}

/** Everything one decision is made from. */
export interface PolicyInput {
  scores: CandidateScores;
  /**
   * What kind of thing it is, which only {@link Boldness} reads: a `cautious`
   * session raises contradictions and verified factual errors and nothing
   * else. Everything before V2-017 was type-agnostic from here on down.
   */
  type: CandidateType;
  /**
   * Whether the web check came back `wrong` on it (US-013). Only a
   * `factual_error` ever has one, and the verifier only passes a `wrong` one
   * on — so this is true for every `factual_error` that reaches the policy —
   * but `cautious` is the setting that promises evidence, so it checks rather
   * than assuming.
   */
  verified: boolean;
  /** The session clock's reading, taken by the caller. */
  nowMs: number;
  pause: PauseState;
  settings: PolicySettings;
  history: PolicyHistory;
}

/**
 * How much a candidate is worth, 0–1.
 *
 * `importance × confidence × (0.5 + 0.5 × relevance) × novelty`: importance
 * and confidence are the two that can veto it on their own, novelty likewise
 * (saying something the group already said is worse than silence), and
 * relevance only halves the score at worst — a stale-but-serious point is
 * still worth a glow.
 */
export function candidateScore(scores: CandidateScores): number {
  return (
    scores.importance * scores.confidence * (0.5 + 0.5 * scores.relevance) * scores.novelty
  );
}

/**
 * The gate's four probabilities (V2-016) as the four scores this policy
 * multiplies.
 *
 * The questions line up one for one, which is why the gate asks these four
 * and not some other four — the formula above is unchanged, and so are the
 * boldness thresholds it is measured against, so turning the gate on
 * changes *who answers* rather than what the answer means:
 *
 * | gate            | policy       | the question                               |
 * | --------------- | ------------ | ------------------------------------------ |
 * | `true`          | `confidence` | is the point really supported?             |
 * | `new`           | `novelty`    | has it been said, or is it on the board?   |
 * | `worthSaying`   | `importance` | would a thoughtful participant raise it?   |
 * | `stillRelevant` | `relevance`  | has the conversation moved on?             |
 *
 * These *replace* the observer's own four rather than being averaged with
 * them. A model that has just decided something is worth raising is the worst
 * available judge of whether it is, and two opinions averaged would still
 * carry half of that; the observer's scores stay on the candidate
 * (`observerScores`) and in `candidates.jsonl` so a report can say what the
 * second opinion changed.
 */
export function scoresFromGate(gate: GateScores): CandidateScores {
  return {
    confidence: gate.true,
    novelty: gate.new,
    importance: gate.worthSaying,
    relevance: gate.stillRelevant,
  };
}

/**
 * Whether this boldness setting will raise this kind of thing at all.
 *
 * `cautious` is the only one that says no, and it says no to the three types
 * that rest on the model's judgment rather than on something it can point at:
 * see {@link CAUTIOUS_TYPES}. A `research_hook` never reaches the policy
 * (V2-011), so it does not come into it.
 */
export function boldnessAllows(
  boldness: Boldness,
  type: CandidateType,
  verified: boolean,
): boolean {
  if (boldness !== "cautious") return true;
  if (!CAUTIOUS_TYPES.includes(type)) return false;
  return type !== "factual_error" || verified;
}

/** The level a score earns on its own, before anything about the moment. */
export function levelFor(score: number, thresholds: BoldnessThresholds): CandidateLevel {
  if (score >= thresholds.interject) return "interject";
  if (score >= thresholds.glow) return "glow";
  return "silent";
}

/** Whether this is a moment Sotto may speak into. */
export function inPause(pause: PauseState): boolean {
  return !pause.speaking && pause.silentForMs >= PAUSE_MS;
}

/** Whether the candidate has waited past either expiry limit. */
export function isStale(nowMs: number, history: PolicyHistory): boolean {
  return nowMs - history.seenAtMs >= STALE_MS || history.turnsWaited >= STALE_TURNS;
}

/** Whether the floor belongs to somebody else just now. */
export function inCourtesyWindow(nowMs: number, history: PolicyHistory): boolean {
  if (history.answerThinking) return true;
  return history.wakeAtMs !== null && nowMs - history.wakeAtMs < COURTESY_MS;
}

/** One decision about one candidate. */
export function decide(input: PolicyInput): PolicyDecision {
  const thresholds = thresholdsFor(input.settings.boldness);
  const limits = limitsFor(input.settings.frequency);
  const score = candidateScore(input.scores);
  const level = levelFor(score, thresholds);
  const base = { score, level, thresholds, limits, settings: input.settings };

  // Not worth saying at any moment, so the moment never comes into it.
  if (level === "silent") return { ...base, decision: "silent", reason: "below_threshold" };
  if (!boldnessAllows(input.settings.boldness, input.type, input.verified)) {
    return { ...base, decision: "silent", reason: "boldness" };
  }
  if (isStale(input.nowMs, input.history)) {
    return { ...base, decision: "silent", reason: "stale" };
  }
  // Both of these are about *now*, so they hold rather than drop: the answer
  // finishes, the asker stops talking, and the point is still worth making.
  if (inCourtesyWindow(input.nowMs, input.history)) {
    return { ...base, decision: "hold", reason: "courtesy" };
  }
  if (!inPause(input.pause)) {
    return { ...base, decision: "hold", reason: "waiting_for_pause" };
  }
  if (level === "glow") return { ...base, decision: "glow", reason: "delivered" };

  // An interject in a good moment, which the budget may still turn down a
  // notch. Downgraded, never dropped: the thought was worth having.
  const recent = input.history.interjectedAtMs.filter(
    (atMs) => input.nowMs - atMs < BUDGET_WINDOW_MS,
  );
  if (recent.length >= limits.maxInterjectsPerWindow) {
    return { ...base, decision: "glow", reason: "budget" };
  }
  const last = input.history.interjectedAtMs.at(-1);
  if (last !== undefined && input.nowMs - last < limits.cooldownMs) {
    return { ...base, decision: "glow", reason: "cooldown" };
  }
  return { ...base, decision: "interject", reason: "delivered" };
}

/**
 * When a held candidate next needs looking at, as a delay in milliseconds.
 *
 * Two things change a decision with nothing arriving to say so: silence
 * reaching {@link PAUSE_MS}, and the courtesy window after a wake phrase
 * running out. Expiry is the backstop and is always in the answer — a
 * candidate nobody ever found a pause for has to be written down as `stale`
 * rather than held for the rest of the conversation.
 */
export function nextCheckDelay(input: PolicyInput): number {
  const due: number[] = [Math.max(0, input.history.seenAtMs + STALE_MS - input.nowMs)];
  if (!input.pause.speaking && input.pause.silentForMs < PAUSE_MS) {
    due.push(PAUSE_MS - input.pause.silentForMs);
  }
  if (
    !input.history.answerThinking &&
    input.history.wakeAtMs !== null &&
    input.nowMs - input.history.wakeAtMs < COURTESY_MS
  ) {
    due.push(input.history.wakeAtMs + COURTESY_MS - input.nowMs);
  }
  return Math.min(...due);
}
