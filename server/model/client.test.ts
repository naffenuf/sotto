import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { BOARD_OPS_SCHEMA_NAME, boardOpsJsonSchema } from "../../shared/board.js";
import {
  VERIFICATION_SCHEMA_NAME,
  verificationJsonSchema,
} from "../../shared/candidates.js";
import {
  DEFAULT_MAX_TOKENS,
  ModelCallError,
  MuseClient,
  SPARK_MODEL,
  type ChatCompletions,
  type ModelUsage,
  type Responses,
  type StreamingResponses,
} from "./client.js";

type Params = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.Completions.ChatCompletion;
type ResponseParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type StreamParams = OpenAI.Responses.ResponseCreateParamsStreaming;
type StreamEvent = OpenAI.Responses.ResponseStreamEvent;
type Response = OpenAI.Responses.Response;

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
    await expect(museClient.structured(call)).rejects.toThrow(
      new RegExp(`finish_reason "length".*${DEFAULT_MAX_TOKENS}`, "s"),
    );
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

/** The responses endpoint, answered from a canned reply. */
class FakeResponses implements Responses {
  readonly bodies: ResponseParams[] = [];

  constructor(private readonly reply: Partial<Response>) {}

  async create(body: ResponseParams): Promise<Response> {
    this.bodies.push(body);
    return {
      id: "r1",
      created_at: 0,
      model: SPARK_MODEL,
      object: "response",
      output: [],
      output_text: "",
      status: "completed",
      error: null,
      incomplete_details: null,
      ...this.reply,
    } as Response;
  }
}

