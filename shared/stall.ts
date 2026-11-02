/**
 * A few ideas for a group going round in circles (PRD V3-007).
 *
 * The observer notices the loop — a `stall` candidate, the seventh type and
 * the second one that never reaches the interjection policy (V2-011 was the
 * first) — and this is the shape of what happens next:
 *
 *     stall candidate -> at most one per 10 minutes -> one model call
 *                     -> "I've got a few ideas on the name if they'd help."
 *                     -> somebody says yes -> up to three ideas, ~20 s
 *                                          -> and a card
 *                     -> nobody says yes   -> nothing said, nothing shown
 *
 * Two things about that shape are the whole story. The ideas are **offered,
 * never volunteered**, in V3-005's statement form, because a group that is
 * merely thinking hard looks exactly like a group that is stuck and the cost
 * of being wrong is an outsider talking over somebody's train of thought. And
 * the ideas are written *before* the offer rather than after the yes, so that
 * "I've got a few ideas" is true when it is said and the yes is answered with
 * no model call at all — the same reason V3-017's raised hand carries its
 * sentence around with it.
 *
 * The limits here are in milliseconds and characters rather than in words,
 * because what bounds them is the room's patience: twenty seconds of speech
 * (PRD V3-007) at the measured rate of Sotto's own voice.
 */
import { z } from "zod";

/**
 * How long after one stall offer another may be made.
 *
 * Ten minutes, the PRD's number, and it is the real rationing: a group that
 * is stuck tends to stay stuck for several turns, so the observer will notice
 * the same loop again and again. Counted from the offer being *queued* rather
 * than from the candidate, because that is the moment the ideas cost a model
 * call — the one thing worth not paying for twice.
 */
export const STALL_OFFER_COOLDOWN_MS = 10 * 60_000;

/** How many ideas are offered. Three, at most, and fewer is fine. */
export const MAX_STALL_IDEAS = 3;

/**
 * How long the ideas may take to say, in milliseconds.
 *
 * "About 20 s" (PRD V3-007), enforced by dropping whole ideas rather than by
 * clipping one mid-sentence: half an idea is worse than two ideas.
 */
export const STALL_SPEECH_BUDGET_MS = 20_000;

/** Words one idea runs to. One sentence somebody could repeat back. */
export const STALL_IDEA_MAX_WORDS = 22;

/** Words naming what the group is stuck on, which the offer is built from. */
export const STALL_TOPIC_MAX_WORDS = 5;

/** The `json_schema.name` a stall-ideas request sends. */
export const STALL_IDEAS_SCHEMA_NAME = "stall_ideas";

/** Collapses whitespace: every field of this is said out loud on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `text`, cut to `max` words. */
function clipWords(text: string, max: number): string {
  const words = oneLine(text).split(" ").filter((word) => word !== "");
  return words.length <= max ? words.join(" ") : words.slice(0, max).join(" ");
}

/**
 * The model's reply: what they are stuck on, and up to three ideas.
 *
 * The ideas are a plain array of strings and are *clipped* rather than
 * rejected for length, like an observer candidate's headline — losing three
 * ideas over one long sentence would be losing the whole contribution.
 */
export const StallIdeasReplySchema = z.strictObject({
  topic: z.string().transform((text) => clipWords(text, STALL_TOPIC_MAX_WORDS)),
  ideas: z
    .array(z.string())
    .transform((ideas) =>
      ideas
        .map((idea) => clipWords(idea, STALL_IDEA_MAX_WORDS))
        .filter((idea) => idea !== "")
        .slice(0, MAX_STALL_IDEAS),
    ),
});
export type StallIdeasReply = z.infer<typeof StallIdeasReplySchema>;

/**
 * {@link StallIdeasReplySchema} as a JSON Schema, in the subset strict
 * structured output accepts — closed objects, everything required, no length
 * keywords. The limits live in the descriptions, in
 * `server/prompts/stall-ideas.md`, and are enforced by the zod schema above;
 * `shared/stall.test.ts` holds the two in agreement.
 */
export const stallIdeasJsonSchema = {
  type: "object",
  properties: {
    topic: {
      type: "string",
      description:
        `What the group is stuck on, in at most ${STALL_TOPIC_MAX_WORDS} words, as the ` +
        `object of a sentence and in their own words: "the name", "the Thursday slot". ` +
        `No article unless they used one.`,
      },
    ideas: {
      type: "array",
      description:
        `At most ${MAX_STALL_IDEAS} ideas, best first, each one sentence of at most ` +
        `${STALL_IDEA_MAX_WORDS} words written to be said out loud. Fewer is better than ` +
        `padding. An empty array if you have nothing they have not already tried.`,
      items: { type: "string" },
    },
  },
  required: ["topic", "ideas"],
  additionalProperties: false,
} as const;

/** One set of ideas, once it has an identity. */
export interface StallIdeas {
  /** Unique within the session: `stall-1`, `stall-2`, … */
  id: string;
  /** The `stall` candidate it came from. */
  candidateId: string;
  /** What the group is stuck on, as the offer and the ideas are addressed to. */
  topic: string;
  /** What they are stuck on in a sentence: the candidate's own headline. */
  stuckOn: string;
  /** Up to three ideas, each a sentence. */
  ideas: string[];
  /** The turn the stall was noticed in, for the log. */
  turnId: string;
  /** When the ideas came back, on the session clock. */
  createdAtMs: number;
}

/** Why a noticed stall produced no offer. */
export const stallOutcomes = [
  "offered",
  "cooldown",
  "no_ideas",
  "offer_open",
  "failed",
  "session_ended",
] as const;
export type StallOutcome = (typeof stallOutcomes)[number];

/**
 * One `stall` line of `timing.jsonl`: a loop noticed, and what became of it.
 *
 * Written for every noticed stall, offered or not, because "the group was
 * stuck and Sotto said nothing" is the outcome the ten-minute limit and the
 * one-offer-at-a-time rule are *meant* to produce, and a reader has to be
 * able to tell it from "nothing was noticed".
 */
export interface StallLogRecord {
  stage: "stall";
  /** When the outcome was decided, on the session clock. */
  atMs: number;
  candidateId: string;
  /** The ideas' id, once there are ideas. */
  stallId?: string;
  /** What they are stuck on: the candidate's headline. */
  headline: string;
  topic?: string;
  ideas?: string[];
  outcome: StallOutcome;
  /** Real milliseconds the ideas call took, when one was made. */
  latencyMs?: number;
  /** Why the call did not come back, when it did not. */
  error?: string;
}
