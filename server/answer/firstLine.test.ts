/**
 * V2-008c: the holding line is clipped, never rejected — the same rule the
 * observer's candidates follow. A line two words over the limit is still a
 * good line, and dropping it would put the silence back.
 */
import { expect, it } from "vitest";
import type { ModelClient, StructuredCall } from "../model/client.js";
import {
  FIRST_LINE_LABEL,
  FIRST_LINE_MAX_TOKENS,
  FIRST_LINE_MAX_WORDS,
  FirstLineSchema,
  writeFirstLine,
} from "./firstLine.js";

/** A model that answers one structured call with whatever it is given. */
function model(value: unknown): { client: ModelClient; calls: StructuredCall[] } {
  const calls: StructuredCall[] = [];
  return {
    calls,
    client: {
      structured: async (call) => {
        calls.push(call);
        return value;
      },
      grounded: async () => {
        throw new Error("a holding line is never searched for");
      },
      prose: async () => {
        throw new Error("a holding line is JSON, not prose");
      },
    },
  };
}

it("asks for one cheap, untooled reply", async () => {
  const { client, calls } = model({ line: "Let me pull the specifics." });
  await expect(writeFirstLine(client, "## The group's board\n\n_empty_")).resolves.toBe(
    "Let me pull the specifics.",
  );
  expect(calls[0]).toMatchObject({
    label: FIRST_LINE_LABEL,
    reasoningEffort: "minimal",
    maxTokens: FIRST_LINE_MAX_TOKENS,
  });
  expect(calls[0]?.user).toContain("The group's board");
  // Structured, so there are no tools and nothing is searched.
  expect(calls[0]?.schema).toMatchObject({ additionalProperties: false, required: ["line"] });
});

it("passes the abort signal on, so an answer that gets there first stops it", async () => {
  const { client, calls } = model({ line: "Let me check the numbers." });
  const controller = new AbortController();
  await writeFirstLine(client, "context", controller.signal);
  expect(calls[0]?.signal).toBe(controller.signal);
});

it("keeps whole sentences when the line runs long", () => {
  const sentence = `${Array.from({ length: 6 }, (_, at) => `word${at}`).join(" ")}.`;
  const { line } = FirstLineSchema.parse({ line: `${sentence} ${sentence} ${sentence}` });
  // Two fit inside the budget; the third is dropped rather than half-said.
  expect(line).toBe(`${sentence} ${sentence}`);
});

it("cuts and closes one sentence longer than the whole budget", () => {
  const words = Array.from({ length: FIRST_LINE_MAX_WORDS + 6 }, (_, at) => `word${at}`);
  const { line } = FirstLineSchema.parse({ line: `${words.join(" ")} and so on` });
  expect(line.split(" ")).toHaveLength(FIRST_LINE_MAX_WORDS);
  // Said out loud, so no ellipsis and no sentence left open.
  expect(line).not.toContain("…");
  expect(line.endsWith(`word${FIRST_LINE_MAX_WORDS - 1}.`)).toBe(true);
});

it("collapses the whitespace a spoken line should not have", () => {
  expect(FirstLineSchema.parse({ line: "  You're\nasking about  pricing. " }).line).toBe(
    "You're asking about pricing.",
  );
});

it("keeps an empty line empty, which means there is nothing worth saying", () => {
  expect(FirstLineSchema.parse({ line: "   " }).line).toBe("");
});
