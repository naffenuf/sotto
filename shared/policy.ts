/**
 * When Sotto is allowed to speak, and how loudly (PRD US-014).
 *
 * The observer notices things (US-012) and the verifier checks the checkable
 * ones (US-013); this is the vocabulary of the decision that follows — what
 * level a candidate earns, how talkative the user has asked Sotto to be, and
 * the reason the decision came out that way. The rules themselves are in
 * `server/interject/policy.ts`, which is pure; the thresholds live here
 * because the header's chattiness selector and `session.json` both need them.
 */
import { z } from "zod";

/**
 * How talkative the user wants Sotto to be. One setting, three thresholds
 * each, and nothing else about the policy changes with it: a quiet session
 * raises only what is nearly certain and important, an active one thinks out
 * loud.
 */
export const chattinessLevels = ["quiet", "normal", "active"] as const;
export type Chattiness = (typeof chattinessLevels)[number];

export const ChattinessSchema = z.enum(chattinessLevels);

/** Where a session starts, until the header says otherwise. */
export const DEFAULT_CHATTINESS: Chattiness = "normal";

/** The two scores a candidate has to beat to be seen at all, and to interrupt. */
export interface ChattinessThresholds {
  /** At or above this, a candidate is worth a quiet one-line glow. */
  glow: number;
  /** At or above this, it is worth raising a hand for. */
  interject: number;
}

/** The PRD's table, exactly. */
export const CHATTINESS_THRESHOLDS: Readonly<Record<Chattiness, ChattinessThresholds>> = {
  quiet: { glow: 0.45, interject: 0.75 },
  normal: { glow: 0.35, interject: 0.6 },
  active: { glow: 0.25, interject: 0.45 },
};

/** The thresholds one chattiness setting carries. */
export function thresholdsFor(chattiness: Chattiness): ChattinessThresholds {
  return CHATTINESS_THRESHOLDS[chattiness];
}

/**
 * The level a candidate's score earns it, before timing or budget have had
 * their say: what it would be shown as if this were a good moment.
 */
export const candidateLevels = ["silent", "glow", "interject"] as const;
export type CandidateLevel = (typeof candidateLevels)[number];

/** A level that actually puts something on the stage. */
export type DeliveredLevel = Exclude<CandidateLevel, "silent">;

/**
 * What the policy decided to do with a candidate.
 *
 * - `silent`: it will never be shown.
 * - `glow`: a quiet one-line card.
 * - `interject`: a full card, Sotto raising its hand.
 * - `hold`: not now — wait for a pause, or for the courtesy window to pass,
 *   and ask again.
 */
export const decisions = ["silent", "glow", "interject", "hold"] as const;
export type Decision = (typeof decisions)[number];

/**
 * Why a decision came out the way it did. Written to `candidates.jsonl` with
 * every decision, so a session can be read back — and scored by the eval
 * harness (US-016) — without re-running the policy.
 *
 * - `below_threshold`: the score did not reach the glow threshold.
 * - `waiting_for_pause`: good enough, but somebody is talking.
 * - `courtesy`: good enough, but Sotto is already answering or has just been
 *   addressed.
 * - `stale`: it waited too long for a pause and is no longer about now.
 * - `cooldown`: an interject within the last three minutes, so this one is a
 *   glow instead.
 * - `budget`: three interjects already in the last fifteen minutes.
 * - `delivered`: shown, at the level the decision names.
 * - `session_ended`: still held when the conversation finished.
 */
export const decisionReasons = [
  "below_threshold",
  "waiting_for_pause",
  "courtesy",
  "stale",
  "cooldown",
  "budget",
  "delivered",
  "session_ended",
] as const;
export type DecisionReason = (typeof decisionReasons)[number];

/** One decision, with everything it was based on. */
export interface PolicyDecision {
  decision: Decision;
  reason: DecisionReason;
  /** `importance × confidence × (0.5 + 0.5 × relevance) × novelty`, 0–1. */
  score: number;
  /** The level the score alone earned, before timing and budget. */
  level: CandidateLevel;
  thresholds: ChattinessThresholds;
  chattiness: Chattiness;
}
