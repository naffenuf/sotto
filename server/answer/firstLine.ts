/**
 * The sentence Sotto says while it searches (V2-008c).
 *
 * A searched answer takes eight to thirteen seconds to write, of which only
 * about two and a half is the search itself — the rest is reasoning and
 * writing. Measured, that is how long the room sits in silence after "Let me
 * check.", which is long enough that somebody asks the question again.
 *
 * So a second, much cheaper call writes **one orienting sentence** from the
 * conversation alone: no tools, low reasoning, a short budget. It is spoken
 * while the searched answer is still being written, and the searched answer is
 * told what it was so that it carries straight on from it.
 *
 * The one thing that would make this worse than silence is a guess. The line
 * is written before anything has been looked up, so the prompt forbids every
 * kind of specific — figures, dates, prices, quotes — and an empty `line` is a
 * perfectly good reply meaning "nothing worth saying without the facts".
 */
import { z } from "zod";
import type { ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";

/** The label this call is tracked under, in the model logs and the usage. */
export const FIRST_LINE_LABEL = "first_line";

/**
 * Words of holding line. Two sentences of speech — long enough to orient the
 * room, short enough that the searched answer is not kept waiting behind it.
 */
export const FIRST_LINE_MAX_WORDS = 14;

/**
 * Reasoning + output budget. Generous against a measured 150–210 reasoning
 * tokens on a trivial prompt (`CLAUDE.md`) and a reply of one sentence, but
 * nowhere near an answer's: this call is on the room's critical path.
 */
export const FIRST_LINE_MAX_TOKENS = 2_000;

/** Words in a line, for the one limit this call has. */
function countWords(text: string): number {
  return text === "" ? 0 : text.split(" ").length;
}

/**
 * `text`, cut to `max` words — by whole sentences where it can be.
 *
 * Unlike the observer's `clipWords`, this is going to be *said*, so it keeps
 * no ellipsis and leaves no half sentence hanging: whole sentences are taken
 * while they fit, and a single sentence longer than the whole budget is cut at
 * a word and closed with a full stop.
 */
export function clipSpokenLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (countWords(line) <= max) return line;
  const kept: string[] = [];
  let words = 0;
  for (const sentence of line.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []) {
    const piece = sentence.trim();
    const count = countWords(piece);
    if (kept.length > 0 && words + count > max) break;
    kept.push(piece);
    words += count;
    if (words >= max) break;
  }
  const joined = kept.join(" ");
  if (countWords(joined) <= max) return joined;
  const cut = joined.split(" ").slice(0, max).join(" ").replace(/[\s,;:—-]+$/, "");
  return /[.!?]$/.test(cut) ? cut : `${cut}.`;
}

/**
 * The reply, clipped rather than rejected — the same rule the observer's
 * candidates follow. A line two words over the limit is still a good line, and
 * throwing it away would put the silence back.
 */
export const FirstLineSchema = z.object({
  line: z.string().transform((text) => clipSpokenLine(text, FIRST_LINE_MAX_WORDS)),
});

/** The strict schema for the reply; see `shared/board.ts` on why it is by hand. */
const firstLineJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["line"],
  properties: {
    line: {
      type: "string",
      description:
        "One short spoken sentence, at most twelve words, saying where you are going and what for" +
        " the answer up. No figures, dates, prices, quotes or any claim that depends on the" +
        " search. Empty string if there is nothing worth saying.",
    },
  },
} as const;

/**
 * Writes the holding line for one question, or `""` when there is none worth
 * saying. `user` is the rendered context — the board, the conversation and the
 * question — built by {@link renderFirstLineRequest}.
 */
export async function writeFirstLine(
  model: ModelClient,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const value = await model.structured({
    label: FIRST_LINE_LABEL,
    system: loadPrompt(PROMPTS.firstLine),
    user,
    schemaName: FIRST_LINE_LABEL,
    schema: firstLineJsonSchema,
    reasoningEffort: "low",
    maxTokens: FIRST_LINE_MAX_TOKENS,
    ...(signal === undefined ? {} : { signal }),
  });
  return FirstLineSchema.parse(value).line;
}
