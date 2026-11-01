/**
 * What the observer noticed, and what the policy will decide about it
 * (PRD US-012–US-014).
 *
 * A **candidate** is one thing the observer noticed: a contradiction, a
 * factual error, an untested assumption, a dropped thread, a question nobody
 * answered, or something worth looking up (V2-011). Noticing is cheap and
 * saying something is expensive, so every candidate is written down with its
 * scores (`candidates.jsonl`) and only a few of them ever reach the stage —
 * and a `research_hook` is not for the stage at all, but for the research
 * gate (V2-012).
 *
 * The limits in the PRD — ninety characters of headline, sixty words of
 * detail, twenty of "why now" — are asked for in the prompt and in the
 * schema's descriptions, because strict structured output rejects length
 * keywords. {@link ObserverCandidateSchema} then *enforces* them by clipping,
 * so anything downstream can lay a candidate out without measuring it first.
 */
import { z } from "zod";
import type { Citation, EvidenceQuote } from "./cards.js";
import type { Decision, DecisionReason, PolicyDecision } from "./policy.js";

/**
 * The six things the observer looks for.
 *
 * - `contradiction`: what was just said cannot hold together with something
 *   the group already settled or stated.
 * - `factual_error`: a checkable claim that looks wrong. Verified against the
 *   web before it ever reaches the group (US-013).
 * - `untested_assumption`: the plan rests on something nobody has checked.
 * - `dropped_thread`: an idea or a risk the group raised and abandoned, now
 *   bearing on where they have got stuck. A question nobody answered is an
 *   `unanswered_question`, not this: the two were one type until V2-011 split
 *   them, and they do not overlap.
 * - `unanswered_question`: somebody asked the group something directly,
 *   nobody answered it, and the conversation moved on.
 * - `research_hook`: outside information would clearly settle something —
 *   asked for out loud, or a number nobody in the room can back up. The one
 *   type that never reaches the interjection policy: a hook is an *idea for
 *   the research gate* (V2-012), not something to say to anybody.
 */
export const candidateTypes = [
  "contradiction",
  "factual_error",
  "untested_assumption",
  "dropped_thread",
  "unanswered_question",
  "research_hook",
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
  /**
   * The turns in {@link ObserverCandidate.evidenceTurnIds}, resolved to what
   * was actually said, oldest first. A cited turn the assembler has never
   * seen is left out, so this can be shorter than the id list — or empty.
   *
   * The headline is the observer's *reading* of the conversation and usually
   * states the correction rather than the claim ("Instagram launched in 2010,
   * not 2014"), so anything that has to reason about what the group said —
   * the fact check (US-013) first, the evidence quotes on a card (US-015)
   * next — needs the words, not the headline.
   */
  evidence: EvidenceQuote[];
  /**
   * What the web check made of it (US-013). Present only on a `factual_error`
   * that was checked *and* came back `wrong`: the other verdicts stop at the
   * verifier and never reach the policy.
   */
  verification?: CandidateVerification;
  /** The pages the check rested on, in the order they were cited. */
  citations?: Citation[];
  /**
   * The observer's own four scores, kept when the gate (V2-016) replaced
   * {@link ObserverCandidate.scores} with its own. Absent when nothing did.
   */
  observerScores?: CandidateScores;
  /**
   * What the local gate made of it (V2-016), when one ran. `scores` are
   * already the mapping of this (`scoresFromGate` in
   * `server/interject/policy.ts`), so the policy never reads this — it is
   * here for the log and for anything that wants to know *why* the score
   * changed.
   */
  gate?: CandidateGateVerdict;
}

/**
 * The four questions the gate asks about one candidate (V2-016), each a
 * probability between 0 and 1.
 *
 * The observer proposes and scores its own candidates, which is the model
 * marking its own homework: a model that has just decided something is worth
 * raising is the worst judge of whether it is. So a second, local model is
 * asked the four questions that actually decide it, and its answers replace
 * the observer's {@link CandidateScores} on the way to the policy.
 *
 * The names are the questions as the PRD puts them, which is also how they
 * are asked in `server/prompts/gate.md`.
 */
export interface GateScores {
  /** That the point is really supported by the transcript. */
  true: number;
  /** That it has not been said already and is not on the board. */
  new: number;
  /** That a thoughtful participant in the room would raise it. */
  worthSaying: number;
  /** That the conversation has not moved on from it. */
  stillRelevant: number;
}