/** One assistant message, with whatever annotations the test needs. */
function message(
  text: string,
  annotations: unknown[] = [],
): OpenAI.Responses.ResponseOutputItem {
  return {
    id: `m-${text.length}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations, logprobs: [] }],
  } as OpenAI.Responses.ResponseOutputItem;
}

/** One search call, with the pages it put in front of the model. */
function searchCall(...urls: string[]): OpenAI.Responses.ResponseOutputItem {
  return {
    id: "ws1",
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query: "when did it launch", sources: urls.map((url) => ({ type: "url", url })) },
  } as OpenAI.Responses.ResponseOutputItem;
}

function grounded(reply: Partial<Response>): { museClient: MuseClient; fake: FakeResponses } {
  const fake = new FakeResponses(reply);
  return {
    museClient: new MuseClient({ responses: fake, logger: { log: () => {}, warn: () => {} } }),
    fake,
  };
}

const groundedCall = {
  label: "verify",
  system: "You check one claim.",
  user: "## The claim",
  schemaName: VERIFICATION_SCHEMA_NAME,
  schema: verificationJsonSchema,
};

describe("MuseClient.grounded", () => {
  it("asks the Responses API for web search and strict structured output", async () => {
    const { museClient, fake } = grounded({ output: [message('{"verdict":"right"}')] });
    await museClient.grounded(groundedCall);

    const body = fake.bodies[0] as ResponseParams;
    expect(body.model).toBe(SPARK_MODEL);
    expect(body.instructions).toBe("You check one claim.");
    expect(body.input).toBe("## The claim");
    expect(body.max_output_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
    // Without this the search calls report their query and nothing else.
    expect(body.include).toEqual(["web_search_call.action.sources"]);
    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        name: VERIFICATION_SCHEMA_NAME,
        strict: true,
        schema: verificationJsonSchema,
      },
    });
    // The brainstorm belongs to the people having it.
    expect(body.store).toBe(false);
  });

  it("passes a caller's search context size and token budget", async () => {
    const { museClient, fake } = grounded({ output: [message("{}")] });
    await museClient.grounded({ ...groundedCall, maxTokens: 8_192, searchContextSize: "high" });
    const body = fake.bodies[0] as ResponseParams;
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "high" }]);
    expect(body.max_output_tokens).toBe(8_192);
  });

  /**
   * The model narrates between searches, so the JSON is the *last* message —
   * concatenating the output, as `output_text` does, yields prose with JSON
   * stuck on the end.
   */
  it("takes the structured reply out of the narration around it", async () => {
    const { museClient } = grounded({
      output: [
        message("I'll search for that."),
        searchCall("https://en.wikipedia.org/wiki/Instagram"),
        message("The results point to 2010, so I'll open the page."),
        message('{"verdict":"wrong","correction":"It launched in 2010.","citations":[]}'),
      ],
    });
    const reply = await museClient.grounded(groundedCall);
    expect(reply.value).toEqual({
      verdict: "wrong",
      correction: "It launched in 2010.",
      citations: [],
    });
    expect(reply.searched).toBe(true);
    expect(reply.searchedUrls).toEqual(["https://en.wikipedia.org/wiki/Instagram"]);
  });

  it("collects url_citation annotations, deduplicated and in order", async () => {
    const url = "https://en.wikipedia.org/wiki/Instagram";
    const { museClient } = grounded({
      output: [
        message("{}", [
          { type: "url_citation", url, title: "Instagram - Wikipedia", start_index: 0, end_index: 2 },
          { type: "url_citation", url, title: "Instagram - Wikipedia", start_index: 3, end_index: 5 },
          { type: "url_citation", url: "https://example.com/a", title: "", start_index: 0, end_index: 1 },
          { type: "file_citation", file_id: "f1", filename: "notes.md", index: 0 },
        ]),
      ],
    });
    const reply = await museClient.grounded(groundedCall);
    expect(reply.citations).toEqual([
      { url, title: "Instagram - Wikipedia" },
      // An untitled page still needs a name on the card.
      { url: "https://example.com/a", title: "example.com" },
    ]);
  });

  it("reports when no search happened at all", async () => {
    const { museClient } = grounded({ output: [message("{}")] });
    const reply = await museClient.grounded(groundedCall);
    expect(reply.searched).toBe(false);
    expect(reply.searchedUrls).toEqual([]);
  });

  it("counts a page it opened among the pages it saw", async () => {
    const opened = {
      id: "ws2",
      type: "web_search_call",
      status: "completed",
      action: { type: "open_page", url: "https://developer.apple.com/app-store/" },
    } as OpenAI.Responses.ResponseOutputItem;
    const { museClient } = grounded({ output: [opened, message("{}")] });
    const reply = await museClient.grounded(groundedCall);
    expect(reply.searchedUrls).toEqual(["https://developer.apple.com/app-store/"]);
  });

  it("fails loudly when the response did not complete", async () => {
    const { museClient } = grounded({
      output: [message('{"verdict":"right"}')],
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    await expect(museClient.grounded(groundedCall)).rejects.toThrow(ModelCallError);
    await expect(museClient.grounded(groundedCall)).rejects.toThrow(
      new RegExp(`came back incomplete \\(max_output_tokens\\).*${DEFAULT_MAX_TOKENS}`, "s"),
    );
  });

  it("fails when there is no text at all", async () => {
    const { museClient } = grounded({ output: [searchCall("https://example.com")] });
    await expect(museClient.grounded(groundedCall)).rejects.toThrow(/returned no text/);
  });

  it("fails when the reply is not JSON", async () => {
    const { museClient } = grounded({ output: [message("I could not check that.")] });
    await expect(museClient.grounded(groundedCall)).rejects.toThrow(/was not JSON/);
  });
});

/** The streaming responses endpoint, answered from a scripted event list. */
class FakeStream implements StreamingResponses {
  readonly bodies: StreamParams[] = [];

  constructor(private readonly events: StreamEvent[]) {}

  async create(body: StreamParams): Promise<AsyncIterable<StreamEvent>> {
    this.bodies.push(body);
    const events = this.events;
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    };
  }
}

/** One `response.output_text.delta`, as the API sends it. */
function delta(itemId: string, text: string): StreamEvent {
  return {
    type: "response.output_text.delta",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: text,
    logprobs: [],
    sequence_number: 0,
  } as StreamEvent;
}

/** The terminal event, carrying the whole response. */
function completed(reply: Partial<Response>): StreamEvent {
  return {
    type: "response.completed",
    sequence_number: 0,
    response: {
      id: "r1",
      created_at: 0,
      model: SPARK_MODEL,
      object: "response",
      output: [],
      output_text: "",
      status: "completed",
      error: null,
      incomplete_details: null,
      ...reply,
    },
  } as StreamEvent;
}

function streaming(events: StreamEvent[]): { museClient: MuseClient; fake: FakeStream } {
  const fake = new FakeStream(events);
  return {
    museClient: new MuseClient({
      streamingResponses: fake,
      logger: { log: () => {}, warn: () => {} },
    }),
    fake,
  };
}

const proseCall = {
  label: "answer",
  system: "You answer one question.",
  user: "## The question",
};

describe("MuseClient.prose", () => {
  it("asks for a streamed, searching reply with no schema", async () => {
    const { museClient, fake } = streaming([
      delta("msg_1", "An answer"),
      completed({ output: [message("An answer")] }),
    ]);
    await museClient.prose(proseCall);

    const body = fake.bodies[0]!;
    expect(body.model).toBe(SPARK_MODEL);
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("You answer one question.");
    expect(body.input).toBe("## The question");
    expect(body.max_output_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
    expect(body.include).toEqual(["web_search_call.action.sources"]);
    expect("text" in body && body.text !== undefined).toBe(false);
  });

  it("reports the text of the item being written, from that item's start", async () => {
    const seen: { itemId: string; text: string }[] = [];
    const { museClient } = streaming([
      delta("rs_1", "I'll look that up."),
      delta("msg_1", "An answer"),
      delta("msg_1", " of two halves"),
      completed({ output: [message("An answer of two halves")] }),
    ]);
    const reply = await museClient.prose({ ...proseCall, onText: (update) => seen.push(update) });

    expect(seen).toEqual([
      { itemId: "rs_1", text: "I'll look that up." },
      { itemId: "msg_1", text: "An answer" },
      { itemId: "msg_1", text: "An answer of two halves" },
    ]);
    expect(reply.text).toBe("An answer of two halves");
  });

  it("returns the last message, the annotations and the pages searched", async () => {
    const { museClient } = streaming([
      completed({
        output: [
          message("I'll look up the pricing."),
          searchCall("https://example.com/a", "https://example.com/b"),
          message("Rivals charge $12 a seat", [
            { type: "url_citation", url: "https://example.com/a", title: "Prices" },
            { type: "url_citation", url: "https://example.com/a", title: "Prices again" },
          ]),
        ],
      }),
    ]);
    const reply = await museClient.prose(proseCall);

    expect(reply.text).toBe("Rivals charge $12 a seat");
    expect(reply.citations).toEqual([{ url: "https://example.com/a", title: "Prices" }]);
    expect(reply.searchedUrls).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(reply.searched).toBe(true);
  });

  it("fails when the response never completed", async () => {
    const { museClient } = streaming([delta("msg_1", "half an ans")]);
    await expect(museClient.prose(proseCall)).rejects.toThrow(/without a response/);
  });

  it("fails when the response ran out of room, and says so", async () => {
    const { museClient } = streaming([
      {
        type: "response.incomplete",
        sequence_number: 0,
        response: {
          id: "r1",
          created_at: 0,
          model: SPARK_MODEL,
          object: "response",
          output: [message("half an answer")],
          output_text: "",
          status: "incomplete",
          error: null,
          incomplete_details: { reason: "max_output_tokens" },
        },
      } as StreamEvent,
    ]);
    await expect(museClient.prose(proseCall)).rejects.toThrow(
      /came back incomplete \(max_output_tokens\)/,
    );
  });

  it("fails when nothing was written at all", async () => {
    const { museClient } = streaming([
      completed({ output: [searchCall("https://example.com/a")] }),
    ]);
    await expect(museClient.prose(proseCall)).rejects.toThrow(/returned no text/);
  });

  it("reports what the answer spent", async () => {
    const spent: ModelUsage[] = [];
    const fake = new FakeStream([completed({
      output: [message("An answer")],
      usage: {
        input_tokens: 3_000,
        output_tokens: 2_100,
        total_tokens: 5_100,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 1_700 },
      },
    } as Partial<Response>)]);
    const museClient = new MuseClient({
      streamingResponses: fake,
      logger: { log: () => {}, warn: () => {} },
      onUsage: (usage) => spent.push(usage),
    });
    await museClient.prose(proseCall);
    expect(spent).toEqual([
      { label: "answer", inputTokens: 3_000, outputTokens: 2_100, reasoningTokens: 1_700 },
    ]);
  });
});

describe("MuseClient usage reporting", () => {
  const quiet = { log: () => {}, warn: () => {} };

  it("reports what a structured call spent, under the call's label", async () => {
    const spent: ModelUsage[] = [];
    const fake = new FakeCompletions(choice('{"operations":[]}'));
    const museClient = new MuseClient({
      completions: fake,
      logger: quiet,
      onUsage: (usage) => spent.push(usage),
    });
    await museClient.structured(call);
    expect(spent).toEqual([
      { label: "board", inputTokens: 100, outputTokens: 210, reasoningTokens: 180 },
    ]);
  });

  it("reports a truncated reply too: the tokens were billed either way", async () => {
    const spent: ModelUsage[] = [];
    const fake = new FakeCompletions(choice(null, "length"));
    const museClient = new MuseClient({
      completions: fake,
      logger: quiet,
      onUsage: (usage) => spent.push(usage),
    });
    await expect(museClient.structured(call)).rejects.toThrow(ModelCallError);
    expect(spent).toHaveLength(1);
  });

  it("reports zero rather than nothing when the API omits the usage", async () => {
    const spent: ModelUsage[] = [];
    const fake = new FakeCompletions({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          logprobs: null,
          message: { role: "assistant", content: "{}", refusal: null },
        },
      ],
    } as Partial<Completion>);
    const museClient = new MuseClient({
      completions: fake,
      logger: quiet,
      onUsage: (usage) => spent.push(usage),
    });
    await museClient.structured(call);
    expect(spent[0]).toEqual({
      label: "board",
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("reports a grounded call, whose endpoint names the tokens differently", async () => {
    const spent: ModelUsage[] = [];
    const fake = new FakeResponses({
      output: [message('{"verdict":"right"}')],
      usage: {
        input_tokens: 2_400,
        output_tokens: 1_800,
        total_tokens: 4_200,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 1_500 },
      },
    } as Partial<Response>);
    const museClient = new MuseClient({
      responses: fake,
      logger: quiet,
      onUsage: (usage) => spent.push(usage),
    });
    await museClient.grounded(groundedCall);
    expect(spent).toEqual([
      { label: "verify", inputTokens: 2_400, outputTokens: 1_800, reasoningTokens: 1_500 },
    ]);
  });
});
