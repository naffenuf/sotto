/**
 * Read-backs and the question attached to one (PRD V3-013).
 *
 * The whole story is a good note-taker's two moves. A group settles something
 * — "OK, let's go with six gardens" — and the scribe says it back in four
 * words, so everybody hears the same decision land. And if one of *them*
 * raised a risk against it earlier that nobody ever answered, the scribe
 * reminds them of it **in their own words**, which is a different act from
 * telling a room it is wrong.
 *
 * So there are two attachments and they are not alike:
 *
 * - `group` — a `dropped_thread` or an `unanswered_question`, which is the
 *   room's own unsettled business. Said out loud at every frequency, because
 *   it is their question and not Sotto's opinion.
 * - `own` — a `contradiction` or an `untested_assumption`, which is Sotto's
 *   reading of the conversation. Pinned beside the read-back **on screen**
 *   (V3-008's rule, which this does not get to break) and said out loud only
 *   at boldness `bold`.
 *
 * Everything here is pure. The two limits, the pause, the yield and the
 * budget belong to {@link ReadBacks} and {@link Reservations}; what this file
 * knows is which candidate goes with which decision and the words it is said
 * in.
 */
import type { Candidate, CandidateType } from "../../shared/candidates.js";

/**
 * How long a read-back is still worth saying (PRD V3-013): twenty seconds.
 *
 * Far shorter than an answer's ninety (V3-004), because a read-back is about
 * the instant a decision lands. Twenty seconds later the group is three turns
 * into the next thing and "Got it: six gardens" is Sotto reopening a subject
 * rather than closing one. The decision is on the board either way.
 */
export const READBACK_EXPIRY_MS = 20_000;

/** At most one spoken read-back every five minutes (PRD V3-013). */
export const READBACK_COOLDOWN_MS = 5 * 60_000;

/** And at most one attached question every ten minutes. */
export const ATTACHED_COOLDOWN_MS = 10 * 60_000;

/** What a read-back carries besides the decision, when it carries anything. */
export const readBackAttachments = ["group", "own"] as const;
export type ReadBackAttachment = (typeof readBackAttachments)[number];

/**
 * The room's own unsettled business, which Sotto may quote back out loud.
 *
 * A question nobody answered and an idea or a risk the group dropped are both
 * things *they* said, so repeating one is not an opinion.
 */
export const GROUP_ATTACHMENT_TYPES: readonly CandidateType[] = [
  "dropped_thread",
  "unanswered_question",
];

/**
 * Sotto's own reading of the conversation, which goes on the screen.
 *
 * A `factual_error` is deliberately not here: it has its own route to the
 * room's ears (V3-008's one spoken exception) and attaching a wrong number to
 * a decision read-back would say it twice.
 */
export const OWN_ATTACHMENT_TYPES: readonly CandidateType[] = [
  "contradiction",
  "untested_assumption",
];

/** Which kind of attachment this candidate would be, or `null` for neither. */
export function attachmentFor(type: CandidateType): ReadBackAttachment | null {
  if (GROUP_ATTACHMENT_TYPES.includes(type)) return "group";
  if (OWN_ATTACHMENT_TYPES.includes(type)) return "own";
  return null;
}

/**
 * How much of the decision a candidate has to be about before it is attached
 * to it.
 *
 * A third: one word of a three-word decision, two of a five-word one, once
 * the dates and the counts are out of it. Coverage of the *decision* rather
 * than overlap of the two, for V2-015's reason — a decision is three or four
 * words and a candidate is a sentence plus its evidence, so Jaccard would
 * score every pair near zero.
 *
 * Words rather than a judgment call, and deliberately so: a model call here
 * would cost the read-back the only thing it has, which is arriving while the
 * decision is still in the air. The bar works because V3-008 made every
 * correction a question *tied to what was just said*, so the two share the
 * conversation's own nouns. Measured against the real observer on
 * `decision-closings`: the decision came back as "Saturday the 14th, mechanic
 * and coffee cart" and the contradiction as "The bike mechanic — where does
 * that fit with $1400 and nothing on top?", which share **one** of the three
 * words that are about *what* was settled. A fifth of the whole phrase, and a
 * third of the part that means anything.
 *
 * The failure it accepts is a miss rather than a false attachment: a read-back
 * with nothing on it is a courtesy, and a read-back with the wrong question on
 * it is Sotto not listening. The score is logged even when nothing qualified,
 * so the next conversation says whether the bar is in the right place.
 */