/**
 * Which model answered the gate.
 *
 * `glimmer` is Muse Glimmer on this Mac — the point of the exercise, since
 * judgment then costs nothing and leaves the room. `spark-fallback` is Muse
 * Spark answering because there is no local model to ask (V2-010): the
 * judgment still happens, it just happens in the cloud and by a different
 * model than the one being judged's own scoring pass.
 */
export const candidateGates = ["glimmer", "spark-fallback"] as const;
export type CandidateGateWhere = (typeof candidateGates)[number];

/**
 * Who scores a candidate: the gate, or the observer that proposed it.
 *
 * - `glimmer`: the gate runs — locally when there is a local model, and on
 *   Muse Spark when there is not (V2-010), which is the difference between
 *   {@link candidateGates}' two values.
 * - `spark`: no gate call at all. The observer is Muse Spark and its own four
 *   scores stand, which is what the core build shipped and what
 *   `npm run eval -- --gate spark` measures the local gate against.
 */
export const gateModes = ["glimmer", "spark"] as const;
export type GateMode = (typeof gateModes)[number];

/**
 * The interjection path is gated by Muse Spark, which is to say by the
 * observer's own scores and no second call at all (PRD V3-001).
 *
 * V2-016 made this `glimmer`, and the overnight A/B of 2026-11-01 took it
 * back: a local verdict costs **24–34 s** (median 23.7) while a planted
 * interjection window is 12–29 s wide, so the gate's judgment arrives after
 * the moment it was about — measured in the real-time e2e as deliveries
 * 31.9 s and 50.1 s *past* their deadline. With the same prompts, Spark beat
 * Glimmer on moment recall (9/9 against 7/9) and precision (5/6 against 4/5)
 * and suppressed nothing verified. The `max`-speed eval hides all of this,
 * because simulated time stands still inside a tracked model call.
 *
 * Glimmer keeps the judgment call nobody is waiting on: `ResearchGate`
 * (V2-012), where 16–21 s sits inside a 16–21 s search and the open-weight
 * model does the vetting for free. `--gate glimmer` still forces this path
 * back onto it for an A/B run.
 */
export const DEFAULT_GATE_MODE: GateMode = "spark";

/** What one gate call decided about one candidate. */
export interface CandidateGateVerdict {
  gate: CandidateGateWhere;
  scores: GateScores;
  /**
   * Real milliseconds the call took. Wall clock, not the session clock: a
   * `max`-speed replay's clock stands still while a call is in flight, and
   * how long a local model takes to answer is the thing worth knowing.
   */
  latencyMs: number;
}

/**
 * One line of `candidates.jsonl` recording a gate call (V2-016).
 *
 * It carries both sets of scores on purpose: the observer's, as proposed, and
 * the gate's, so a report can say what the second opinion changed. A call
 * that did not come back is written down too, with `gateScores` absent and
 * `error` set — the candidate then goes on with the observer's own scores,
 * which is the behaviour the gate replaced, rather than being dropped.
 */
export interface CandidateGateLogRecord {
  kind: "gate";
  /** When the verdict came back, on the session clock. */
  atMs: number;
  /** The {@link Candidate.id} that was scored. */
  candidateId: string;
  /** The claim, so the file reads without cross-referencing. */
  headline: string;
  type: CandidateType;
  /** The scores the observer proposed. */
  observerScores: CandidateScores;
  /** The gate's four probabilities. Absent when no verdict came back. */
  gateScores?: GateScores;
  /** Which model answered, or `null` when there was none to ask. */
  gate: CandidateGateWhere | null;
  /** The scores the policy will actually use. */
  scores: CandidateScores;
  /** What those score together, which is what the thresholds see. */
  score: number;
  latencyMs: number;
  /** Why no verdict came back, when none did. */
  error?: string;
}

/**
 * One line of `candidates.jsonl`.
 *
 * Every candidate is written here before the policy sees it, so the file is
 * the record of what Sotto noticed as well as of what it said. US-013's
 * verification appends {@link VerificationLogRecord}s alongside, and the
 * policy's decisions {@link DecisionLogRecord}s.
 */
export interface CandidateLogRecord {
  kind: "candidate";
  /** When it was written, on the session clock. */
  atMs: number;
  candidate: Candidate;
}

/** What the web check (US-013) decided about a claim. */
export const verificationVerdicts = ["wrong", "right", "unclear"] as const;
export type VerificationVerdict = (typeof verificationVerdicts)[number];

