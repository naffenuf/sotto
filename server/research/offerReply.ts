/**
 * V3-005's reply classifier: Sotto offered something, and somebody answered.
 *
 * The offer is a statement ("There's a quick rundown on competitors on screen
 * if you want it"), so the reply is whatever the next person happens to say —
 * "sure", "go on", "not now", or something about the conversation that has
 * nothing to do with the offer at all. Nothing lexical can tell the last two
 * apart reliably: "yeah, and the other thing is the deposit" is agreement
 * with somebody else, not with Sotto.
 *
 * Built like V3-014's follow-up classifier, and with the same bias. The whole
 * point of an offer is that nobody owes it a reply, so anything that is not
 * plainly a yes is treated as one of the group's own sentences and the offer
 * lapses in silence: a briefing nobody asked for is exactly the interruption
 * the statement form exists to avoid.
 */
import { z } from "zod";
import type { SpeakerNames } from "../../shared/events.js";
import type { TurnUpdate } from "../../shared/turns.js";
import type { ModelClient } from "../model/client.js";
import { loadPrompt, PROMPTS } from "../prompts/index.js";

/** What the turn after an offer makes of it. */
export const offerReplyKinds = ["yes", "no", "unrelated"] as const;

export type OfferReplyKind = (typeof offerReplyKinds)[number];

export const OfferReplySchema = z.object({ kind: z.enum(offerReplyKinds) });

export type OfferReplyResult = z.infer<typeof OfferReplySchema>;

/** The offer the reply is about, in the words the room heard. */
export interface OfferedFinding {
  /** Two or three words naming the subject. */
  topic: string;
  /** What the search found, as the card says it. */
  title: string;
  /** The sentence Sotto said out loud. */
  spokenText: string;
}

/** Named turns, because "go ahead, EJ" is not an answer to Sotto. */
export interface OfferReplyInput {
  turn: TurnUpdate;
  previous: readonly TurnUpdate[];
  speakers: SpeakerNames;
  offer: OfferedFinding;
}

/** The window injects this seam, so an offline check builds no SDK client. */
export type OfferReplyClassifier = (
  input: OfferReplyInput,
  signal: AbortSignal,
) => Promise<unknown>;

/** One verdict. The caller validates, as every model call in here does. */
export async function classifyOfferReply(
  model: ModelClient,
  input: OfferReplyInput,
  signal?: AbortSignal,
): Promise<OfferReplyResult> {
  const named = (turn: TurnUpdate): string => {
    const speaker = turn.speaker === null ? "?" : input.speakers[turn.speaker] ?? turn.speaker;
    return `${speaker}: ${turn.text.trim()}`;
  };
  const value = await model.structured({
    label: "offer-reply",
    system: loadPrompt(PROMPTS.offerReply),
    user:
      `Sotto has looked up: ${input.offer.topic} — ${input.offer.title}` +
      `\n\nSotto just said, unprompted: ${input.offer.spokenText}` +
      `\n\nPrevious turns:\n${input.previous.map(named).join("\n") || "(none)"}` +
      `\n\nLATEST turn:\n${named(input.turn)}`,
    schemaName: "offer_reply",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string", enum: [...offerReplyKinds] } },
    },
    reasoningEffort: "low",
    maxTokens: 2_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return OfferReplySchema.parse(value);
}
