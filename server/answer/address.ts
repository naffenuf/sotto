/**
 * V2-008's final-turn address classifier. Live ASR drops punctuation, so intent
 * is judged by Spark with named conversation context; lexical detection stays
 * separate for immediate listening and barge-in.
 */
import { z } from "zod";
import type { SpeakerNames } from "../../shared/events.js";
import type { TurnUpdate } from "../../shared/turns.js";
import type { ModelClient } from "../model/client.js";
import { loadPrompt, PROMPTS } from "../prompts/index.js";

/** An empty request is unusable and must take the deterministic fallback path. */
export const AddressSchema = z.object({
  kind: z.enum(["request", "name_only", "mention"]),
  question: z.string().trim(),
}).refine((value) => value.kind === "request" ? value.question !== "" : value.question === "");

/** Named turns disambiguate an address split across two ASR turns. */
export interface AddressInput {
  turn: TurnUpdate;
  previous: readonly TurnUpdate[];
  speakers: SpeakerNames;
}

/** The watcher injects this seam so offline checks never construct an SDK client. */
export type AddressClassifier = (input: AddressInput, signal: AbortSignal) => Promise<unknown>;

/** Requests only a classification, leaving the actual answer to the answer agent. */
export async function classifyAddress(model: ModelClient, input: AddressInput, signal?: AbortSignal) {
  const named = (turn: TurnUpdate): string => {
    const speaker = turn.speaker === null ? "?" : input.speakers[turn.speaker] ?? turn.speaker;
    return `${speaker}: ${turn.text.trim()}`;
  };
  const value = await model.structured({
    label: "address",
    system: loadPrompt(PROMPTS.address),
    user: `Previous turns:\n${input.previous.map(named).join("\n") || "(none)"}` +
      `\n\nLATEST turn:\n${named(input.turn)}`,
    schemaName: "address",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "question"],
      properties: {
        kind: { type: "string", enum: ["request", "name_only", "mention"] },
        question: { type: "string" },
      },
    },
    reasoningEffort: "low",
    maxTokens: 2_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return AddressSchema.parse(value);
}
