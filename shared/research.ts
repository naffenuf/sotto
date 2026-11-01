/**
 * What Sotto decides to look up, and why (PRD V2-012).
 *
 * A **research idea** is one checkable question worth putting to a web
 * search. Two things produce them: a `research_hook` candidate, which is the
 * observer noticing that outside information would settle something
 * (V2-011), and the planner, which reads the board every couple of minutes
 * and proposes a couple of its own. Both arrive here as the same shape, are
 * deduplicated against everything the session has already thought of, and are
 * then scored by the **gate** — Muse Glimmer on this Mac, falling back to
 * Muse Spark (V2-010) — on the three questions that decide whether looking it
 * up is worth anything: is it useful to this group now, is it something they
 * do not already know, and can a search actually answer it.
 *
 * Noticing is cheap, searching is not, so the gate is deliberately a filter
 * rather than a ranking: everything it sees is written to `research.jsonl`,
 * and only the ideas above {@link RESEARCH_GATE_THRESHOLD} are queued for the
 * runner (V2-013), which the budget then starts at most a few of.
 */
import { z } from "zod";
import { clipChars, clipWords } from "./candidates.js";

/** Where an idea came from. Recorded, because the two differ in quality. */
export const researchOrigins = ["hook", "planner"] as const;
export type ResearchOrigin = (typeof researchOrigins)[number];

/** Characters of topic. A handle for the idea, not a sentence. */
export const TOPIC_MAX_CHARS = 60;

/** Characters of question. One thing a search could answer. */
export const QUESTION_MAX_CHARS = 160;

/** Words of "why". One clause, as with a candidate's `whyNow`. */
export const WHY_MAX_WORDS = 25;

/** How many ideas one planner run may propose. */
export const MAX_PLANNER_IDEAS = 2;

/**
 * One thing worth looking up.
 *
 * Exactly the five fields the PRD names. Where it came from, when it was
 * thought of and what the gate made of it all live on the log records below:
 * an idea is the question, and nothing about its history changes it.
 */
export interface ResearchIdea {
  /** Unique within the session: `idea-1`, `idea-2`, … */
  id: string;
  /** Two or three words naming the subject, for the dedupe and the log. */
  topic: string;
  /** The question a web search would answer. */
  question: string;
  /** What it would settle for this group. */
  why: string;
  /** Turn ids it came out of, copied from the transcript. */
  sourceTurnIds: string[];
}

/** Collapses whitespace: every field of an idea is shown on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * One idea as the planner returns it, with the stated limits applied.
 *
 * Validated per idea rather than per reply, the way the observer's candidates
 * are: one malformed idea must not throw away the good one beside it.
 */
export const PlannerIdeaSchema = z.strictObject({
  topic: z
    .string()
    .transform((text) => clipChars(oneLine(text), TOPIC_MAX_CHARS))
    .refine((text) => text !== "", { message: "topic is empty" }),
  question: z
    .string()
    .transform((text) => clipChars(oneLine(text), QUESTION_MAX_CHARS))
    .refine((text) => text !== "", { message: "question is empty" }),
  why: z.string().transform((text) => clipWords(oneLine(text), WHY_MAX_WORDS)),
  sourceTurnIds: z.array(z.string()),
});
export type PlannerIdea = z.infer<typeof PlannerIdeaSchema>;

/** The planner's whole reply. The ideas are validated one at a time. */
export const PlannerReplySchema = z.strictObject({
  ideas: z.array(z.unknown()),
});

/** The `json_schema.name` a planner request sends. */
export const RESEARCH_PLANNER_SCHEMA_NAME = "research_ideas";

/**
 * {@link PlannerIdeaSchema} as a JSON Schema, in the subset strict structured
 * output accepts: every object closed and fully `required`, and no length
 * keywords. The limits those would carry are stated in the descriptions and
 * in `server/prompts/research-planner.md`, and enforced after the fact by the
 * zod schema above; `shared/research.test.ts` holds the two in agreement.
 */
export const researchPlannerJsonSchema = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      description:
        `At most ${MAX_PLANNER_IDEAS}, best first. An empty array when this ` +
        `stretch of conversation holds no checkable question — but a question ` +
        `that clears the four tests belongs here, because something after you ` +
        `decides whether it is worth searching for.`,
      items: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: `What it is about, in two or three words (at most ${TOPIC_MAX_CHARS} characters).`,
          },
          question: {
            type: "string",
            description:
              `The question to look up, in at most ${QUESTION_MAX_CHARS} characters. ` +
              `One thing a web search could answer, specific enough to be checkable.`,
          },
          why: {
            type: "string",
            description: `What it would settle for this group, in at most ${WHY_MAX_WORDS} words.`,
          },
          sourceTurnIds: {
            type: "array",
            description:
              "Ids of the turns this came out of, copied exactly from the [id] at the start of a transcript line. At least one.",
            items: { type: "string" },
          },
        },
        required: ["topic", "question", "why", "sourceTurnIds"],
        additionalProperties: false,
      },
    },
  },
  required: ["ideas"],
  additionalProperties: false,
} as const;

