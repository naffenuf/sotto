/**
 * What Sotto decides to look up, and why (PRD V2-012).
 *
 * A **research idea** is one checkable question worth putting to a web
 * search. Three things produce them: a `research_hook` candidate, which is the
 * observer noticing that outside information would settle something
 * (V2-011), the planner, which reads the board every couple of minutes
 * and proposes a couple of its own, and a question the room wondered aloud
 * (V3-002). All three arrive here as the same shape and are
 * deduplicated against everything the session has already thought of; the
 * first two are then scored by the **gate** — Muse Glimmer on this Mac,
 * falling back to Muse Spark (V2-010) — on the three questions that decide
 * whether looking it up is worth anything: is it useful to this group now, is
 * it something they do not already know, and can a search actually answer it.
 *
 * An `open_question` skips the gate (V3-003). The classifier that heard it has
 * already judged it answerable by a lookup and asked by the room rather than
 * of Sotto, so a second judgment on the same question would buy nothing and
 * cost the only thing the answer has, which is arriving while it still
 * matters. It still spends the budget: a search is a search.
 *
 * Noticing is cheap, searching is not, so the gate is deliberately a filter
 * rather than a ranking: everything it sees is written to `research.jsonl`,
 * and only the ideas above {@link RESEARCH_GATE_THRESHOLD} are queued for the
 * runner (V2-013), which the budget then starts at most a few of.
 *
 * What the runner makes of an idea is a {@link ResearchPacket} — a title, a
 * teaser, a few key points and, above all, **sources**: a packet with none is
 * thrown away, because a finding nobody can check is worse than silence.
 */
import { z } from "zod";
import type { Artifact } from "./artifacts.js";
import type { Citation } from "./cards.js";
import { clipChars, clipWords } from "./candidates.js";
import { DEFAULT_FREQUENCY, FREQUENCY_LIMITS } from "./policy.js";

/**
 * Where an idea came from. Recorded, because they differ in quality — and, in
 * one case, in route: an `open_question` is something the room wondered aloud
 * (V3-002), and it skips the gate entirely (V3-003), because the classifier
 * has already judged it answerable and asked by the group.
 */
export const researchOrigins = ["hook", "planner", "open_question"] as const;
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
  /**
   * When the room asked it, on the session clock — an `open_question` only
   * (V3-003).
   *
   * The one piece of history an idea carries, and it is here rather than on
   * the log record because the thing being measured spans the whole fast
   * path: `questionToPacketMs` is the turn going final to the packet being
   * ready, and the runner is what knows the second half of that.
   */
  askedAtMs?: number;
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

/** One line of `research.jsonl`: a job the budget let start; the runner runs it. */
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

/**
 * The idea inside a question the room wondered aloud (V3-002, V3-003).
 *
 * Cheaper than a hook's, because the classifier already returned both halves:
 * `question` is the thing to look up, cleaned and standing on its own, and
 * `topic` is the three-to-five words "I'll check the drive time" is built from
 * (V3-015). All this adds is the `why`, which is written locally — nobody
 * needs a model call to say that the room asked and nobody knew.
 */
export function questionIdea(asked: {
  turnId: string;
  question: string;
  topic: string;
  askedBy: string | null;
  askedAtMs: number;
}): Omit<ResearchIdea, "id"> {
  const question = clipChars(oneLine(asked.question), QUESTION_MAX_CHARS);
  const topic = clipChars(oneLine(asked.topic), TOPIC_MAX_CHARS);
  return {
    topic: topic === "" ? topicFromQuestion(question) : topic,
    question,
    why: clipWords(
      `${asked.askedBy ?? "Somebody"} wondered this aloud and nobody in the room knew.`,
      WHY_MAX_WORDS,
    ),
    sourceTurnIds: [asked.turnId],
    askedAtMs: asked.askedAtMs,
  };
}

/* ------------------------------------------------------------------ *
 * The packet (V2-013): what one search came back with.
 * ------------------------------------------------------------------ */

/** Characters of title. It names the finding on a card, in a glance. */
export const PACKET_TITLE_MAX_CHARS = 80;

/** Words of teaser. The PRD's "one or two sentences", as a number. */
export const PACKET_TEASER_MAX_WORDS = 40;

/** Words of one key point. A finding, not a paragraph about it. */
export const KEY_POINT_MAX_WORDS = 30;

/** Key points one packet may carry. */
export const MAX_KEY_POINTS = 5;

/** Sources one packet may carry. One good page beats five weak ones. */
export const MAX_PACKET_SOURCES = 5;