/** Words of correction. The right fact, not an essay about it. */
export const CORRECTION_MAX_WORDS = 30;

/**
 * Words a *verified* candidate's detail can run to: its own
 * {@link DETAIL_MAX_WORDS} plus the correction appended to it by
 * {@link correctedDetail}. The UI lays out for this, not for the shorter cap.
 */
export const VERIFIED_DETAIL_MAX_WORDS = DETAIL_MAX_WORDS + CORRECTION_MAX_WORDS;

/** The label the correction is appended under, so one spelling exists. */
export const CORRECTION_LABEL = "**Correction:**";

/**
 * The detail a verified candidate carries: its own reasoning, then the
 * checked fact underneath it.
 *
 * Both halves are already clipped — the detail by
 * {@link ObserverCandidateSchema}, the correction by
 * {@link VerificationReplySchema} — so the result is bounded by
 * {@link VERIFIED_DETAIL_MAX_WORDS} by construction and is never re-clipped:
 * cutting words off a correction to fit a layout would be cutting the one
 * part the group actually needs.
 */
export function correctedDetail(detail: string, correction: string): string {
  const checked = correction.trim();
  if (checked === "") return detail;
  return `${detail}\n\n${CORRECTION_LABEL} ${checked}`;
}

/** One claim, checked against the web. */
export interface CandidateVerification {
  verdict: VerificationVerdict;
  /** The right fact, when the verdict is `wrong`. Empty otherwise. */
  correction: string;
  /**
   * The pages the verdict rests on, deduplicated by URL. These come from the
   * reply's `url_citation` annotations — pages the search really returned —
   * never from URLs the model merely listed.
   */
  citations: Citation[];
  /**
   * Whether the model actually ran a web search. It may answer a question it
   * is confident about from training data alone, and a verdict reached that
   * way is worth telling apart from a grounded one in the log.
   */
  searched: boolean;
}

/**
 * What became of a checked candidate.
 *
 * - `verified`: the claim is wrong and the candidate went on to the policy.
 * - `unverified`: `right` or `unclear`, so it stops here (PRD US-013).
 * - `failed`: the check itself did not come back. Also stops: an unchecked
 *   claim must not be told to the group as an error.
 */
export const verificationOutcomes = ["verified", "unverified", "failed"] as const;
export type VerificationOutcome = (typeof verificationOutcomes)[number];

/** One line of `candidates.jsonl` recording a check. */
export interface VerificationLogRecord {
  kind: "verification";
  /** When the check came back, on the session clock. */
  atMs: number;
  /** The {@link Candidate.id} that was checked. */
  candidateId: string;
  /** The claim as it was sent for checking, for reading the file later. */
  headline: string;
  outcome: VerificationOutcome;
  /** Absent when the outcome is `failed`. */
  verification?: CandidateVerification;
  /** Why the check did not come back, when it did not. */
  error?: string;
}

/**
 * One line of `candidates.jsonl` recording what the policy (US-014) decided
 * about a candidate.
 *
 * A candidate can be decided more than once: one `hold` while somebody is
 * still talking, then `delivered` at the pause that follows. Each decision is
 * its own line, so the file shows how long something waited as well as what
 * became of it.
 */
export interface DecisionLogRecord extends PolicyDecision {
  kind: "decision";
  /** When the decision was made, on the session clock. */
  atMs: number;
  /** The {@link Candidate.id} it was made about. */
  candidateId: string;
  /** The claim, so the file reads without cross-referencing. */
  headline: string;
  type: CandidateType;
  /** How long the candidate had been waiting for a pause when it was made. */
  heldForMs: number;
  /** Final turns that have gone by since the policy first saw it. */
  turnsWaited: number;
}

/** Every kind of line `candidates.jsonl` holds. */
export type CandidateLogLine =
  | CandidateLogRecord
  | CandidateGateLogRecord
  | VerificationLogRecord
  | DecisionLogRecord;

/** Re-exported so a reader of a log line has the vocabulary to hand. */
export type { Decision, DecisionReason };

/**
 * One candidate Sotto held back, with the reason it did.
 *
 * What the digest's "What Sotto almost said" is made of (V2-018), and since
 * V3-016 also what the stage's "almost said" tray shows and what the shadow
 * report ends with — three readers of one record, which is why it is here
 * rather than in `server/session/digest.ts` where it is computed.
 */
