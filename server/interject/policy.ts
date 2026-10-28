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
 *      novelty`, against the chattiness thresholds. Below the glow threshold
 *      is `silent`, and nothing later can bring it back.
 *   2. **Expiry.** A candidate that has been waiting too long is about a
 *      moment that has passed: `silent`, reason `stale`.
 *   3. **Courtesy.** While Sotto is already answering, or has just been
 *      addressed, it says nothing else: `hold`.
 *   4. **Timing.** Only in a pause. Otherwise `hold`, and ask again when the
 *      pause state changes.
 *   5. **Budget.** An interject soon after another one, or the fourth in a
 *      quarter of an hour, is downgraded to a glow rather than dropped.
 */
import type { CandidateScores } from "../../shared/candidates.js";
import {
  thresholdsFor,
  type CandidateLevel,
  type Chattiness,
  type ChattinessThresholds,
  type PolicyDecision,
} from "../../shared/policy.js";
import type { PauseState } from "../../shared/turns.js";

/**
 * How long nobody may have been talking before Sotto will say anything.
 *
 * Measured, not guessed. The silence the API reports between turns across all
 * nine captures (189 gaps) decays smoothly from a median of 160 ms: half of
 * every handover is under 200 ms, 78% is under 400 ms, and the tail thins out
 * sharply above that — 42 gaps clear 400 ms, 21 clear 500 ms. So 400 ms is the
 * top fifth of gaps: a beat somebody left, not the join between two sentences.
 *
 * It reads low because the instrument under-reports. The endpointer trims both
 * ends of a line, so the reported gap is consistently ~460 ms shorter than the
 * silence that is really in the audio — every scripted pause in
 * `moment-assumption` comes back 380–560 ms short, and `brainstorm`'s 1,600 and
 * 2,400 ms pauses came back as 1,084 and 1,944 ms (`fixtures/events/NOTES.md`).
 * 400 ms reported is therefore about 0.86 s of real quiet.
 *
 * US-023 moved this, down from 1,500 ms, and 1,500 was the wrong number for a
 * measurable reason: only 6 of those 189 gaps reach it, and none of them falls
 * inside a planted moment's window after the observer has looked. 400 ms is the
 * lowest value that still discriminates; it is **not** enough to reach the
 * 0.7 recall gate, which is timing-bound rather than threshold-bound (see
 * `ralph/prd.json` US-023 for the measurement).
 */
export const PAUSE_MS = 400;

/** How long a candidate may wait for a pause before it is no longer about now. */
export const STALE_MS = 90_000;

/** How many final turns may go by in that wait, which is the faster of the two. */
export const STALE_TURNS = 6;

/** After an interject, how long the next one is a glow instead. */
export const COOLDOWN_MS = 180_000;

/** The window the interject budget is counted over. */
export const BUDGET_WINDOW_MS = 900_000;

/** How many interjects that window allows. */
export const MAX_INTERJECTS_PER_WINDOW = 3;

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
  /** The session clock's reading, taken by the caller. */
  nowMs: number;
  pause: PauseState;
  chattiness: Chattiness;
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

/** The level a score earns on its own, before anything about the moment. */
export function levelFor(score: number, thresholds: ChattinessThresholds): CandidateLevel {
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
  const thresholds = thresholdsFor(input.chattiness);
  const score = candidateScore(input.scores);
  const level = levelFor(score, thresholds);
  const base = { score, level, thresholds, chattiness: input.chattiness };

  // Not worth saying at any moment, so the moment never comes into it.
  if (level === "silent") return { ...base, decision: "silent", reason: "below_threshold" };
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
  if (recent.length >= MAX_INTERJECTS_PER_WINDOW) {
    return { ...base, decision: "glow", reason: "budget" };
  }
  const last = input.history.interjectedAtMs.at(-1);
  if (last !== undefined && input.nowMs - last < COOLDOWN_MS) {
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
