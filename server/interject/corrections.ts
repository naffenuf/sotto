/**
 * Sotto's own corrections go on screen (PRD V3-008).
 *
 * Five of the six things the observer notices are *about the group* — a
 * contradiction, a wrong number, an assumption nobody checked, a thread they
 * dropped, a question nobody answered — and all five are shown rather than
 * said, at every frequency and every boldness. That is the whole of the
 * story, and most of it is already true: the policy delivers a card and
 * nothing in the interjection path has ever had a voice. What this module
 * adds is the one exception the PRD carves out, and the words it is said in.
 *
 * **The exception.** A `factual_error` the web check came back `wrong` on
 * (US-013), at boldness `bold`, delivered as a full `interject`. Everything
 * about that sentence is load-bearing:
 *
 * - *verified*, because the room is being told it has a fact wrong and the
 *   only thing that earns the floor is a page that says so;
 * - *`bold`*, because a group on the default setting asked to be left alone;
 *   the raised hand (V3-017) is the route by which every other correction
 *   reaches anybody's ears — never unprompted, always on request;
 * - *`interject`*, because a glow is the level the policy chose for a quiet
 *   thought, and because the budget downgrades an interject to a glow —
 *   speaking one would ask for a floor the frequency setting has already
 *   said is not there.
 *
 * It is then said under V3-004's rules, by {@link Reservations}: a real
 * pause, the cached still-current verdict, yield to any human voice with one
 * retry, and ninety seconds or six turns of expiry. No budget of its own —
 * the card it was delivered as already spent one interject, and this is that
 * same contribution reaching the room's ears rather than a second one.
 */
import type { CandidateType } from "../../shared/candidates.js";
import type { Boldness, DeliveredLevel } from "../../shared/policy.js";
import type { Interjection } from "./InterjectionPolicy.js";

/**
 * The five kinds of thing that are Sotto's own reading of the conversation,
 * and so are shown rather than said.
 *
 * Every candidate type except `research_hook`, which never reaches the policy
 * at all (V2-011) — it is handed to the research pipeline and what comes back
 * is a research card. Spelled out rather than derived, because this is the
 * PRD's list and a seventh type added later should have to be classified by
 * hand rather than inheriting a voice by default.
 */
export const CORRECTION_TYPES: readonly CandidateType[] = [
  "contradiction",
  "factual_error",
  "untested_assumption",
  "dropped_thread",
  "unanswered_question",
];

/** Whether this is one of Sotto's own corrections (V3-008). */
export function isCorrection(type: CandidateType): boolean {
  return CORRECTION_TYPES.includes(type);
}

/**
 * The lead-in, so a sentence arriving out of nowhere is recognisably Sotto
 * checking something rather than a person in the room making a claim.
 *
 * The headline of a `factual_error` is already the correction and not the
 * claim ("Instagram launched in 2010, not 2014"), so there is nothing to add
 * to it but the frame.
 */
export const CORRECTION_LEAD_IN = "Quick correction";

/** Everything the one exception is decided from. */
export interface SpokenCorrectionInput {
  boldness: Boldness;
  type: CandidateType;
  /** Whether the web check came back `wrong` on it (US-013). */
  verified: boolean;
  /** The level the policy delivered it at, budget downgrades included. */
  level: DeliveredLevel;
}

/** Whether this delivered card is the one correction that may be spoken. */
export function spokenCorrectionAllowed(input: SpokenCorrectionInput): boolean {
  return (
    input.boldness === "bold" &&
    input.type === "factual_error" &&
    input.verified &&
    input.level === "interject"
  );
}

/**
 * "Quick correction: Instagram launched in 2010, not 2014." — one sentence,
 * from the headline the card is already showing.
 *
 * The card and the spoken line say the same thing on purpose: a group that
 * heard it and then reads the stage should find what they heard, which is the
 * same reason a glow opens into exactly the card an interjection would have
 * been (US-015). A headline clipped at ninety characters keeps its ellipsis
 * on screen and loses it here — a pause read aloud says nothing.
 */
export function correctionLine(headline: string): string {
  const text = headline.replace(/\s+/g, " ").trim().replace(/[…]+$/, "").trim();
  if (text === "") return "";
  // Said rather than read, so it ends in a full stop even where the headline
  // did not: ElevenLabs reads punctuation as prosody.
  const said = /[.?!]$/.test(text) ? text : `${text}.`;
  return `${CORRECTION_LEAD_IN}: ${said}`;
}

/**
 * The sentence one delivered interjection may be said in, or `null` for the
 * cards-only case — which is every card but one.
 */
export function spokenCorrection(interjection: Interjection): string | null {
  const candidate = interjection.candidate;
  if (
    !spokenCorrectionAllowed({
      boldness: interjection.decision.settings.boldness,
      type: candidate.type,
      verified: candidate.verification !== undefined,
      level: interjection.level,
    })
  ) {
    return null;
  }
  const line = correctionLine(candidate.headline);
  return line === "" ? null : line;
}

/**
 * What the still-current check (V3-004) is asked about: the claim itself, in
 * the room's own words.
 *
 * The evidence quote rather than the headline, for the reason the fact check
 * already learned (US-013) — a headline states the *correction*, so asking
 * whether the room has moved on from it is asking about the wrong sentence.
 */
export function correctedClaim(interjection: Interjection): string {
  const candidate = interjection.candidate;
  const quote = candidate.evidence[0]?.quote.trim() ?? "";
  return quote === "" ? candidate.headline : quote;
}
