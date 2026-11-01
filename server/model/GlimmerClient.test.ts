import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { ModelCallError, type StructuredCall } from "./client.js";
import {
  GLIMMER_KEEP_ALIVE,
  GLIMMER_MAX_TOKENS,
  GlimmerClient,
  type GlimmerCompletions,
  type GlimmerModels,
  type GlimmerRequest,
} from "./GlimmerClient.js";

type Completion = OpenAI.Chat.Completions.ChatCompletion;

const MODEL = "muse-glimmer:30b-q4_K_M";
const BASE_URL = "http://127.0.0.1:11434/v1";

const quiet = { log: () => {}, warn: () => {} };

/** The schema a judgment call constrains itself with. */
const GATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["useful"],
  properties: { useful: { type: "number" } },
};

function call(overrides: Partial<StructuredCall> = {}): StructuredCall {
  return {
    label: "research_gate",
    system: "You score research ideas.",
    user: "Idea: what do the competitors charge?",
    schemaName: "research_gate",
    schema: GATE_SCHEMA,
    ...overrides,
  };
}

/** The completions endpoint, answered from a canned reply. */
class FakeCompletions implements GlimmerCompletions {
  readonly bodies: GlimmerRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];

  constructor(private readonly reply: Partial<Completion>) {}

  async create(body: GlimmerRequest, options?: { signal: AbortSignal }): Promise<Completion> {
    this.bodies.push(body);
    this.signals.push(options?.signal);
    return {
      id: "chatcmpl-1",
      created: 0,
      model: MODEL,
      object: "chat.completion",
      choices: [],
      ...this.reply,
    } as Completion;
  }
}

/** A reply with one choice, shaped as Ollama's endpoint sends it. */
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
    // Ollama reports no reasoning breakdown; thinking is inside these tokens.
    usage: { completion_tokens: 180, prompt_tokens: 67, total_tokens: 247 },
  } as Partial<Completion>;
}

function client(reply: Partial<Completion>): { glimmer: GlimmerClient; completions: FakeCompletions } {
  const completions = new FakeCompletions(reply);
  return {
    glimmer: new GlimmerClient({ baseUrl: BASE_URL, model: MODEL, logger: quiet, completions }),
    completions,
  };
}

describe("GlimmerClient.structured", () => {
  it("asks the configured model for grammar-constrained JSON and parses it", async () => {
    const { glimmer, completions } = client(choice('{"useful": 0.8}'));

    expect(await glimmer.structured(call())).toEqual({ useful: 0.8 });

    const body = completions.bodies[0];
    expect(body?.model).toBe(MODEL);
    expect(body?.max_tokens).toBe(GLIMMER_MAX_TOKENS);
    expect(body?.messages).toEqual([
      { role: "system", content: "You score research ideas." },
      { role: "user", content: "Idea: what do the competitors charge?" },
    ]);
    expect(body?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "research_gate", strict: true, schema: GATE_SCHEMA },
    });
  });

  it("keeps the model loaded and keeps its thinking short", async () => {
    const { glimmer, completions } = client(choice('{"useful": 0.4}'));

    await glimmer.structured(call());

    // Ollama unloads after five idle minutes and a reload costs ~44 s, and
    // the model's own default reasoning level costs ~35 s a call.
    expect(completions.bodies[0]?.keep_alive).toBe(GLIMMER_KEEP_ALIVE);
    expect(completions.bodies[0]?.reasoning_effort).toBe("low");
    // Nothing pins the temperature: Glimmer must not run greedy.
    expect(completions.bodies[0]?.temperature).toBeUndefined();
  });

  it("lets a caller ask for more thinking and more room", async () => {
    const { glimmer, completions } = client(choice('{"useful": 1}'));

    await glimmer.structured(call({ reasoningEffort: "high", maxTokens: 4_096 }));

    expect(completions.bodies[0]?.reasoning_effort).toBe("high");
    expect(completions.bodies[0]?.max_tokens).toBe(4_096);
  });

  it("passes a caller's abort signal through", async () => {
    const { glimmer, completions } = client(choice('{"useful": 0}'));
    const controller = new AbortController();

    await glimmer.structured(call({ signal: controller.signal }));

    expect(completions.signals[0]).toBe(controller.signal);
  });

  it("strips the end-of-turn marker a build can leak into the content", async () => {
    const { glimmer } = client(choice('{"useful": 0.5}<|eot|>'));

    expect(await glimmer.structured(call())).toEqual({ useful: 0.5 });
  });

  it("treats a truncated reply as a failure, not as an empty verdict", async () => {
    const { glimmer } = client(choice(null, "length"));

    await expect(glimmer.structured(call())).rejects.toThrow(ModelCallError);
    await expect(glimmer.structured(call())).rejects.toThrow(/finish_reason "length".*maxTokens/s);
  });

  it("rejects an empty reply", async () => {
    const { glimmer } = client(choice("   "));

    await expect(glimmer.structured(call())).rejects.toThrow(/empty content/);
  });

  it("rejects a reply that is not JSON", async () => {
    const { glimmer } = client(choice("Sure! Here you go."));

    await expect(glimmer.structured(call())).rejects.toThrow(/was not JSON/);
  });

  it("rejects a reply with no choices", async () => {
    const { glimmer } = client({ choices: [] });

    await expect(glimmer.structured(call())).rejects.toThrow(/no choices/);
  });
});

/** The models endpoint, answered from a canned list or an error. */
class FakeModels implements GlimmerModels {
  calls = 0;

  constructor(private readonly ids: string[] | Error) {}

  async list(): Promise<{ data: { id: string }[] }> {
    this.calls += 1;
    if (this.ids instanceof Error) throw this.ids;
    return { data: this.ids.map((id) => ({ id })) };
  }
}

function health(ids: string[] | Error): GlimmerClient {
  return new GlimmerClient({
    baseUrl: BASE_URL,
    model: MODEL,
    logger: quiet,
    models: new FakeModels(ids),
  });
}

describe("GlimmerClient.health", () => {
  it("is ok when the endpoint is serving the configured model", async () => {
    const result = await health([MODEL, "qwen3:14b"]).health();

    expect(result.ok).toBe(true);
    expect(result.detail).toContain(MODEL);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("is not ok when the endpoint is up but serving something else", async () => {
    const result = await health(["qwen3:14b"]).health();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not serving");
    expect(result.detail).toContain("qwen3:14b");
  });

  it("answers rather than throwing when the endpoint is not there", async () => {
    const result = await health(new Error("ECONNREFUSED")).health();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("did not answer");
    expect(result.detail).toContain("ECONNREFUSED");
  });
});
