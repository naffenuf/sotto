/**
 * What the observer noticed, and what the policy will decide about it
 * (PRD US-012–US-014).
 *
 * A **candidate** is one thing that might be worth saying out loud: a
 * contradiction, a factual error, an untested assumption, a dropped thread.
 * Noticing is cheap and saying something is expensive, so every candidate is
 * written down with its scores (`candidates.jsonl`) and only a few of them
 * ever reach the stage.
 *
 * The limits in the PRD — ninety characters of headline, sixty words of
 * detail, twenty of "why now" — are asked for in the prompt and in the
 * schema's descriptions, because strict structured output rejects length
 * keywords. {@link ObserverCandidateSchema} then *enforces* them by clipping,
 * so anything downstream can lay a candidate out without measuring it first.
 */
import { z } from "zod";

/**
 * The four things the observer looks for.
 *
 * - `contradiction`: what was just said cannot hold together with something
 *   the group already settled or stated.
 * - `factual_error`: a checkable claim that looks wrong. Verified against the
 *   web before it ever reaches the group (US-013).
 * - `untested_assumption`: the plan rests on something nobody has checked.
 * - `dropped_thread`: a question or risk the group raised and walked away from.
 */
export const candidateTypes = [
  "contradiction",
  "factual_error",
  "untested_assumption",
  "dropped_thread",
] as const;
export type CandidateType = (typeof candidateTypes)[number];

/** Headline length the UI lays out for. */
export const HEADLINE_MAX_CHARS = 90;

/** Words of detail. Longer than this is an essay, and nobody reads it mid-talk. */
export const DETAIL_MAX_WORDS = 60;

/** Words of "why now". One clause. */
export const WHY_NOW_MAX_WORDS = 20;

/** How many candidates one observer run may hand on. */
export const MAX_CANDIDATES_PER_RUN = 3;

/**
 * How much a candidate is worth, each on 0–1. The policy (US-014) multiplies
 * these into one score; they are kept apart here so `candidates.jsonl` records
 * *why* something scored the way it did.
 */
export interface CandidateScores {
  /** How closely it relates to what the group is talking about right now. */
  relevance: number;
  /** That it has not been said already, and is not on the board as raised. */
  novelty: number;
  /** How much it would change the group's decision if it went unsaid. */
  importance: number;
  /** How sure the model is that the issue is real. */
  confidence: number;
}

/** Collapses whitespace: every field of a candidate is shown on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `text`, cut to `max` characters at a word boundary with an ellipsis. */
export function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** `text`, cut to `max` words with an ellipsis. */
export function clipWords(text: string, max: number): string {
  const words = text.split(" ");
  if (words.length <= max) return text;
  return `${words.slice(0, max).join(" ")}…`;
}

/** Keeps a score usable even when the model gets inventive about the range. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const ScoreSchema = z.number().transform(clamp01);

const ScoresSchema = z.strictObject({
  relevance: ScoreSchema,
  novelty: ScoreSchema,
  importance: ScoreSchema,
  confidence: ScoreSchema,
});

/**
 * One candidate exactly as the model returns it, with the stated limits
 * applied.
 *
 * Validation is per candidate rather than per reply: one malformed candidate
 * must not throw away the good ones beside it, the same way a bad board
 * operation does not discard the rest of an update.
 */
export const ObserverCandidateSchema = z.strictObject({
  type: z.enum(candidateTypes),
  headline: z
    .string()
    .transform((text) => clipChars(oneLine(text), HEADLINE_MAX_CHARS))
    .refine((text) => text !== "", { message: "headline is empty" }),
  detail: z.string().transform((text) => clipWords(oneLine(text), DETAIL_MAX_WORDS)),
  whyNow: z.string().transform((text) => clipWords(oneLine(text), WHY_NOW_MAX_WORDS)),
  /** Turn ids the issue rests on, copied from the transcript. */
  evidenceTurnIds: z.array(z.string()),
  /** Board item ids (`c1`, `p4`) the issue is about. */
  relatedBoardItemIds: z.array(z.string()),
  scores: ScoresSchema,
});
export type ObserverCandidate = z.infer<typeof ObserverCandidateSchema>;