export const DECISION_RELEVANCE = 1 / 3;

/** How much of the decision this candidate is about: 0 to 1. */
export function decisionRelevance(
  decision: string,
  candidate: Pick<Candidate, "headline" | "detail" | "whyNow" | "evidence">,
): number {
  const asked = decisionStems(decision);
  if (asked.size === 0) return 0;
  const about = stems(
    `${candidate.headline} ${candidate.detail} ${candidate.whyNow} ` +
      candidate.evidence.map((quote) => quote.quote).join(" "),
  );
  let shared = 0;
  for (const word of asked) if (about.has(word)) shared += 1;
  return shared / asked.size;
}

/**
 * One read-back, as {@link Reservations} is handed it.
 *
 * Two texts, because the decision about *which* one is said is taken at the
 * pause rather than here: the header can turn the boldness down while a
 * read-back waits, and an `own` attachment that is no longer allowed out loud
 * degrades to the bare line rather than being dropped — the card beside it
 * has already been pinned either way.
 */
export interface ReadBackRequest {
  /** {@link decisionId} of the turn it was settled in. */
  id: string;
  /** The decision turn, which the log cites. */
  turnId: string;
  /** What was settled, in a few words. */
  decision: string;
  /** What is attached, or `null` for a bare read-back. */
  attached: ReadBackAttachment | null;
  /** The candidate the attachment came from, for the log. */
  candidateId: string | null;
  /**
   * Whether that candidate is already on the stage as a card, and so has
   * already spent one contribution against the frequency's budget (V2-017).
   *
   * If it has, the question on this read-back costs nothing more: it is the
   * same contribution reaching the room's ears, which is exactly the rule
   * V3-008 gives a spoken correction. Without it the feature would be
   * unreachable in practice — the policy delivers the card the moment it has
   * a pause, forty seconds before the decision it bears on, and the cooldown
   * it spends there would silence every read-back that had anything to say.
   */
  alreadyDelivered: boolean;
  /** The line as it stands, attachment included. */
  text: string;
  /** The same line with nothing attached, for the degraded case. */
  bareText: string;
}

/** The id a read-back is logged and watched under: one per decision turn. */
export function decisionId(turnId: string): string {
  return `decision-${turnId}`;
}

/**
 * The line a pinned card carries (V3-013): why it is suddenly at the top.
 *
 * One of Sotto's own corrections, beside the decision it bears on. The card
 * is the whole contribution at every setting but `bold` — so it has to say,
 * without being read aloud, what it is doing there.
 */
export function decisionNote(decision: string): string {
  const text = oneLine(decision).replace(/[.?!,;:]+$/, "");
  return text === "" ? "Still open" : `Still open against "${text}"`;
}

/** The lead-in, which is the scribe's voice and not Sotto's own. */
export const READBACK_LEAD_IN = "Got it";

/** "Got it: six gardens, Saturday." — the decision, said back (V3-013). */
export function readBackLine(decision: string): string {
  const text = oneLine(decision).replace(/[.?!,;:]+$/, "");
  if (text === "") return "";
  return `${READBACK_LEAD_IN}: ${text}.`;
}

/** How much of a quote is said back: enough to recognise, not a paragraph. */
export const QUOTE_MAX_WORDS = 18;

/**
 * "Got it: six gardens. EJ asked, what if only one of them signs up. Did
 * that get settled?" — the read-back with the room's own question on it.
 *
 * Quoted rather than paraphrased, which is the PRD's word and also the only
 * honest option: paraphrasing somebody's risk back at them is Sotto's reading
 * of it, and a model call to do the paraphrasing would make the read-back
 * late. The name is used here, unlike a spoken answer (V3-004) — a question
 * belongs to whoever asked it, and the observer's evidence carries the
 * speaker the group itself named.
 */
