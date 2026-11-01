/**
 * When Sotto is allowed to speak, how often, and how sure it must be
 * (PRD US-014, V2-017).
 *
 * The observer notices things (US-012) and the verifier checks the checkable
 * ones (US-013); this is the vocabulary of the decision that follows — what
 * level a candidate earns, how talkative the user has asked Sotto to be, and
 * the reason the decision came out that way. The rules themselves are in
 * `server/interject/policy.ts`, which is pure; the numbers live here because
 * the header's two selectors and `session.json` both need them.
 *
 * V2-017 split the one `chattiness` setting in two, because the two things it
 * conflated pull in different directions: a group can want Sotto to speak
 * *rarely* without wanting it to speak only when it is nearly certain, and
 * the other way round. So {@link Frequency} owns the rationing — the cooldown
 * and the budget — and {@link Boldness} owns the bar a thought has to clear.
 * `normal`/`normal` is exactly the old `normal` chattiness, which is what
 * `server/interject/policy.test.ts` holds it to.
 */
import { z } from "zod";

/**
 * How often Sotto may contribute: the cooldown after an interjection and how
 * many it is allowed in a quarter of an hour. Nothing about *what* it would
 * say changes with this — a candidate the budget turns down is still shown,
 * as a glow.
 */
export const frequencyLevels = ["rare", "normal", "often"] as const;
export type Frequency = (typeof frequencyLevels)[number];

export const FrequencySchema = z.enum(frequencyLevels);

/** Where a session starts, until the header says otherwise. */
export const DEFAULT_FREQUENCY: Frequency = "normal";

/**
 * How sure Sotto has to be before it says anything: the two score thresholds,
 * and — at `cautious` — which kinds of thing it will raise at all.
 */
export const boldnessLevels = ["cautious", "normal", "bold"] as const;
export type Boldness = (typeof boldnessLevels)[number];

export const BoldnessSchema = z.enum(boldnessLevels);

/** Where a session starts, until the header says otherwise. */
export const DEFAULT_BOLDNESS: Boldness = "normal";

/** The pair of settings, which is what the policy is actually configured by. */
export interface PolicySettings {
  readonly frequency: Frequency;
  readonly boldness: Boldness;
}

/** Where a session starts: the old `normal` chattiness, exactly. */
export function defaultPolicySettings(): PolicySettings {
  return { frequency: DEFAULT_FREQUENCY, boldness: DEFAULT_BOLDNESS };
}

/** `rare/bold` — one string for a report heading, a log line or a folder name. */
export function policySettingsLabel(settings: PolicySettings): string {
  return `${settings.frequency}/${settings.boldness}`;
}

/** The two scores a candidate has to beat to be seen at all, and to interrupt. */
export interface BoldnessThresholds {
  /** At or above this, a candidate is worth a quiet one-line glow. */
  glow: number;
  /** At or above this, it is worth raising a hand for. */
  interject: number;
}

/**
 * The PRD's table, exactly — and the same three pairs the three chattiness
 * settings carried before V2-017 (`quiet`, `normal`, `active` in order), so a
 * run at `normal` boldness is comparable with every eval run before it.
 */
export const BOLDNESS_THRESHOLDS: Readonly<Record<Boldness, BoldnessThresholds>> = {
  cautious: { glow: 0.45, interject: 0.75 },
  normal: { glow: 0.35, interject: 0.6 },
  bold: { glow: 0.25, interject: 0.45 },
};

/** The thresholds one boldness setting carries. */
export function thresholdsFor(boldness: Boldness): BoldnessThresholds {
  return BOLDNESS_THRESHOLDS[boldness];
}

/**
 * The kinds of thing a `cautious` session will raise: a contradiction, and a
 * factual error the web check actually came back `wrong` on (US-013). Both
 * are things Sotto can point at evidence for — the group said two
 * incompatible things, or a page says otherwise — where an untested
 * assumption or a dropped thread is a judgment call, which is exactly what a
 * cautious group has asked Sotto to keep to itself.
 *
 * Plain strings rather than `CandidateType`s to keep this module free of
 * `shared/candidates.ts`, which imports it. `boldnessAllows` in
 * `server/interject/policy.ts` is where the rule is applied.
 */
