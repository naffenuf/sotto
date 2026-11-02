/**
 * V3-014's follow-up classifier: once Sotto has answered, is the room still
 * talking to it?
 *
 * Built like V2-008's address classifier, and it is the call that path would
 * have made: inside the window a turn needs no wake word, so nothing lexical
 * can tell "and on Sunday?" addressed to Sotto from the same words addressed
 * to a colleague. The context is what decides it, so the classifier is given
 * Sotto's last answer as well as the recent turns.
 *
 * It replaces, rather than adds to, the call the turn would otherwise have
 * paid for: {@link QuestionWatcher} skips a turn in the window
 * (`inFollowUpWindow`) because the room is talking *to* Sotto rather than
 * wondering aloud, and the address watcher never sees an unnamed turn at all.
 * A turn that *does* say the name stays the address path's and is not
 * classified here — so a turn in the window costs exactly one call either
 * way.
 *
 * Three kinds, and only one of them does anything. The schema insists on the
 * same pairing the address schema does: a `to_sotto` with no question is not
 * a usable answer, and the caller treats an unusable answer the way it treats
 * a failure — close the window, say nothing.
 */
import { z } from "zod";
import type { SpeakerNames } from "../../shared/events.js";
import type { TurnUpdate } from "../../shared/turns.js";
import type { ModelClient } from "../model/client.js";
import { loadPrompt, PROMPTS } from "../prompts/index.js";

/** Who the latest turn is for, while the follow-up window is open. */
export const followUpKinds = ["to_sotto", "to_room", "closing"] as const;

export type FollowUpKind = (typeof followUpKinds)[number];

/** A `to_sotto` carries the follow-up; nothing else may. */
export const FollowUpSchema = z
  .object({
    kind: z.enum(followUpKinds),
    question: z.string().trim(),
  })
  .refine((value) => (value.kind === "to_sotto" ? value.question !== "" : value.question === ""), {
    message: "a question belongs to a to_sotto and nothing else",
  });

export type FollowUpResult = z.infer<typeof FollowUpSchema>;

/** What Sotto said last, which is the only thing a follow-up refers to. */
export interface LastAnswer {
  /** The question it answered. */
  question: string;
  /** The headline the stage shows. */
  headline: string;
  /** What Sotto said out loud, or `""` for a screen-only answer. */
  spokenText: string;
}

/** Named turns are what tells a follow-up from one colleague asking another. */
export interface FollowUpInput {
  turn: TurnUpdate;
  previous: readonly TurnUpdate[];
  speakers: SpeakerNames;
  answer: LastAnswer;
}

/** The watcher injects this seam so offline checks never construct an SDK client. */
export type FollowUpClassifier = (input: FollowUpInput, signal: AbortSignal) => Promise<unknown>;

/** Asks only who the turn is for; answering it is the answer agent's (US-018). */
export async function classifyFollowUp(
  model: ModelClient,
  input: FollowUpInput,
  signal?: AbortSignal,
): Promise<FollowUpResult> {
  const named = (turn: TurnUpdate): string => {
    const speaker = turn.speaker === null ? "?" : input.speakers[turn.speaker] ?? turn.speaker;
    return `${speaker}: ${turn.text.trim()}`;
  };
  const said = input.answer.spokenText.trim();
  const value = await model.structured({
    label: "followup",
    system: loadPrompt(PROMPTS.followUp),
    user:
      `Sotto was asked: ${input.answer.question}` +
      `\n\nSotto answered: ${said === "" ? input.answer.headline : said}` +
      `\n\nPrevious turns:\n${input.previous.map(named).join("\n") || "(none)"}` +
      `\n\nLATEST turn:\n${named(input.turn)}`,
    schemaName: "followup",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "question"],
      properties: {
        kind: { type: "string", enum: [...followUpKinds] },
        question: {
          type: "string",
          description:
            "For to_sotto: the follow-up rewritten so it stands on its own without the " +
            "conversation, in the speaker's own words where possible. Empty for every other " +
            "kind.",
        },
      },
    },
    reasoningEffort: "low",
    maxTokens: 2_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return FollowUpSchema.parse(value);
}