/**
 * Words of {@link ResearchPacket.spokenAnswer}. The PRD's "one or two
 * sentences", as a number, and said out loud rather than read: the same
 * allowance as the teaser, because a sentence is a sentence.
 */
export const PACKET_SPOKEN_MAX_WORDS = 40;

/**
 * One finished piece of background research.
 *
 * Exactly the PRD's fields. `sources` is the load-bearing one: a packet that
 * resolved none of the pages it claimed to read is discarded rather than
 * shown (see {@link ResearchPacketRecord}'s `unsourced`), because a research
 * card is a claim about the world and the group has to be able to follow it
 * back.
 */
export interface ResearchPacket {
  /** Unique within the session: `packet-1`, `packet-2`, … */
  id: string;
  /** The {@link ResearchIdea} it answers. */
  ideaId: string;
  /** What the finding is called, on a card and in `research/<id>.md`. */
  title: string;
  /** One or two sentences: what the search found, as the card's one line. */
  teaser: string;
  /** The findings themselves, best first. */
  keyPoints: string[];
  /**
   * One or two sentences answering the question out loud (V3-003).
   *
   * Not the teaser: the teaser is read off a screen in a glance, and this is
   * heard once, so it rounds its numbers, carries no URLs and no list, and
   * says the answer first. It is what V3-004 speaks to the room when the room
   * is the thing that asked.
   *
   * Absent when the model left it blank — and never present on a packet with
   * no sources, because a packet with no sources is discarded before it
   * exists.
   */
  spokenAnswer?: string;
  /** Pages the search really returned, resolved the way a verdict's are. */
  sources: Citation[];
  /**
   * HTML the model drew for this finding, when a table or a diagram said it
   * better than a list (US-020's `show_html`).
   *
   * The PRD's `{ title, path }` plus the URL it is served from, which is what
   * a card needs to put it in a frame (V2-014).
   */
  visual?: Artifact;
  /** When it was finished, on the session clock. */
  createdAtMs: number;
  /** Real milliseconds the search took: a model call is wall-clock work. */
  latencyMs: number;
}

/** Collapses whitespace and drops the blanks: every line of a packet is one line. */
function lines(list: readonly string[], maxWords: number, limit: number): string[] {
  const kept: string[] = [];
  for (const raw of list) {
    const text = clipWords(oneLine(raw), maxWords);
    if (text !== "" && !kept.includes(text)) kept.push(text);
    if (kept.length >= limit) break;
  }
  return kept;
}

/**
 * One packet as the model returns it, with the stated limits applied.
 *
 * `sources` stays `unknown[]`: every URL has to be resolved against the pages
 * the search actually returned before it can be shown to anybody (the same
 * rule a verification's citations follow), and one unreadable entry must not
 * throw away the good ones beside it.
 */
export const PacketReplySchema = z.strictObject({
  title: z
    .string()
    .transform((text) => clipChars(oneLine(text), PACKET_TITLE_MAX_CHARS))
    .refine((text) => text !== "", { message: "title is empty" }),
  teaser: z
    .string()
    .transform((text) => clipWords(oneLine(text), PACKET_TEASER_MAX_WORDS))
    .refine((text) => text !== "", { message: "teaser is empty" }),
  keyPoints: z
    .array(z.string())
    .transform((list) => lines(list, KEY_POINT_MAX_WORDS, MAX_KEY_POINTS)),
  // Deliberately tolerant: a search that came back with a title, a teaser and
  // five findings is a good packet whether or not the model also wrote the
  // spoken line, and losing it over a missing field would be the worse trade.
  spokenAnswer: z
    .string()
    .optional()
    .transform((text) => clipWords(oneLine(text ?? ""), PACKET_SPOKEN_MAX_WORDS)),
  sources: z.array(z.unknown()),
});
export type PacketReply = z.infer<typeof PacketReplySchema>;

/** The `json_schema.name` a packet request sends. */
export const RESEARCH_PACKET_SCHEMA_NAME = "research_packet";

/**
 * {@link PacketReplySchema} as a JSON Schema, in the subset strict structured
 * output accepts. Muse Spark reads these descriptions — measured, so they are
 * part of the prompt — and the limits they state are enforced after the fact
 * by the zod schema above; `shared/research.test.ts` holds the two in
 * agreement.
 */
