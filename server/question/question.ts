/**
 * V3-002's final-turn question classifier.
 *
 * Built like V2-008's address classifier and deliberately *not* through the
 * observer: the observer looks once per board update, a median 12.6 s after
 * the turn that triggered it, and a question the room wondered aloud has to be
 * noticed while somebody could still be reaching for their phone. So this is
 * one `reasoning_effort: "low"` Spark call on the final turn, with the
 * previous four final turns and the names the group gave the speakers.
 *
 * The six kinds are the PRD's, and only one of them is work: an
 * `open_question` is something a lookup can answer, which becomes a research
 * idea at once (V3-003). The other five exist to say no — except `decision`,
 * which V3-013 reads for a *closing*: `closing: true` plus the decision in a
 * few words is what the read-back is said from, and it shares this call
 * rather than paying for a second one.
 */
import { z } from "zod";
import type { SpeakerNames } from "../../shared/events.js";
import type { TurnUpdate } from "../../shared/turns.js";
import type { ModelClient } from "../model/client.js";
import { loadPrompt, PROMPTS } from "../prompts/index.js";

/** What the latest turn is doing, in the room's terms rather than Sotto's. */
export const questionKinds = [
  "open_question",
  "to_group",
  "rhetorical",
  "decision",
  "answered",
  "none",
] as const;

export type QuestionKind = (typeof questionKinds)[number];

/**
 * One classification.
 *
 * `question` and `topic` belong to an `open_question` and nothing else: a
 * verdict that names something to look up while saying nobody can look it up
 * is not a usable answer, so the schema refuses it and the caller falls back
 * to `none`.
 *
 * `closing` and `decision` belong to a `decision` and nothing else, for the
 * same reason (V3-013): a read-back of something nobody settled is Sotto
 * putting words in the room's mouth.
 */
export const QuestionSchema = z
  .object({
    kind: z.enum(questionKinds),
    question: z.string().trim(),
    topic: z.string().trim(),
    /** V3-013: the group is settling this, not still weighing it. */
    closing: z.boolean().default(false),
    /** What was settled, in a few words, for the read-back to say. */
    decision: z.string().trim().default(""),
  })
  .refine(
    (value) =>
      value.kind === "open_question"
        ? value.question !== "" && value.topic !== ""
        : value.question === "" && value.topic === "",
    { message: "question and topic belong to an open_question only" },
  )
  .refine((value) => (value.closing ? value.kind === "decision" : true), {
    message: "only a decision can be closing",
  })
  .refine((value) => (value.decision !== "") === value.closing, {
    message: "a decision in a few words belongs to a closing decision only",
  });

export type QuestionResult = z.infer<typeof QuestionSchema>;

/** Named turns are what tells "who's handling food?" from a lookup. */
export interface QuestionInput {
  turn: TurnUpdate;
  previous: readonly TurnUpdate[];
  speakers: SpeakerNames;
}

/** The watcher injects this seam so offline checks never construct an SDK client. */
export type QuestionClassifier = (input: QuestionInput, signal: AbortSignal) => Promise<unknown>;

/**
 * An `open_question` the room asked itself, as the rest of the pipeline sees
 * it (V3-003's research idea, V3-015's reservation line, V3-004's answer).
 */
export interface OpenQuestion {
  /** The turn it was heard in, which is what cites it later. */
  turnId: string;
  /** Cleaned and standing on its own, which is the thing to look up. */
  question: string;
  /** Three to five words, for "I'll check the drive time". */
  topic: string;
  /** The name the group gave the speaker, the bare label, or `null`. */
  askedBy: string | null;
  /** Session clock when the turn went final. */
  askedAtMs: number;
}

/**
 * A decision the group just settled (V3-013), as the read-back sees it.
 *
 * It comes off the same call an `open_question` does — the classifier is
 * already reading the latest turn with four turns of context, and "OK, let's
 * go with six gardens" is a `decision` either way — so noticing a closing
 * costs nothing beyond one more field, and arrives with the turn rather than
 * with the board update a dozen seconds later.
 */
export interface DecisionClosing {
  /** The turn it was settled in, which the read-back's log cites. */
  turnId: string;
  /** What was settled, in a few words: "six gardens, Saturday". */
  decision: string;
  /** The name the group gave the speaker, the bare label, or `null`. */
  decidedBy: string | null;
  /** Session clock when the turn went final. */
  decidedAtMs: number;
}

/** Asks only what the turn is doing; looking the answer up is V3-003's. */
export async function classifyQuestion(
  model: ModelClient,
  input: QuestionInput,
  signal?: AbortSignal,
): Promise<QuestionResult> {
  const named = (turn: TurnUpdate): string => {
    const speaker = turn.speaker === null ? "?" : input.speakers[turn.speaker] ?? turn.speaker;
    return `${speaker}: ${turn.text.trim()}`;
  };
  const value = await model.structured({
    label: "question",
    system: loadPrompt(PROMPTS.question),
    user: `Previous turns:\n${input.previous.map(named).join("\n") || "(none)"}` +
      `\n\nLATEST turn:\n${named(input.turn)}`,
    schemaName: "question",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "question", "topic", "closing", "decision"],
      properties: {
        kind: { type: "string", enum: [...questionKinds] },
        question: {
          type: "string",
          description:
            "For open_question: the thing to look up, as one plain sentence that stands on its " +
            "own without the conversation. Empty for every other kind.",
        },
        topic: {
          type: "string",
          description:
            "For open_question: four to ten words naming exactly what is being checked, as the " +
            "object of \"I'll check …\" — \"the cheapest Sunday bus from New York to Philadelphia\", " +
            "never a bare label like \"New York Philadelphia buses\". Empty for every other kind.",
        },
        closing: {
          type: "boolean",
          description:
            "For decision only: true when this turn settles it rather than weighs it — \"OK, " +
            "let's go with six gardens\", \"so we're agreed on Saturday\", \"let's lock that " +
            "in\". False for a turn that is still asking which way to go, and for every other " +
            "kind.",
        },
        decision: {
          type: "string",
          description:
            "For a closing decision: what was settled, in a few words, as a note-taker would " +
            "write it down — \"six gardens, Saturday\". Empty otherwise.",
        },
      },
    },
    reasoningEffort: "minimal",
    maxTokens: 4_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return QuestionSchema.parse(value);
}
