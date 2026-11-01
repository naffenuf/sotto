/**
 * Is the room still waiting for the answer? (PRD V3-004.)
 *
 * The room wondered something aloud, Sotto claimed it (V3-015) and a search
 * came back twenty seconds later (V3-003). Twenty seconds is four or five
 * turns, and by then one of three things is true: the group is still on it,
 * somebody present has answered it themselves, or the conversation has moved
 * and the next pause is a pause in a different topic. Only the first of those
 * is worth saying out loud — re-raising a question the group has left behind
 * is exactly the interruption the pause rule exists to prevent.
 *
 * Built like V3-002's classifier: one `reasoning_effort: "low"` Spark call,
 * named turns, a strict schema. The thing that makes it affordable in a
 * *spoken* path is that it is never in the critical path — the verdict is
 * computed when the packet lands and again on every later final turn, and
 * {@link StillCurrentWatcher.verdict} reads the cache, so between "a pause
 * was detected" and the first audio there is no model call at all.
 *
 * A check that fails leaves the last verdict standing, or `current` when there
 * is none. The same rule the candidate gate follows for the same reason:
 * losing the check should cost judgment, not speech.
 */
import { z } from "zod";
import type { SpeakerNames } from "../../shared/events.js";
import { clipWords } from "../../shared/candidates.js";
import type { TurnUpdate } from "../../shared/turns.js";
import type { ModelClient } from "../model/client.js";
import { loadPrompt, PROMPTS } from "../prompts/index.js";

/** What the turns since the question say about saying the answer now. */
export const stillCurrentVerdicts = ["current", "answered", "moved_on"] as const;
export type StillCurrentVerdict = (typeof stillCurrentVerdicts)[number];

/** Words of the one-line reason, which is for the log rather than the room. */
export const STILL_CURRENT_WHY_MAX_WORDS = 15;

export const StillCurrentSchema = z.object({
  verdict: z.enum(stillCurrentVerdicts),
  /** Whether a person's own answer and the sourced one say the same thing. */
  agrees: z.boolean(),
  why: z.string().transform((text) => clipWords(text.replace(/\s+/g, " ").trim(), STILL_CURRENT_WHY_MAX_WORDS)),
});

export type StillCurrentResult = z.infer<typeof StillCurrentSchema>;

/**
 * What is waiting to be said: an answer to one of the room's own questions
 * (V3-004), one of Sotto's own corrections at boldness `bold` (V3-008), or a
 * decision about to be read back (V3-013).
 *
 * The three verdicts mean the same thing in each case — the group is still on
 * it, somebody present has already said it, or the conversation has moved —
 * but the three are *framed* differently to the model, because a correction's
 * "question" is a claim somebody made rather than something anybody asked,
 * and a decision's is something the room itself just settled.
 */
export const stillCurrentKinds = ["question", "correction", "decision"] as const;
export type StillCurrentKind = (typeof stillCurrentKinds)[number];

/** Everything one check is made from. */
export interface StillCurrentInput {
  /** Which of the two things is waiting; a question when nothing says. */
  kind?: StillCurrentKind;
  /**
   * The question the room wondered aloud, as the classifier cleaned it up —
   * or, for a `correction`, the claim in the room's own words.
   */
  question: string;
  /** The sourced answer, so `agrees` can be judged against something. */
  answer: string;
  /** Final turns since the question, oldest first. */
  since: readonly TurnUpdate[];
  speakers: SpeakerNames;
}

/** The watcher injects this seam, so an offline check constructs no SDK client. */
export type StillCurrentClassifier = (
  input: StillCurrentInput,
  signal: AbortSignal,
) => Promise<unknown>;

/** One check. The caller validates, as every model call in here does. */
export async function classifyStillCurrent(
  model: ModelClient,
  input: StillCurrentInput,
  signal?: AbortSignal,
): Promise<StillCurrentResult> {
  const named = (turn: TurnUpdate): string => {
    const speaker = turn.speaker === null ? "?" : input.speakers[turn.speaker] ?? turn.speaker;
    return `${speaker}: ${turn.text.trim()}`;
  };
  const value = await model.structured({
    label: "still-current",
    system: loadPrompt(PROMPTS.stillCurrent),
    user:
      (input.kind === "correction"
        ? `What somebody in the room said, which Sotto believes is wrong:\n${input.question}` +
          `\n\nThe correction Sotto is about to say:\n${input.answer}` +
          `\n\nEvery turn since it was said, oldest first:\n`
        : input.kind === "decision"
          ? `What the group just settled:\n${input.question}` +
            `\n\nThe read-back Sotto is about to say:\n${input.answer}` +
            `\n\nEvery turn since they settled it, oldest first:\n`
          : `The question somebody wondered aloud:\n${input.question}` +
            `\n\nWhat Sotto found:\n${input.answer}` +
            `\n\nEvery turn since the question, oldest first:\n`) +
      `${input.since.map(named).join("\n") || "(none — nobody has spoken since)"}`,
    schemaName: "still_current",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "agrees", "why"],
      properties: {
        verdict: { type: "string", enum: [...stillCurrentVerdicts] },
        agrees: {
          type: "boolean",
          description:
            "For answered: true when the sourced answer and the person's own answer say the " +
            "same thing within rounding. False for current and moved_on.",
        },
        why: {
          type: "string",
          description:
            `At most ${STILL_CURRENT_WHY_MAX_WORDS} words naming what in the conversation ` +
            `decided it. For the log, not for the room.`,
        },
      },
    },
    reasoningEffort: "low",
    maxTokens: 2_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return StillCurrentSchema.parse(value);
}