export const researchPacketJsonSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description:
        `What the finding is called, in at most ${PACKET_TITLE_MAX_CHARS} characters. ` +
        `Name the answer, not the search: "Otter and Fireflies charge $8-19 a seat", not "Competitor pricing research".`,
    },
    teaser: {
      type: "string",
      description:
        `One or two sentences — at most ${PACKET_TEASER_MAX_WORDS} words — saying what you found. ` +
        `It is the only line somebody reads before deciding whether to open the rest.`,
    },
    keyPoints: {
      type: "array",
      description:
        `The findings themselves, best first: at most ${MAX_KEY_POINTS}, each at most ` +
        `${KEY_POINT_MAX_WORDS} words. Numbers, names, dates, rules — never advice.`,
      items: { type: "string" },
    },
    spokenAnswer: {
      type: "string",
      description:
        `One or two sentences — at most ${PACKET_SPOKEN_MAX_WORDS} words — answering the ` +
        `question out loud, to be heard rather than read: the answer first, numbers rounded ` +
        `the way a person would say them, no URLs, no list, no "according to".`,
    },
    sources: {
      type: "array",
      description:
        `The pages you actually read, best first: at most ${MAX_PACKET_SOURCES}. ` +
        `At least one — a finding with no source is thrown away unread.`,
      items: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The full URL exactly as the search gave it to you, path and query included. Never a URL that was not in your search results.",
          },
          title: { type: "string", description: "The page's own title." },
        },
        required: ["url", "title"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "teaser", "keyPoints", "spokenAnswer", "sources"],
  additionalProperties: false,
} as const;

/**
 * What became of one research job.
 *
 * - `ready`: a sourced packet, written to `research/<id>.json` and `.md`.
 * - `unsourced`: it came back with nothing the search had really returned, so
 *   it was discarded. The PRD asks for this to be logged by name.
 * - `failed`: the call did not come back, or its reply did not fit.
 */
export const researchPacketOutcomes = ["ready", "unsourced", "failed"] as const;
export type ResearchPacketOutcome = (typeof researchPacketOutcomes)[number];

/** One line of `research.jsonl`: what a job came back with (V2-013). */
export interface ResearchPacketRecord {
  kind: "packet";
  /** When the job finished, on the session clock. */
  atMs: number;
  ideaId: string;
  /** The question it was answering, so the file reads on its own. */
  question: string;
  outcome: ResearchPacketOutcome;
  /** The packet itself, when there is one. */
  packet?: ResearchPacket;
  /** What an `unsourced` packet would have been called. */
  title?: string;
  /** Real milliseconds the job took. */
  latencyMs: number;
  /**
   * The fast path's end-to-end latency (V3-003): the question turn going
   * final to this job finishing, on the **session** clock.
   *
   * Absent for a hook's or the planner's idea, which nobody asked for out
   * loud. It reads near zero in a `max`-speed replay, where simulated time
   * stands still inside a tracked model call — `npm run e2e` is the clock
   * that charges for a search, and the one the PRD's 25-second target is
   * measured on.
   */
  questionToPacketMs?: number;
  /** Whether the model searched at all, as the API reported it. */
  searched: boolean;
  /** Why there is no packet, when there is none. */
  error?: string;
}

/**
 * One line of `research.jsonl`: the card a question put up while it searched
 * (V3-003).
 *
 * The room wondered something aloud, so a card goes on the stage *at once*,
 * carrying the question and a thinking indicator, and the packet fills it in
 * twenty seconds later. This is the line that says when the group first saw
 * Sotto working, which is the only moment in the fast path no other record
 * holds.
 */
export interface ResearchPendingRecord {
  kind: "pending";
  /** When the card went up, on the session clock. */
  atMs: number;
  ideaId: string;
  /** The card it went up as, which the packet's own `card` line repeats. */
  cardId: string;
  question: string;
  /** The packet an earlier identical question had already found, when there is one. */
  reusedPacketId?: string;
}