export const CAUTIOUS_TYPES: readonly string[] = ["contradiction", "factual_error"];

/**
 * What one frequency setting rations, for both of the things Sotto puts on
 * the stage unasked.
 *
 * The interjection numbers are the PRD's. The research-card ones are scaled
 * the same way around the `normal` pair V2-014 measured (60 s and four in a
 * quarter of an hour): a research card costs the group less than an
 * interjection — it is never spoken and never asks for the floor — so it is
 * allowed more often at every setting, but "rarely" has to mean rarely for
 * everything Sotto does unprompted, or the control does not do what it says.
 */
export interface FrequencyLimits {
  /** After an interject, how long the next one is a glow instead. */
  cooldownMs: number;
  /** How many interjects `BUDGET_WINDOW_MS` allows (`server/interject/policy.ts`). */
  maxInterjectsPerWindow: number;
  /** After a research card, how long the next one waits (V2-014). */
  researchCardCooldownMs: number;
  /** How many research cards `RESEARCH_CARD_WINDOW_MS` allows (`shared/research.ts`). */
  maxResearchCardsPerWindow: number;
}

/** The PRD's table, and V2-014's numbers at `normal`. */
export const FREQUENCY_LIMITS: Readonly<Record<Frequency, FrequencyLimits>> = {
  rare: {
    cooldownMs: 300_000,
    maxInterjectsPerWindow: 2,
    researchCardCooldownMs: 120_000,
    maxResearchCardsPerWindow: 2,
  },
  normal: {
    cooldownMs: 180_000,
    maxInterjectsPerWindow: 3,
    researchCardCooldownMs: 60_000,
    maxResearchCardsPerWindow: 4,
  },
  often: {
    cooldownMs: 90_000,
    maxInterjectsPerWindow: 5,
    researchCardCooldownMs: 30_000,
    maxResearchCardsPerWindow: 6,
  },
};

/** What one frequency setting allows. */
export function limitsFor(frequency: Frequency): FrequencyLimits {
  return FREQUENCY_LIMITS[frequency];
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
 * - `boldness`: a `cautious` session, and not one of the two kinds of thing
 *   it will raise ({@link CAUTIOUS_TYPES}).
 * - `waiting_for_pause`: good enough, but somebody is talking.
 * - `courtesy`: good enough, but Sotto is already answering or has just been
 *   addressed.
 * - `stale`: it waited too long for a pause and is no longer about now.
 * - `cooldown`: an interject inside the frequency's cooldown, so this one is
 *   a glow instead.
 * - `budget`: the frequency's whole allowance of interjects already spent in
 *   the last fifteen minutes.
 * - `delivered`: shown, at the level the decision names.
 * - `session_ended`: still held when the conversation finished.
 */
export const decisionReasons = [
  "below_threshold",
  "boldness",
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
  /** The two score thresholds the boldness setting carried. */
  thresholds: BoldnessThresholds;
  /** What Sotto was set to when the decision was taken. */
  settings: PolicySettings;
  /** What the frequency setting allowed: the cooldown and the budget. */
  limits: FrequencyLimits;
}

/**
 * Which way the room asked Sotto to go (V3-006).
 *
 * The two things a group can say about *how much* Sotto contributes, as
 * opposed to what it contributes: "not now" / "that's too much" steps the
 * frequency down, "you can jump in more" steps it up. Boldness is not
 * steerable out loud — a group telling Sotto to be quiet is asking for less,
 * not for a higher bar.
 */
export const steerDirections = ["quieter", "louder"] as const;
export type SteerDirection = (typeof steerDirections)[number];

/**
 * One step down or up {@link frequencyLevels}, clamped at either end.
 *
 * Returns the frequency unchanged when there is nowhere further to go, which
 * is how the caller knows there is nothing to tell the room about.
 */
export function steppedFrequency(frequency: Frequency, direction: SteerDirection): Frequency {
  const index = frequencyLevels.indexOf(frequency);
  const next = index + (direction === "quieter" ? -1 : 1);
  if (next < 0 || next >= frequencyLevels.length) return frequency;
  return frequencyLevels[next] as Frequency;
}