export function groupAttachedLine(
  decision: string,
  candidate: Pick<Candidate, "headline" | "evidence">,
  speaker: string | null,
): string {
  const readBack = readBackLine(decision);
  const quote = bestQuote(candidate);
  if (quote === "") {
    const headline = oneLine(candidate.headline);
    return headline === "" ? readBack : `${readBack} One thing nobody settled: ${headline}`;
  }
  const who = speaker === null || speaker.trim() === "" ? "Somebody" : speaker.trim();
  return `${readBack} ${who} asked, ${quote}. Did that get settled?`;
}

/**
 * "Got it: the May launch. Before you lock that in: what about the permits?"
 * — the read-back with one of Sotto's own questions on it, at boldness
 * `bold` only.
 *
 * The headline is already a question tied to what was said (V3-008 made every
 * `contradiction` and `untested_assumption` one), so there is nothing to add
 * to it but the read-back in front.
 */
export function ownAttachedLine(
  decision: string,
  candidate: Pick<Candidate, "headline">,
): string {
  const readBack = readBackLine(decision);
  const headline = oneLine(candidate.headline).replace(/[…]+$/, "").trim();
  if (headline === "") return readBack;
  const said = /[.?!]$/.test(headline) ? headline : `${headline}?`;
  return `${readBack} ${said}`;
}

/**
 * The one sentence of the evidence worth saying back: the question in it if
 * there is one, else the first sentence, clipped.
 *
 * A cited turn is a whole utterance — "Good question. And are we sure six
 * gardens will even sign up? Anyway, the adapters…" — and the part the room
 * needs reminding of is the question inside it.
 */
function bestQuote(candidate: Pick<Candidate, "evidence">): string {
  for (const evidence of candidate.evidence) {
    const parts = oneLine(evidence.quote)
      .split(/(?<=[.?!])\s+/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const question = parts.find((part) => part.endsWith("?"));
    const chosen = question ?? parts[0];
    if (chosen === undefined) continue;
    const words = chosen.replace(/[.?!,;:]+$/, "").split(/\s+/);
    const clipped = words.slice(0, QUOTE_MAX_WORDS).join(" ");
    if (clipped !== "") return clipped;
  }
  return "";
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Words of a decision or a candidate worth comparing: lowercased,
 * unpunctuated, not filler, singular enough that "gardens" and "garden" match.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does", "for", "from",
  "go", "going", "has", "have", "in", "is", "it", "its", "let", "lets", "of", "on", "or", "our",
  "so", "that", "the", "their", "them", "then", "there", "they", "this", "to", "we", "well",
  "what", "which", "will", "with", "would", "you", "your",
]);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * The words of a decision that say *what* was settled.
 *
 * A date and a count say when and how many: "Saturday the 14th, mechanic and
 * coffee cart" is a decision about the mechanic and the coffee cart, and
 * every conversation is full of Thursdays and sixes, so leaving them in both
 * dilutes the match and invites a false one. The candidate's side keeps
 * everything — a wrong number is often the whole point of it.
 */
function decisionStems(text: string): Set<string> {
  const kept = new Set<string>();
  for (const word of stems(text)) {
    if (CALENDAR.has(word) || COUNTS.has(word) || /^[0-9]/.test(word)) continue;
    kept.add(word);
  }
  return kept;
}

const CALENDAR = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "today", "tomorrow", "tonight", "week", "month", "day", "morning", "afternoon", "evening",
]);

const COUNTS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "hundred", "thousand", "half", "couple", "few",
]);

function stems(text: string): Set<string> {
  const kept = new Set<string>();
  for (const word of text
    .toLowerCase()
    .replace(/[^a-z0-9$%'\s-]/g, " ")
    .split(/\s+/)) {
    if (word === "" || STOP_WORDS.has(word)) continue;
    kept.add(stem(word));
  }
  return kept;
}