/** One line of `research.jsonl`: a packet that reached the stage (V2-014). */
export interface ResearchCardRecord {
  kind: "card";
  /** When the card went out, on the session clock. */
  atMs: number;
  packetId: string;
  ideaId: string;
  /**
   * The card's own id.
   *
   * Usually {@link researchCardId} of `packetId` and derivable from it, but
   * not for a question's packet: that card went up as
   * {@link researchQuestionCardId} before the packet existed (V3-003), and
   * filling it in has to keep the id the stage already has. So readers take
   * it from here rather than deriving it.
   */
  cardId?: string;
  /** The packet's own title, so the file reads without the packet beside it. */
  title: string;
  /** How long it waited for a pause and a budget slot. */
  heldForMs: number;
  /** Packets still waiting behind it. */
  waiting: number;
  /** Cards shown in the last {@link RESEARCH_CARD_WINDOW_MS}, including this one. */
  shownInWindow: number;
  /** True when the conversation ended and the card went out anyway. */
  atSessionEnd?: boolean;
  /**
   * True when this push filled in a card that was already on the stage with a
   * thinking indicator (V3-003).
   *
   * Like {@link broughtForward} it is not an unsolicited card: the room asked
   * the question, the card is already there, and nothing new interrupts
   * anybody — so it waits for no pause and spends no budget.
   */
  filledIn?: true;
  /**
   * True when somebody asked for this research and the card was brought to
   * the top of the stage, open, while Sotto briefed them on it (V2-015).
   *
   * A packet that was already on the stage gets a second `card` line this way
   * — the first says when it appeared, this one says when it was asked for.
   */
  broughtForward?: true;
}

/** Every kind of line `research.jsonl` holds. */
export type ResearchLogLine =
  | ResearchIdeaRecord
  | ResearchGateRecord
  | ResearchStartRecord
  | ResearchPacketRecord
  | ResearchPendingRecord
  | ResearchCardRecord;

/**
 * A packet id the server itself would have handed out, and nothing else.
 *
 * The id becomes a file name in `research/`, so this is a gate rather than a
 * description — the same rule `ARTIFACT_FILE_PATTERN` is for generated
 * HTML.
 */
export const PACKET_ID_PATTERN = /^packet-[0-9]+$/;

/** `research/packet-1.json`, relative to the session folder. */
export function packetFileName(id: string, extension: "json" | "md"): string {
  return `${id}.${extension}`;
}

/**
 * One packet as `research/<id>.md`: the thing a person reads.
 *
 * The question goes in because the file is read without the log beside it,
 * and the sources go in as links because that is the whole point of a packet.
 */
export function renderPacketMarkdown(packet: ResearchPacket, question: string): string {
  const blocks = [`# ${packet.title}`, `_${question}_`, packet.teaser];
  if (packet.keyPoints.length > 0) {
    blocks.push(packet.keyPoints.map((point) => `- ${point}`).join("\n"));
  }
  if (packet.visual !== undefined) {
    blocks.push("## Visual", `${packet.visual.title} — \`${packet.visual.path}\``);
  }
  blocks.push(
    "## Sources",
    packet.sources.map((source) => `- [${source.title}](${source.url})`).join("\n"),
  );
  return `${blocks.join("\n\n")}\n`;
}

/* ------------------------------------------------------------------ *
 * The card (V2-014): how a finished packet reaches the room.
 * ------------------------------------------------------------------ */

/** Prefix of a research card's id, so a log line says what it refers to. */
export const RESEARCH_CARD_ID_PREFIX = "research-";

/**
 * The id the card for one packet gets.
 *
 * Derived from the packet rather than counted, exactly as a delivered
 * interjection's is, so pushing the same packet twice replaces its card
 * instead of stacking a second copy — and deliberately *not* under
 * `CARD_ID_PREFIX`: a research card is not a decision the policy took, so
 * `POST /api/feedback` must never find a candidate behind it.
 */
export function researchCardId(packetId: string): string {
  return `${RESEARCH_CARD_ID_PREFIX}${packetId}`;
}

/**
 * The id the card for one *question* gets, from the moment the question is
 * accepted (V3-003).
 *
 * Keyed on the idea rather than on the packet because there is no packet yet:
 * the card goes up with a thinking indicator while the search runs, and the
 * packet fills in the card the stage already has. Still under
 * {@link RESEARCH_CARD_ID_PREFIX}, so `POST /api/feedback` can no more find a
 * candidate behind this one than behind any other research card.
 */
export function researchQuestionCardId(ideaId: string): string {
  return `${RESEARCH_CARD_ID_PREFIX}${ideaId}`;
}

/** What a research card is called on the stage, in the PRD's own words. */
export const RESEARCH_CARD_PREFIX = "Research ready:";

/** The card's one line: the prefix and the packet's title. */
export function researchCardHeadline(title: string): string {
  return `${RESEARCH_CARD_PREFIX} ${title}`;
}

/** What the card says while the search is still running (V3-003). */
export const RESEARCH_LOOKING_PREFIX = "Looking up:";

/**
 * The thinking card's one line: the prefix and the question itself.
 *
 * The question rather than the topic, because this is the only thing on the
 * stage that says what Sotto thought it heard — a room that reads "Looking up:
 * how long the drive to the farmhouse takes" knows at a glance both that it
 * was heard and that it was heard right.
 */