/**
 * What the gate makes of an idea, each on 0–1.
 *
 * The names are the ones the V2-010 probe measured against the real Glimmer,
 * and they are deliberately short: Ollama compiles the schema into a grammar
 * and the model never reads a word of it, so the key is all the model has to
 * go on besides `server/prompts/research-gate.md`.
 */
export interface ResearchGateScores {
  /** That the answer would be useful to this group, in this conversation. */
  useful: number;
  /** That they do not already know it — nobody has said it and it is not on the board. */
  unknown: number;
  /** That a web search could actually answer it. */
  answerable: number;
}

/** Keeps a score usable even when the model gets inventive about the range. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const ScoreSchema = z.number().transform(clamp01);

/** The gate's reply. One probability per question, nothing else. */
export const ResearchGateReplySchema = z.strictObject({
  useful: ScoreSchema,
  unknown: ScoreSchema,
  answerable: ScoreSchema,
});

/** The `json_schema.name` a gate request sends. */
export const RESEARCH_GATE_SCHEMA_NAME = "research_gate";

const gateScore = (what: string) =>
  ({ type: "number", description: `0 to 1. ${what}` }) as const;

/**
 * {@link ResearchGateReplySchema} as a JSON Schema. Glimmer never sees these
 * descriptions — the grammar is all the schema does there — so they are for
 * Muse Spark, which does read them; the ranges are in the prompt for both.
 */
export const researchGateJsonSchema = {
  type: "object",
  properties: {
    useful: gateScore("That the answer would be useful to this group, now."),
    unknown: gateScore("That they do not already know it from the conversation or the board."),
    answerable: gateScore("That a web search could actually answer it."),
  },
  required: ["useful", "unknown", "answerable"],
  additionalProperties: false,
} as const;

/**
 * One number from the gate's three.
 *
 * The geometric mean, so a low score on any one question drags the idea down
 * — a question nobody can answer is worthless however interesting, and so is
 * a fascinating one the group settled five minutes ago — while an idea that
 * is merely good everywhere keeps roughly its own level, which a plain
 * product would not (0.7³ is 0.34).
 */
export function researchScore(scores: ResearchGateScores): number {
  const product = clamp01(scores.useful) * clamp01(scores.unknown) * clamp01(scores.answerable);
  return Math.cbrt(product);
}

/** What an idea has to score to be queued for a search. */
export const RESEARCH_GATE_THRESHOLD = 0.6;

/**
 * Two questions whose content words overlap at least this much are the same
 * question in different words.
 *
 * Measured on words rather than judged by a model, for the same reason the
 * observer's duplicate check is: a call per idea to discover that the planner
 * asked about competitors twice is not worth making. The *judged* half of
 * "same topic, or a question judged equivalent" is the gate's `unknown`
 * score, which is asked about the conversation as a whole.
 */
export const QUESTION_OVERLAP = 0.6;

/**
 * Whether `idea` repeats one of `earlier`, and which it repeats.
 *
 * Two kinds of repeat count: the same topic, and a question that says the
 * same thing. `earlier` is every idea the session has had — a packet's idea
 * is still in that list once the packet exists — so this is also the
 * deduplication against earlier packets the PRD asks for.
 */
export function findDuplicateIdea(
  idea: Pick<ResearchIdea, "topic" | "question">,
  earlier: readonly ResearchIdea[],
): string | undefined {
  const topic = topicKey(idea.topic);
  const words = contentWords(idea.question);
  for (const previous of earlier) {
    if (topic !== "" && topicKey(previous.topic) === topic) return previous.id;
    if (overlap(words, contentWords(previous.question)) >= QUESTION_OVERLAP) return previous.id;
  }
  return undefined;
}

/** A topic, as the dedupe compares it: lowercase, unpunctuated, unspaced. */
export function topicKey(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Words of a question worth comparing: lowercased, unpunctuated, not filler. */
const STOP_WORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "by", "can", "could", "do", "does",
  "for", "from", "has", "have", "how", "in", "is", "it", "its", "many", "much", "of", "on", "or",
  "our", "that", "the", "their", "there", "they", "this", "to", "was", "we", "what", "when",
  "where", "which", "who", "will", "with", "would", "you", "your",
]);

