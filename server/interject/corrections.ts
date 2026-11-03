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
 * **And one softening of it (V3-009).** When what contradicted the claim was
 * one of the group's *own files* rather than a page on the web, the same
 * correction may be said at boldness `normal` — phrased as the file's and
 * cited by name ("From prices.csv: the price sheet has Pro at $40 a seat").
 * A group's own record quoted back is the read-back's move, not a stranger
 * with a search engine: it is their sentence, they can check it in ten
 * seconds, and it is the one thing in the room that nothing on the web can
 * settle. `cautious` is still silent, and a web-verified error is still
 * `bold` only.
 *
 * It is then said under V3-004's rules, by {@link Reservations}: a real
 * pause, the cached still-current verdict, yield to any human voice with one
 * retry, and ninety seconds or six turns of expiry. No budget of its own —
 * the card it was delivered as already spent one interject, and this is that
 * same contribution reaching the room's ears rather than a second one.
 */
import { isMcpCitation } from "../../shared/mcp.js";
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
  /** Whether the check came back `wrong` on it (US-013). */
  verified: boolean;
  /** The level the policy delivered it at, budget downgrades included. */
  level: DeliveredLevel;
  /**
   * The group's own file that contradicted the claim (V3-009), when one did.
   * That is what lowers the bar from `bold` to `normal`.
   */
  file?: string;
}

/** Whether this delivered card is the one correction that may be spoken. */
export function spokenCorrectionAllowed(input: SpokenCorrectionInput): boolean {
  if (input.type !== "factual_error" || !input.verified || input.level !== "interject") {
    return false;
  }
  if (input.boldness === "bold") return true;
  // V3-009: the group's own records, quoted back, at the default setting.
  return input.boldness === "normal" && (input.file ?? "") !== "";
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
/**
 * The lead-in a file-backed correction takes instead (V3-009): the file's own
 * name, because the whole of why this one may be said is that it is the
 * group's record rather than Sotto's reading of the world.
 */
export function fileCorrectionLine(file: string, correction: string): string {
  const text = correction.replace(/\s+/g, " ").trim();
  // A tool source (post-V3-011) is `mcp:crm/lookup_customer`; the room knows
  // the system by the server's name, and a slash is not a thing one says.
  const name = isMcpCitation(file) ? mcpServerOf(file) : file.trim();
  if (text === "" || name === "") return "";
  const said = /[.?!]$/.test(text) ? text : `${text}.`;
  // Measured against the real model: asked for the file's own phrasing it
  // sometimes writes the file name into the sentence ("notes.md has Pro at
  // $40"), and the lead-in would then say it twice. A sentence that already
  // cites the file is already the whole line.
  if (said.toLowerCase().includes(name.toLowerCase())) {
    return `${said.charAt(0).toUpperCase()}${said.slice(1)}`;
  }
  return `From ${name}: ${said}`;
}

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
  const file = candidate.verification?.file;
  if (
    !spokenCorrectionAllowed({
      boldness: interjection.decision.settings.boldness,
      type: candidate.type,
      verified: candidate.verification !== undefined,
      level: interjection.level,
      ...(file === undefined ? {} : { file }),
    })
  ) {
    return null;
  }
  // The file's words where a file settled it, Sotto's headline where the web
  // did (V3-009).
  const line =
    file === undefined || file === ""
      ? correctionLine(candidate.headline)
      : fileCorrectionLine(file, candidate.verification?.correction ?? candidate.headline);
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

/** `the crm` from `mcp:crm/lookup_customer`: the system, as the room would name it. */
function mcpServerOf(file: string): string {
  const key = file.trim().slice(file.trim().indexOf(":") + 1).trim();
  const server = key.slice(0, key.indexOf("/") < 0 ? key.length : key.indexOf("/")).trim();
  return server === "" ? "" : `the ${server.replace(/[_-]+/g, " ")}`;
}