export function researchLookingHeadline(question: string): string {
  return `${RESEARCH_LOOKING_PREFIX} ${oneLine(question)}`;
}

/** What the card says when the search came back with nothing showable (V3-003). */
export const RESEARCH_NO_ANSWER = "Nothing solid on this one.";

/**
 * How long after one research card the next one waits, at the default
 * frequency.
 *
 * Its own budget, separate from the interjection one (whose cooldown at
 * `normal` is three minutes) and deliberately shorter, because the two cost
 * the group different things: an interjection asks for the floor, while a
 * research card is a line that appears on a screen nobody has to look at. A
 * minute is long enough that two searches finishing together do not land in
 * the same pause, which is the only way a quiet card is loud.
 *
 * V2-017 made both numbers a frequency setting's: this is the `normal` row of
 * {@link FREQUENCY_LIMITS}, which is what {@link ResearchCards} falls back to
 * when nobody passes it limits.
 */
export const RESEARCH_CARD_COOLDOWN_MS =
  FREQUENCY_LIMITS[DEFAULT_FREQUENCY].researchCardCooldownMs;

/** The window the research card budget is counted over. */
export const RESEARCH_CARD_WINDOW_MS = 15 * 60_000;

/**
 * How many research cards that window allows.
 *
 * The search budget already caps packets at {@link MAX_JOBS_PER_WINDOW} per
 * {@link RESEARCH_WINDOW_MS}, so this is the backstop rather than the brake:
 * it is what stops a long conversation turning into a feed.
 */
export const MAX_RESEARCH_CARDS_PER_WINDOW =
  FREQUENCY_LIMITS[DEFAULT_FREQUENCY].maxResearchCardsPerWindow;

/* ------------------------------------------------------------------ *
 * The briefing (V2-015): what happens when somebody asks for it.
 * ------------------------------------------------------------------ */

/**
 * How many packets one briefing is built from.
 *
 * "What did you find?" with four packets ready is not a request for four
 * reports; it is a request for the ones that answer it. Three, because the
 * search budget caps a window at {@link MAX_JOBS_PER_WINDOW} anyway, so this
 * only bites when a long conversation has searched several times and somebody
 * asks a question that matches all of it.
 */
export const MAX_BRIEFING_PACKETS = 3;

/**
 * The ways a question asks for research that has already been done.
 *
 * Matched on words rather than judged by a model, for the same reason the
 * dedupe is: a question somebody asked out loud is waiting for an answer, and
 * a classification call before the answering one is a second and a half of
 * silence to learn something the phrasing already says. Guessing wrong in
 * either direction is cheap — the packets are in the model's context for
 * *every* question, so a missed match costs the card coming forward and the
 * opener, not the findings.
 */
