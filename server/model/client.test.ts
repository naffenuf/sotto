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
  PROSE_MAX_ROUNDS,
  SPARK_MODEL,
  type ChatCompletions,
  type FunctionTool,
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

  it("passes low reasoning and cancellation through for bounded address classification", async () => {
    const controller = new AbortController();
    const { fake } = client(choice("{}"));
    let receivedSignal: AbortSignal | undefined;
    const model = new MuseClient({
      logger: { log: () => {}, warn: () => {} },
      completions: {
        create: (body, options) => {
          receivedSignal = options?.signal;
          return fake.create(body);
        },
      },
    });
    await model.structured({ ...call, reasoningEffort: "low", maxTokens: 2_000, signal: controller.signal });
    expect(fake.bodies[0]?.reasoning_effort).toBe("low");
    expect(fake.bodies[0]?.max_tokens).toBe(2_000);
    expect(receivedSignal).toBe(controller.signal);
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
    // A list, not a bare string: a prose call is a conversation as soon as
    // there is a tool in it (US-020), so it is always sent as one.
    expect(body.input).toEqual([{ role: "user", content: "## The question" }]);
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

/** Nothing in these tests reads the logs. */
const silent = { log: () => {}, warn: () => {} };

/** The streaming endpoint, with a different event list for each round. */
class FakeRounds implements StreamingResponses {
  readonly bodies: StreamParams[] = [];

  constructor(private readonly rounds: StreamEvent[][]) {}

  async create(body: StreamParams): Promise<AsyncIterable<StreamEvent>> {
    this.bodies.push(structuredClone(body));
    const events = this.rounds[this.bodies.length - 1];
    if (events === undefined) throw new Error(`unexpected round ${this.bodies.length}`);
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    };
  }
}

/** One `function_call` item, as the API ends a round with. */
function functionCall(name: string, args: string, id = "call_1"): OpenAI.Responses.ResponseOutputItem {
  return {
    id: `fc_${id}`,
    call_id: id,
    type: "function_call",
    name,
    arguments: args,
    status: "completed",
  } as OpenAI.Responses.ResponseOutputItem;
}

function rounds(lists: StreamEvent[][]): { museClient: MuseClient; fake: FakeRounds } {
  const fake = new FakeRounds(lists);
  return {
    museClient: new MuseClient({ streamingResponses: fake, logger: silent }),
    fake,
  };
}

/** `show_html`, with its calls collected. */
function showHtml(result = "shown"): {
  tool: FunctionTool;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    tool: {
      name: "show_html",
      description: "Show something.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      run: (args) => {
        calls.push(args);
        return result;
      },
    },
  };
}

