import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { BOARD_OPS_SCHEMA_NAME, boardOpsJsonSchema } from "../../shared/board.js";
import {
  DEFAULT_MAX_TOKENS,
  ModelCallError,
  MuseClient,
  SPARK_MODEL,
  type ChatCompletions,
} from "./client.js";

type Params = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.Completions.ChatCompletion;

/** The completions endpoint, answered from a canned reply. */
class FakeCompletions implements ChatCompletions {
  readonly bodies: Params[] = [];

  constructor(private readonly reply: Partial<Completion>) {}

  async create(body: Params): Promise<Completion> {
    this.bodies.push(body);
    return { id: "c1", created: 0, model: SPARK_MODEL, object: "chat.completion", choices: [], ...this.reply } as Completion;
  }
}

/** A reply with one choice, as the API sends it. */
function choice(
  content: string | null,
  finishReason: Completion["choices"][number]["finish_reason"] = "stop",
): Partial<Completion> {
  return {
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        logprobs: null,
        message: { role: "assistant", content, refusal: null },
      },
    ],
    usage: {
      completion_tokens: 210,
      prompt_tokens: 100,
      total_tokens: 310,
      completion_tokens_details: { reasoning_tokens: 180 },
    },
  } as Partial<Completion>;
}

function client(reply: Partial<Completion>): { museClient: MuseClient; fake: FakeCompletions } {
  const fake = new FakeCompletions(reply);
  return {
    museClient: new MuseClient({ completions: fake, logger: { log: () => {}, warn: () => {} } }),
    fake,
  };
}

const call = {
  label: "board",
  system: "You keep a board.",
  user: "## The board right now",
  schemaName: BOARD_OPS_SCHEMA_NAME,
  schema: boardOpsJsonSchema,
};

describe("MuseClient", () => {
  it("asks for strict structured output from muse-spark-1.3", async () => {
    const { museClient, fake } = client(choice('{"operations":[]}'));
    await museClient.structured(call);

    const body = fake.bodies[0] as Params;
    expect(body.model).toBe(SPARK_MODEL);
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(body.messages).toEqual([
      { role: "system", content: "You keep a board." },
      { role: "user", content: "## The board right now" },
    ]);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: BOARD_OPS_SCHEMA_NAME, strict: true, schema: boardOpsJsonSchema },
    });
  });

  it("returns the reply parsed as JSON", async () => {
    const { museClient } = client(choice('{"operations":[{"op":"set_summary","text":"Hi"}]}'));
    await expect(museClient.structured(call)).resolves.toEqual({
      operations: [{ op: "set_summary", text: "Hi" }],
    });
  });

  it("respects a caller's token budget", async () => {
    const { museClient, fake } = client(choice("{}"));
    await museClient.structured({ ...call, maxTokens: 8_192 });
    expect((fake.bodies[0] as Params).max_tokens).toBe(8_192);
  });

  /**
   * The failure that costs an afternoon: a reasoning model out of budget
   * answers 200 with no content and `finish_reason: "length"`.
   */
  it("fails loudly when the reasoning budget ran out", async () => {
    const { museClient } = client(choice(null, "length"));
    await expect(museClient.structured(call)).rejects.toThrow(ModelCallError);
    await expect(museClient.structured(call)).rejects.toThrow(/finish_reason "length".*4096/s);
  });

  it("fails when the content is empty despite a clean stop", async () => {
    const { museClient } = client(choice("   "));
    await expect(museClient.structured(call)).rejects.toThrow(/empty content/);
  });

  it("fails when the reply is not JSON", async () => {
    const { museClient } = client(choice("Here are the operations you asked for!"));
    await expect(museClient.structured(call)).rejects.toThrow(/was not JSON/);
  });

  it("fails when there are no choices at all", async () => {
    const { museClient } = client({ choices: [] });
    await expect(museClient.structured(call)).rejects.toThrow(/no choices/);
  });
});
