/**
 * Final-turn command classification for V2-007. The model only chooses what
 * happens after silence; it is never on the latency-critical cancellation path.
 */
import { z } from "zod";
import type { ModelClient } from "../model/client.js";
import { loadPrompt, PROMPTS } from "../prompts/index.js";

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

/** Uses the existing structured-output seam, so tests can remain entirely offline. */
export async function classifyCommand(model: ModelClient, text: string) {
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
  });
  return CommandSchema.parse(value);
}