describe("MuseClient.prose with function tools (US-020)", () => {
  it("declares the function beside web_search, strictly", async () => {
    const { tool } = showHtml();
    const { museClient, fake } = rounds([
      [delta("msg_1", "An answer"), completed({ output: [message("An answer")] })],
    ]);
    await museClient.prose({ ...proseCall, functions: [tool] });

    expect(fake.bodies[0]?.tools).toEqual([
      { type: "web_search", search_context_size: "medium" },
      {
        type: "function",
        name: "show_html",
        description: "Show something.",
        strict: true,
        parameters: tool.parameters,
      },
    ]);
  });

  it("runs the tool and asks again, because the round that called it has no answer", async () => {
    const { tool, calls } = showHtml('"User flow" is on the screen now.');
    const { museClient, fake } = rounds([
      // Round 1: narration and a tool call, and no answer at all — which is
      // exactly what the real API does (`fixtures/events/NOTES.md`).
      [
        delta("rs_1", "Sketching that for you."),
        completed({
          output: [
            message("Sketching that for you."),
            functionCall("show_html", '{"title":"User flow","html":"<svg/>"}'),
          ],
        }),
      ],
      // Round 2: the answer.
      [
        delta("msg_1", "Four screens, with recognition and suggestions on one\n"),
        completed({ output: [message("Four screens\n\nThe loops are at the bottom.")] }),
      ],
    ]);

    const reply = await museClient.prose({ ...proseCall, functions: [tool] });

    expect(calls).toEqual([{ title: "User flow", html: "<svg/>" }]);
    expect(reply.text).toBe("Four screens\n\nThe loops are at the bottom.");
    expect(reply.functionCalls).toBe(1);
    // The second round carries the question, the call and its result — and
    // not the model's own narration, which it does not need back.
    expect(fake.bodies[1]?.input).toEqual([
      { role: "user", content: "## The question" },
      expect.objectContaining({ type: "function_call", name: "show_html" }),
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '"User flow" is on the screen now.',
      },
    ]);
  });

  it("keeps the citations and searched pages from every round", async () => {
    const { tool } = showHtml();
    const { museClient } = rounds([
      [
        completed({
          output: [
            searchCall("https://example.com/a"),
            message("thinking", [
              { type: "url_citation", url: "https://example.com/a", title: "A" },
            ]),
            functionCall("show_html", "{}"),
          ],
        }),
      ],
      [
        completed({
          output: [
            searchCall("https://example.com/b"),
            message("An answer", [
              { type: "url_citation", url: "https://example.com/b", title: "B" },
            ]),
          ],
        }),
      ],
    ]);

    const reply = await museClient.prose({ ...proseCall, functions: [tool] });
    expect(reply.citations.map((one) => one.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(reply.searchedUrls).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(reply.searched).toBe(true);
  });

  it("tells the model in words when the tool is unknown, broken or badly called", async () => {
    const answer = [
      delta("msg_1", "An answer"),
      completed({ output: [message("An answer")] }),
    ];
    const cases: [StreamEvent[], RegExp][] = [
      [[completed({ output: [functionCall("draw_svg", "{}")] })], /no tool called draw_svg/],
      [[completed({ output: [functionCall("show_html", "{not json")] })], /not valid JSON/],
    ];
    for (const [first, expected] of cases) {
      const { tool } = showHtml();
      const { museClient, fake } = rounds([first, answer]);
      await museClient.prose({ ...proseCall, functions: [tool] });
      const sent = fake.bodies[1]?.input as { output?: string }[];
      // [user, function_call, function_call_output]
      expect(sent[2]?.output).toMatch(expected);
    }

    // A handler that throws is the same kind of thing: an answer in words is
    // a far better outcome than no answer.
    const { museClient, fake } = rounds([
      [completed({ output: [functionCall("show_html", "{}")] })],
      answer,
    ]);
    const thrower: FunctionTool = {
      name: "show_html",
      description: "Show something.",
      parameters: {},
      run: () => {
        throw new Error("the disk is full");
      },
    };
    const reply = await museClient.prose({ ...proseCall, functions: [thrower] });
    expect(reply.text).toBe("An answer");
    expect((fake.bodies[1]?.input as { output?: string }[])[2]?.output).toMatch(
      /show_html failed \(the disk is full\)/,
    );
  });

  it("gives up once the model has used every round on tool calls", async () => {
    const { tool } = showHtml();
    const drawing = [completed({ output: [functionCall("show_html", "{}")] })];
    const { museClient, fake } = rounds([drawing, drawing, drawing]);
    await expect(museClient.prose({ ...proseCall, functions: [tool] })).rejects.toThrow(
      /called a tool on all 3 rounds/,
    );
    expect(fake.bodies).toHaveLength(PROSE_MAX_ROUNDS);
  });

  it("makes exactly one round when there are no function tools", async () => {
    const { museClient, fake } = rounds([
      [completed({ output: [message("An answer")] })],
    ]);
    const reply = await museClient.prose(proseCall);
    expect(reply.functionCalls).toBe(0);
    expect(fake.bodies).toHaveLength(1);
    expect(fake.bodies[0]?.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
  });
});