export interface SuppressedCandidate {
  candidateId: string;
  headline: string;
  type: CandidateType;
  /** 0–1, as the policy or the gate scored it. */
  score: number;
  /** The policy's reason in words: "below threshold", "cooldown", … */
  reason: string;
}

/** The `json_schema.name` an observer request sends. */
export const OBSERVER_SCHEMA_NAME = "observer_candidates";

const gateScore = (what: string) =>
  ({ type: "number", description: `0 to 1. ${what}` }) as const;

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
              "dropped_thread: an idea or a risk the group raised and abandoned. " +
              "unanswered_question: a direct question nobody answered before the " +
              "conversation moved on. " +
              "research_hook: outside information would clearly help, and a web " +
              "search could find it.",
            enum: [...candidateTypes],
          },
          headline: {
            type: "string",
            description:
              `The point, in one sentence of at most ${HEADLINE_MAX_CHARS} characters. ` +
              "For contradiction, untested_assumption and dropped_thread: a specific " +
              "question about what the group just said, never a verdict or a label. " +
              "For factual_error: the correction itself. For unanswered_question and " +
              "research_hook: the question, in the group's own words where there is one.",
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

/** The `json_schema.name` a verification request sends. */
export const VERIFICATION_SCHEMA_NAME = "fact_verification";

/**
 * The verifier's reply (US-013).
 *
 * `citations` is in the reply because asking the model to name its sources
 * keeps it honest about whether it looked, but the citations that reach the
 * group are the response's `url_citation` annotations; a URL only the model
 * listed is never attached. See {@link CandidateVerification.citations}.
 */
export const VerificationReplySchema = z.strictObject({
  verdict: z.enum(verificationVerdicts),
  correction: z.string().transform((text) => clipWords(oneLine(text), CORRECTION_MAX_WORDS)),
  /** Validated one element at a time, as the observer's candidates are. */
  citations: z.array(z.unknown()),
});

/** One source as the model lists it. Only its title is ever used. */
export const ModelCitationSchema = z.strictObject({
  url: z.string(),
  title: z.string(),
});

/**
 * {@link VerificationReplySchema} as a JSON Schema, in the subset strict
 * structured output accepts — closed objects, everything required, no length
 * keywords. The thirty-word limit lives in the description, in
 * `server/prompts/verify.md`, and is enforced by the zod schema above;
 * `shared/candidates.test.ts` holds the two in agreement.
 */
export const verificationJsonSchema = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      description:
        "wrong: the claim is false and you can show it. " +
        "right: the claim is true, or true enough that saying anything would be pedantry. " +
        "unclear: you could not establish it either way.",
      enum: [...verificationVerdicts],
    },
    correction: {
      type: "string",
      description:
        `When the verdict is wrong: the right fact, in at most ${CORRECTION_MAX_WORDS} words, ` +
        `as one sentence a person could say out loud. Empty string for any other verdict.`,
    },
    citations: {
      type: "array",
      description:
        "The pages you actually read, best first. Empty if you did not search. " +
        "Do not invent a URL: a source that was not in the search results is worse than none.",
      items: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The page's full URL, exactly as the search gave it to you, with its path and " +
              "query string. Not the site's name and not a shortened form of it.",
          },
          title: { type: "string", description: "The page's title." },
        },
        required: ["url", "title"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "correction", "citations"],
  additionalProperties: false,
} as const;

/** The `json_schema.name` a gate request sends (V2-016). */
export const CANDIDATE_GATE_SCHEMA_NAME = "candidate_gate";

/** The gate's reply: one probability per question, nothing else. */
export const CandidateGateReplySchema = z.strictObject({
  true: ScoreSchema,
  new: ScoreSchema,
  worthSaying: ScoreSchema,
  stillRelevant: ScoreSchema,
});

/**
 * {@link CandidateGateReplySchema} as a JSON Schema.
 *
 * Glimmer never reads these descriptions — Ollama compiles the schema into a
 * grammar and the model is told nothing by it — so they are for Muse Spark,
 * which does read them, and the whole brief is in `server/prompts/gate.md`
 * for both.
 */
export const candidateGateJsonSchema = {
  type: "object",
  properties: {
    true: gateScore("That the point is really supported by the transcript."),
    new: gateScore("That nobody has said it and it is not already on the board."),
    worthSaying: gateScore("That a thoughtful participant would raise it now."),
    stillRelevant: gateScore("That the conversation has not moved on from it."),
  },
  required: ["true", "new", "worthSaying", "stillRelevant"],
  additionalProperties: false,
} as const;