/** The model's whole reply. The candidates are validated one at a time. */
export const ObserverReplySchema = z.strictObject({
  candidates: z.array(z.unknown()),
});

/** A candidate once the observer has given it an identity. */
export interface Candidate extends ObserverCandidate {
  /** Unique within the session: `cand-1`, `cand-2`, … */
  id: string;
  /** When the observer run that produced it finished, on the session clock. */
  createdAtMs: number;
  /** Which observer run produced it, counting from 1. */
  run: number;
  /**
   * Id of the earlier candidate this repeats, when it is one. A duplicate is
   * still written down — it is evidence about the observer — but it is not
   * passed on to the policy.
   */
  duplicateOf?: string;
}

/**
 * One line of `candidates.jsonl`.
 *
 * Every candidate is written here before the policy sees it, so the file is
 * the record of what Sotto noticed as well as of what it said. US-013's
 * verification and US-014's decisions append their own `kind`s alongside.
 */
export interface CandidateLogRecord {
  kind: "candidate";
  /** When it was written, on the session clock. */
  atMs: number;
  candidate: Candidate;
}

/** The `json_schema.name` an observer request sends. */
export const OBSERVER_SCHEMA_NAME = "observer_candidates";

const scoreProperty = (what: string) =>
  ({ type: "number", description: `0 to 1. ${what}` }) as const;

/**
 * {@link ObserverCandidateSchema} as a JSON Schema, in the subset strict
 * structured output accepts: every object closed and fully `required`, and no
 * `minItems`/`maxItems`/`maxLength`/`minimum`/`maximum`. The limits those
 * keywords would carry are stated in the descriptions and in
 * `server/prompts/observer.md`, and enforced after the fact by the zod schema
 * above; `shared/candidates.test.ts` holds the two in agreement.
 */
export const observerCandidatesJsonSchema = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      description:
        `Nothing worth raising is the normal answer: return an empty array. ` +
        `At most ${MAX_CANDIDATES_PER_RUN}, best first.`,
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "contradiction: conflicts with something stated or decided. " +
              "factual_error: a checkable claim that looks wrong. " +
              "untested_assumption: the plan rests on something nobody checked. " +
              "dropped_thread: a question or risk the group walked away from.",
            enum: [...candidateTypes],
          },
          headline: {
            type: "string",
            description: `The point, in one sentence of at most ${HEADLINE_MAX_CHARS} characters.`,
          },
          detail: {
            type: "string",
            description: `The reasoning, in at most ${DETAIL_MAX_WORDS} words. Markdown allowed.`,
          },
          whyNow: {
            type: "string",
            description: `Why this is worth saying at this moment, in at most ${WHY_NOW_MAX_WORDS} words.`,
          },
          evidenceTurnIds: {
            type: "array",
            description:
              "Ids of the turns this rests on, copied exactly from the [id] at the start of a transcript line. At least one.",
            items: { type: "string" },
          },
          relatedBoardItemIds: {
            type: "array",
            description:
              "Ids of the board items this is about (c1, p4, q2, d3). Empty if none apply.",
            items: { type: "string" },
          },
          scores: {
            type: "object",
            properties: {
              relevance: scoreProperty("How closely this relates to the current topic."),
              novelty: scoreProperty(
                "That nobody has said it and it is not already on the board as raised.",
              ),
              importance: scoreProperty(
                "How much the group's decision would change if this went unsaid.",
              ),
              confidence: scoreProperty("How sure you are the issue is real."),
            },
            required: ["relevance", "novelty", "importance", "confidence"],
            additionalProperties: false,
          },
        },
        required: [
          "type",
          "headline",
          "detail",
          "whyNow",
          "evidenceTurnIds",
          "relatedBoardItemIds",
          "scores",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;
