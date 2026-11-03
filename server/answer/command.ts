/**
 * Final-turn command classification for V2-007. The model only chooses what
 * happens after silence; it is never on the latency-critical cancellation path.
 */
import { z } from "zod";
import type { ModelClient } from "../model/client.js";
import { loadPrompt, PROMPTS } from "../prompts/index.js";
import { detect } from "../wake.js";

/**
 * What a turn addressed to Sotto mid-contribution is asking for.
 *
 * V3-006 added the two that are about *how much* Sotto says rather than about
 * what it is saying now: `quieter` ("not now", "that's too much") and
 * `louder` ("you can jump in more"). They are classified here because this is
 * already the classifier an addressed turn reaches while Sotto is speaking or
 * has just spoken unasked — the two moments a group says either of them.
 */
export const commandKinds = ["stop", "new_question", "continue", "quieter", "louder"] as const;
export type CommandKind = (typeof commandKinds)[number];

/** Validate even strict model replies before allowing them to restart speech. */
export const CommandSchema = z.object({
  command: z.enum(commandKinds),
  question: z.string(),
});

/**
 * How long the command classifier may take before the lexical fallback
 * answers instead. The speech has already been cut off by then (V2-007's
 * barge-in runs on partials, with no model in the way); what is being
 * decided is only whether something *else* should happen — and a slow API
 * must not leave that hanging: measured 102 s on `2026-11-03_0915-mic`.
 */
export const COMMAND_TIMEOUT_MS = 6_000;

/** Uses the existing structured-output seam, so tests can remain entirely offline. */
export async function classifyCommand(model: ModelClient, text: string, signal?: AbortSignal) {
  const value = await model.structured({
    label: "voice_command",
    system: loadPrompt(PROMPTS.command),
    user: JSON.stringify({ turn: text }),
    schemaName: "voice_command",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["command", "question"],
      properties: {
        command: { type: "string", enum: [...commandKinds] },
        question: { type: "string" },
      },
    },
    reasoningEffort: "minimal",
    ...(signal === undefined ? {} : { signal }),
  });
  return CommandSchema.parse(value);
}

/**
 * What to do when the classifier could not answer in time: a question-shaped
 * turn (the wake rule, loosely) is a new question, anything else is "stop" —
 * the speech is already stopped, so that costs nothing more.
 */
export function fallbackCommand(text: string): z.infer<typeof CommandSchema> {
  const match = detect(text, { looseQuestions: true });
  return match.triggered
    ? { command: "new_question", question: match.question ?? "" }
    : { command: "stop", question: "" };
}