function contentWords(question: string): Set<string> {
  return new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9$%'\s-]/g, " ")
      .split(/\s+/)
      .filter((word) => word !== "" && !STOP_WORDS.has(word)),
  );
}

/** Jaccard overlap of two word sets; 1 when identical, 0 when disjoint. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Where a gate verdict ran. Structurally {@link JudgmentWhere}. */
export type ResearchGateWhere = "local" | "cloud";

/**
 * What the gate decided.
 *
 * - `queued`: above threshold, waiting for the budget to start it.
 * - `rejected`: below threshold. Most ideas end here, and that is the point.
 * - `failed`: the gate call itself did not come back. Also stops — an
 *   unscored idea must not spend a search slot the group might need.
 */
export const researchGateDecisions = ["queued", "rejected", "failed"] as const;
export type ResearchGateDecision = (typeof researchGateDecisions)[number];

/** One line of `research.jsonl`: an idea, as it was thought of. */
export interface ResearchIdeaRecord {
  kind: "idea";
  /** When it was recorded, on the session clock. */
  atMs: number;
  origin: ResearchOrigin;
  idea: ResearchIdea;
  /** Id of the earlier idea this repeats, when it is one. Then it stops here. */
  duplicateOf?: string;
  /** The `research_hook` candidate it came from, for a `hook`. */
  candidateId?: string;
}

/** One line of `research.jsonl`: what the gate made of an idea. */
export interface ResearchGateRecord {
  kind: "gate";
  /** When the verdict came back, on the session clock. */
  atMs: number;
  ideaId: string;
  /** The question, so the file reads without cross-referencing. */
  question: string;
  decision: ResearchGateDecision;
  /** Which model answered, or `null` when there was none to ask. */
  where: ResearchGateWhere | null;
  /** Absent when the decision is `failed`. */
  scores?: ResearchGateScores;
  /** {@link researchScore} of those scores; 0 when there are none. */
  score: number;
  threshold: number;
  /** Real milliseconds the call took: a judgment call is wall-clock work. */
  latencyMs: number;
  /** Why no verdict came back, when none did. */
  error?: string;
}

/** One line of `research.jsonl`: a job the budget let start (V2-013 runs it). */
export interface ResearchStartRecord {
  kind: "start";
  atMs: number;
  ideaId: string;
  question: string;
  /** How many jobs are running including this one, and the cap it is under. */
  running: number;
  /** Jobs started in the last {@link RESEARCH_WINDOW_MS}, including this one. */
  startedInWindow: number;
}

/** Every kind of line `research.jsonl` holds. V2-013 adds the packet. */
export type ResearchLogLine = ResearchIdeaRecord | ResearchGateRecord | ResearchStartRecord;

/** How long the "jobs started" budget looks back. */
export const RESEARCH_WINDOW_MS = 10 * 60_000;

/** Jobs that may be started in one {@link RESEARCH_WINDOW_MS}. */
export const MAX_JOBS_PER_WINDOW = 3;

/** Jobs that may be running at the same time. */
export const MAX_CONCURRENT_JOBS = 2;

/**
 * A short topic for a question that arrived without one.
 *
 * A `research_hook` candidate is a headline, a reasoning and some turn ids
 * (V2-011) — the raw material for an idea, but no topic — so one is read off
 * the question: its first few content words, which is what the dedupe
 * compares anyway. Two hooks asking the same thing land on the same handle;
 * a planner idea about the same subject is caught by the question overlap
 * instead, since "competitor pricing" and "otter fireflies granola" are not
 * the same string.
 */
export function topicFromQuestion(question: string): string {
  const words = [...contentWords(question)].slice(0, 3);
  if (words.length === 0) return clipChars(oneLine(question), TOPIC_MAX_CHARS);
  return words.join(" ");
}

/**
 * The idea inside a `research_hook` candidate (V2-011).
 *
 * `observer.md` asks for the question itself in `headline` ("What do Otter,
 * Fireflies and Granola charge per seat?", never "they should check competitor
 * pricing"), so no second model call is needed to turn one into an idea:
 * `whyNow` is already the one clause about why it matters, with the longer
 * `detail` as the fallback for a hook that left it empty.
 */
export function hookIdea(hook: {
  headline: string;
  detail: string;
  whyNow: string;
  evidenceTurnIds: string[];
}): Omit<ResearchIdea, "id"> {
  const question = clipChars(oneLine(hook.headline), QUESTION_MAX_CHARS);
  const why = oneLine(hook.whyNow) === "" ? hook.detail : hook.whyNow;
  return {
    topic: topicFromQuestion(question),
    question,
    why: clipWords(oneLine(why), WHY_MAX_WORDS),
    sourceTurnIds: [...hook.evidenceTurnIds],
  };
}
