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
 * idea at once (V3-003). The other five exist to say no — and `decision` is
 * also what V3-013 reads for a closing decision, which is why the pair share
 * this call rather than paying for two.
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
 */
export const QuestionSchema = z
  .object({
    kind: z.enum(questionKinds),
    question: z.string().trim(),
    topic: z.string().trim(),
  })
  .refine(
    (value) =>
      value.kind === "open_question"
        ? value.question !== "" && value.topic !== ""
        : value.question === "" && value.topic === "",
    { message: "question and topic belong to an open_question only" },
  );

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
      required: ["kind", "question", "topic"],
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
            "For open_question: three to five words naming it, as in \"I'll check the drive " +
            "time\". Empty for every other kind.",
        },
      },
    },
    reasoningEffort: "low",
    maxTokens: 2_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return QuestionSchema.parse(value);
}