const ASKS_FOR_RESEARCH: readonly RegExp[] = [
  /\bwhat did you (?:find|learn|get|turn up|dig up)\b/i,
  /\bwhat (?:have|'ve) you (?:found|got|learned|turned up|dug up)\b/i,
  /\bwhat you found\b/i,
  /\bdid you (?:find|look|dig|search|check)\b/i,
  /\b(?:that|the|those|your|any) research\b/i,
  /\b(?:you|sotto) (?:looked|researched|searched)\b/i,
  /\bresearch (?:you|sotto) (?:did|ran)\b/i,
  /\b(?:tell|brief|fill) (?:us|me) (?:in|about|on)\b/i,
  /\b(?:show|read) (?:us|me|it|them)\b/i,
  /\bwhat do you have\b/i,
  /\banything (?:on|about)\b/i,
  /\bwhat'?s? the (?:verdict|answer) (?:on|about)\b/i,
];

/** Whether this question is asking for research Sotto has already done. */
export function asksForResearch(question: string): boolean {
  return ASKS_FOR_RESEARCH.some((pattern) => pattern.test(question));
}

/**
 * The words of a request that are about *the subject* rather than about the
 * asking: "what did you find on competitors" is a question about competitors.
 *
 * The filler has to go, or every question would match every packet on the
 * word "find". What is left is matched on stems, because "competitors" in a
 * question and "competitor" in a title are the same word.
 */
const ASKING_WORDS = new Set([
  "find", "found", "finding", "findings", "research", "researched", "look", "looked", "looking",
  "search", "searched", "dig", "dug", "turn", "turned", "learn", "learned", "tell", "brief",
  "show", "read", "say", "give", "get", "got", "us", "me", "them", "it", "those", "verdict",
  "answer", "sotto", "up", "anything", "something", "everything", "please", "again",
]);

/** A word as the briefing match compares it: lowercase, singular enough. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function stems(text: string): Set<string> {
  const kept = new Set<string>();
  for (const word of contentWords(text)) {
    if (ASKING_WORDS.has(word)) continue;
    kept.add(stem(word));
  }
  return kept;
}

/**
 * How much of what the question is about this packet covers: 0 when they
 * share no subject word, 1 when the packet covers all of it.
 *
 * Coverage of the *question*, not overlap of the two, because a packet is
 * several sentences long and a question is a handful of words: Jaccard would
 * score every packet near zero.
 */
export function packetRelevance(
  question: string,
  packet: Pick<ResearchPacket, "title" | "teaser" | "keyPoints">,
): number {
  const asked = stems(question);
  if (asked.size === 0) return 0;
  const about = stems([packet.title, packet.teaser, ...packet.keyPoints].join(" "));
  let shared = 0;
  for (const word of asked) if (about.has(word)) shared += 1;
  return shared / asked.size;
}

/**
 * The packets one question should be briefed from, best first — empty when it
 * is not asking for research at all.
 *
 * A question that names its subject ("what did you find on competitors?")
 * gets the packets about that subject. One that does not ("what did you
 * find?") gets the most recent ones, because that is what it is asking for:
 * the answer is still built by the model from the packets in its context, so
 * this decides which cards come forward and what the record says the answer
 * rested on.
 */
export function packetsForBriefing(
  question: string,
  packets: readonly ResearchPacket[],
): readonly ResearchPacket[] {
  if (packets.length === 0 || !asksForResearch(question)) return [];
  const scored = packets
    .map((packet, index) => ({ packet, index, score: packetRelevance(question, packet) }))
    .filter((entry) => entry.score > 0)
    // Best first, and the newer one first where they tie: a search that
    // finished a minute ago is more likely to be the one being asked about.
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const chosen = scored.length > 0 ? scored.map((entry) => entry.packet) : [...packets].reverse();
  return chosen.slice(0, MAX_BRIEFING_PACKETS);
}

/**
 * The first thing Sotto says when the findings are already in hand.
 *
 * It takes the place of both the acknowledgment and the holding line
 * (V2-008c): those exist to cover the ten to twenty seconds a search needs,
 * and there is no search here. Written locally rather than by a model for the
 * same reason — a call to write one sentence would be the only wait left.
 *
 * Deliberately says nothing about *what* was found: the model's own first
 * sentence is a beat behind this one, it is told this was said, and two
 * versions of the same finding is the one thing worse than a beat of silence.
 */
export const BRIEFING_OPENER = "Yes, I looked into that.";

/** The same, when the question matched more than one piece of research. */
export const BRIEFING_OPENER_MANY = "Yes, I looked into a couple of those.";

export function briefingOpener(packets: readonly ResearchPacket[]): string {
  return packets.length > 1 ? BRIEFING_OPENER_MANY : BRIEFING_OPENER;
}

/**
 * The packets as the answering model is given them (V2-015): a title, what
 * the search found, the key points and the pages they came from.
 *
 * The sources are in here as full URLs on purpose. They are the one part of a
 * packet the model has to be able to reproduce — a briefing whose pages the
 * group cannot open is exactly the thing V2-013 throws packets away over —
 * and they are already resolved against a real search, so copying one out is
 * not a page anybody invented.
 */
export function renderPacketsForAnswer(packets: readonly ResearchPacket[]): string {
  return packets
    .map((packet) => {
      const blocks = [`### ${packet.id} — ${packet.title}`, packet.teaser];
      if (packet.keyPoints.length > 0) {
        blocks.push(packet.keyPoints.map((point) => `- ${point}`).join("\n"));
      }
      if (packet.visual !== undefined) {
        blocks.push(`A visual is on the group's screen with this: ${packet.visual.title}`);
      }
      blocks.push(
        "Sources:",
        packet.sources.map((source) => `- ${source.title} - ${source.url}`).join("\n"),
      );
      return blocks.join("\n\n");
    })
    .join("\n\n");
}

/** Every page any of these packets rests on, in order, without repeats. */
export function packetSourceUrls(packets: readonly ResearchPacket[]): string[] {
  const urls: string[] = [];
  for (const packet of packets) {
    for (const source of packet.sources) {
      if (!urls.includes(source.url)) urls.push(source.url);
    }
  }
  return urls;
}
