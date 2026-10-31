/**
 * Final-turn command classification for V2-007. The model only chooses what
 * happens after silence; it is never on the latency-critical cancellation path.
 */
import { z } from "zod";
import type { ModelClient } from "../model/client.js";
import { loadPrompt, PROMPTS } from "../prompts/index.js";

/** Validate even strict model replies before allowing them to restart speech. */
export const CommandSchema = z.object({
  command: z.enum(["stop", "new_question", "continue"]),
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
        command: { type: "string", enum: ["stop", "new_question", "continue"] },
        question: { type: "string" },
      },
    },
  });
  return CommandSchema.parse(value);
}
