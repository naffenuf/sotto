/**
 * The one way the server asks Muse Spark for something.
 *
 * Every model call in Sotto — the board (US-009), the observer (US-012), the
 * answers (US-018) — is the same shape: a prompt from `server/prompts/*.md`, a
 * rendered request, and a strict JSON Schema the reply has to fit. So that
 * shape lives here once, together with the two things that bite when calling
 * this model:
 *
 *   - **It reasons before it answers.** `max_tokens` is a budget for hidden
 *     reasoning *and* output, and a budget that runs out comes back as
 *     `finish_reason: "length"` with `content: null` and no error at all. So
 *     the budget is generous and `finish_reason` is checked before the content
 *     is trusted (see `CLAUDE.md`).
 *   - **Structured output is not a guarantee.** The reply is parsed as JSON
 *     here and validated against zod by the caller, because a reply that
 *     doesn't fit has to be a handled failure rather than a crash.
 *
 * `ModelClient` is the seam the unit tests use, so `npm test` makes no
 * network calls.
 */
import OpenAI from "openai";
import type { Citation } from "../../shared/cards.js";

/** Meta's OpenAI-compatible endpoint. */
export const MODEL_BASE_URL = "https://api.meta.ai/v1";

/** The reasoning model everything in Sotto talks to. */
export const SPARK_MODEL = "muse-spark-1.3";

/**
 * Completion-token budget when a caller doesn't name one. Big enough for a few
 * hundred tokens of structured output *after* the model has finished thinking.
 *
 * 4,096 was not: the eval run of 2026-10-28 lost eight board updates and an
 * observer look to `finish_reason: "length"`, every one of them having spent
 * the whole budget on reasoning and emitted nothing (`4096 completion tokens
 * (4094 reasoning)`). A board update that fails costs more than itself — the
 * observer only looks *after* a successful one — so the budget is sized for
 * the worst thinking seen rather than the typical, which measured 1,300–3,200.
 * Nothing is billed for room that goes unused; a truncated reply is billed in
 * full for nothing.
 */
export const DEFAULT_MAX_TOKENS = 12_288;

/** One structured-output request. */
export interface StructuredCall {
  /** Short name for logs and {@link Clock.track} (`"board"`). */
  label: string;
  /** The system prompt, from `server/prompts/`. */
  system: string;
  /** The rendered request: the state and the new material. */
  user: string;
  /** `response_format.json_schema.name`. */
  schemaName: string;
  /**
   * A JSON Schema in the subset strict structured output accepts — closed
   * objects, everything required, `anyOf` not `oneOf`, no length keywords.
   * See {@link boardOpsJsonSchema} for what that looks like.
   */
  schema: object;
  /** Reasoning + output budget. Defaults to {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
}

/**
 * One structured-output request that may search the web first (US-013).
 *
 * The same three things a {@link StructuredCall} carries, through the
 * Responses API instead of chat completions, because that is where the
 * `web_search` tool lives
 * (https://dev.meta.ai/docs/cookbook/search-grounding).
 */
export interface GroundedCall extends StructuredCall {
  /**
   * How much search context the model is given: `low`, `medium` (the API's
   * default) or `high`.
   */
  searchContextSize?: "low" | "medium" | "high";
}

/**
 * One function the model may call while it is writing (US-020).
 *
 * The only one in Sotto is `show_html`, which puts a diagram or a table on
 * the shared screen. {@link MuseClient.prose} runs the loop itself — call the
 * handler, hand the model what it returned, ask again — so a caller declares
 * a tool and never sees a `function_call` item.
 */
export interface FunctionTool {
  /** As the model sees it, e.g. `show_html`. */
  name: string;
  /** What it does and when to call it. The model reads this. */
  description: string;
  /**
   * JSON Schema for the arguments, in the subset strict function calling
   * accepts — closed object, everything required, no length keywords. See
   * {@link showHtmlJsonSchema}.
   */
  parameters: object;
  /**
   * Runs the call and returns what the model is told about the result.
   *
   * It must not throw: a tool that failed is something the model should be
   * told in words, so it can answer anyway, rather than a reason to lose the
   * whole answer.
   */
  run: (args: unknown) => string | Promise<string>;
}

/**
 * Rounds of "the model calls a tool, we answer it, it writes" one prose call
 * may take before the answer has to be text.
 *
 * Measured: when the model calls `show_html` it ends that turn with no answer
 * at all — only its own narration — so a second round is not optional, it is
 * where the headline comes from. A third is slack for a model that draws
 * twice. The tools stay on the table on every round, including the last: a
 * request whose input holds a `function_call` whose tool is no longer declared
 * is a shape the API has never been asked for here, and a 400 would lose the
 * answer the withholding was meant to protect. A model that draws on all three
 * rounds therefore ends as a handled error, not as a silent empty answer.
 */
export const PROSE_MAX_ROUNDS = 3;

/**
 * One streamed, searching call whose reply is **prose** (US-018).
 *
 * The answer agent is the one caller that does not want JSON: the PRD's shape
 * for an answer is "line 1 is a headline, then markdown", which is text — and
 * text is also the only kind of reply the API attaches `url_citation`
 * annotations to, since an annotation is a character range into what the model
 * wrote (measured; see `CLAUDE.md`). So there is no schema here, and the reply
 * arrives in pieces so that the headline can be on screen before the detail
 * has been written.
 */
export interface ProseCall {
  /** Short name for logs and {@link Clock.track} (`"answer"`). */
  label: string;
  /** The system prompt, from `server/prompts/`. */
  system: string;
  /** The rendered request: the conversation, and the question. */
  user: string;
  /** Reasoning + search + output budget. Defaults to {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
  /** How much search context the model is given. */
  searchContextSize?: "low" | "medium" | "high";
  /**
   * Tools the model may call while it writes (US-020), beside `web_search`.
   *
   * Confirmed against the real API: `web_search` and a function tool are
   * accepted in the same request, so there is no intent routing here — see
   * `fixtures/events/NOTES.md`.
   */
  functions?: readonly FunctionTool[];
  /**
   * Called as the text of the output item the model is writing grows.
   *
   * `itemId` changes whenever it starts a new one, and it starts several: a
   * grounded reply is narration ("I'll pull the current pricing"), then the
   * searches, then the answer, each as its own item (measured — see
   * `fixtures/events/NOTES.md`). So `text` is the current item from its
   * beginning, not the whole reply, and a caller watching for the first line
   * must start again when the id changes.
   */
  onText?: (update: { itemId: string; text: string }) => void;
}

/** A prose reply: the text, and what the model read to write it. */
export interface ProseReply {
  /** The model's answer — the last thing it wrote, without the narration. */
  text: string;
  /** Every `url_citation` annotation, deduplicated by URL, in order. */
  citations: Citation[];
  /** Every URL the search really returned or opened, in order. */
  searchedUrls: string[];
  /** Whether the model searched at all. */
  searched: boolean;
  /**
   * How many {@link ProseCall.functions} calls ran, in total. The results
   * themselves went back to the model; a caller that cares what a tool did
   * knows it from its own handler.
   */
  functionCalls: number;
}

/** A grounded reply: the JSON, and what the model actually read to write it. */
export interface GroundedReply {
  /** The reply parsed as JSON, for the caller to validate. */
  value: unknown;
  /**
   * Every `url_citation` annotation on the reply, deduplicated by URL and in
   * the order they first appear.
   *
   * Often empty when the reply is structured output: an annotation is a
   * character range into the model's prose, and a reply that is nothing but
   * JSON gives it nothing to point at (measured — see `CLAUDE.md`). So this
   * is the best source of citations, not the only one; {@link searchedUrls}
   * is what lets a caller tell a real page from an invented one.
   */
  citations: Citation[];
  /**
   * Every URL the search really returned or opened, in order. A URL the model
   * names that is not in here was not in front of it.
   */
  searchedUrls: string[];
  /**
   * Whether the model ran a search at all. It decides for itself, and may
   * answer from training data instead
   * (https://dev.meta.ai/docs/cookbook/search-grounding), so a verdict
   * reached without searching is worth telling apart in a log.
   */
  searched: boolean;
}

/**
 * What one call spent, as the API reported it.
 *
 * Only the eval harness listens (PRD US-016's estimated cost); the pipeline
 * itself never needs to know. Reasoning tokens are a *part of* the output
 * tokens, not an addition to them, so a price is `input + output` and nothing
 * else.
 */
export interface ModelUsage {
  /** The call's {@link StructuredCall.label}. */
  label: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** A call that didn't come back with usable JSON. Always catchable. */
export class ModelCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCallError";
  }
}

/** What the pipeline needs from the model. A fake one keeps tests offline. */
export interface ModelClient {
  /**
   * Returns the reply parsed as JSON, for the caller to validate.
   *
   * @throws {ModelCallError} when the call came back truncated, empty, or not
   * as JSON. Transport failures arrive as whatever the SDK threw.
   */
  structured(call: StructuredCall): Promise<unknown>;

  /**
   * The same, with the web available to the model first.
   *
   * @throws {ModelCallError} when the response did not complete, carried no
   * text, or was not JSON.
   */
  grounded(call: GroundedCall): Promise<GroundedReply>;

  /**
   * The same again, but the reply is prose and it arrives in pieces.
   *
   * @throws {ModelCallError} when the response did not complete or carried no
   * text. Transport failures arrive as whatever the SDK threw.
   */
  prose(call: ProseCall): Promise<ProseReply>;
}

/** The slice of the OpenAI SDK a structured call uses. */
export interface ChatCompletions {
  create(
    body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
}

/** The slice of the OpenAI SDK a grounded call uses. */
export interface Responses {
  create(
    body: OpenAI.Responses.ResponseCreateParamsNonStreaming,
  ): Promise<OpenAI.Responses.Response>;
}

/** The slice of the OpenAI SDK a streamed prose call uses. */
export interface StreamingResponses {
  create(
    body: OpenAI.Responses.ResponseCreateParamsStreaming,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
}

type Logger = Pick<Console, "log" | "warn">;

export interface MuseClientOptions {
  /** Meta Model API key. Never logged. */
  apiKey?: string;
  model?: string;
  logger?: Logger;
  /** Seam for tests: the completions endpoint to call instead of the real one. */
  completions?: ChatCompletions;
  /** Seam for tests: the responses endpoint to call instead of the real one. */
  responses?: Responses;
  /** Seam for tests: the streaming responses endpoint, for {@link MuseClient.prose}. */
  streamingResponses?: StreamingResponses;
  /**
   * Told what every call spent, before any error is thrown — a truncated
   * reply is billed too. The eval harness uses it to price a run (US-016).
   */
  onUsage?: (usage: ModelUsage) => void;
}

export class MuseClient implements ModelClient {
  private readonly model: string;
  private readonly logger: Logger;
  private readonly options: MuseClientOptions;
  /**
   * The SDK client, built on first use rather than in the constructor: it
   * refuses an empty API key, and a test that replaces one endpoint's seam
   * has no key to give it.
   */
  private sdk: OpenAI | undefined;

  constructor(options: MuseClientOptions = {}) {
    this.options = options;
    this.model = options.model ?? SPARK_MODEL;
    this.logger = options.logger ?? console;
  }

  private get completions(): ChatCompletions {
    return this.options.completions ?? this.openai().chat.completions;
  }

  private get responses(): Responses {
    return this.options.responses ?? this.openai().responses;
  }

  private get streamingResponses(): StreamingResponses {
    return this.options.streamingResponses ?? this.openai().responses;
  }

  private openai(): OpenAI {
    return (this.sdk ??= new OpenAI({
      apiKey: this.options.apiKey ?? "",
      baseURL: MODEL_BASE_URL,
    }));
  }

  /**
   * Passes on what a call spent. The two endpoints name the same numbers
   * differently (`prompt_tokens` against `input_tokens`), and either may omit
   * them, so a missing count is zero rather than a reason not to report.
   */
  private reportUsage(
    label: string,
    tokens: { input?: number | undefined; output?: number | undefined; reasoning?: number | undefined },
  ): void {
    this.options.onUsage?.({
      label,
      inputTokens: tokens.input ?? 0,
      outputTokens: tokens.output ?? 0,
      reasoningTokens: tokens.reasoning ?? 0,
    });
  }

  async structured(call: StructuredCall): Promise<unknown> {
    const completion = await this.completions.create({
      model: this.model,
      max_tokens: call.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        { role: "system", content: call.system },
        { role: "user", content: call.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: call.schemaName,
          strict: true,
          schema: call.schema as Record<string, unknown>,
        },
      },
    });

    const choice = completion.choices[0];
    const reasoning = completion.usage?.completion_tokens_details?.reasoning_tokens;
    this.logger.log(
      `[model] ${call.label}: ${choice?.finish_reason ?? "no choice"}` +
        `, ${completion.usage?.completion_tokens ?? 0} completion tokens` +
        (reasoning === undefined ? "" : ` (${reasoning} reasoning)`),
    );
    this.reportUsage(call.label, {
      input: completion.usage?.prompt_tokens,
      output: completion.usage?.completion_tokens,
      reasoning,
    });

    if (choice === undefined) {
      throw new ModelCallError(`${call.label}: the model returned no choices`);
    }
    // A reasoning model that runs out of budget says "length" and hands back
    // nothing, with a 200. Checking this is the only way to notice.
    if (choice.finish_reason !== "stop") {
      throw new ModelCallError(
        `${call.label}: the model stopped with finish_reason ${JSON.stringify(choice.finish_reason)}` +
          `; raise max_tokens above ${call.maxTokens ?? DEFAULT_MAX_TOKENS}`,
      );
    }
    const content = choice.message.content;
    if (content === null || content.trim() === "") {
      throw new ModelCallError(`${call.label}: the model returned empty content`);
    }
    try {
      return JSON.parse(content) as unknown;
    } catch (error) {
      throw new ModelCallError(
        `${call.label}: the model's reply was not JSON (${error instanceof Error ? error.message : String(error)}): ${content.slice(0, 200)}`,
      );
    }
  }

  async grounded(call: GroundedCall): Promise<GroundedReply> {
    const response = await this.responses.create({
      model: this.model,
      instructions: call.system,
      input: call.user,
      max_output_tokens: call.maxTokens ?? DEFAULT_MAX_TOKENS,
      tools: [{ type: "web_search", search_context_size: call.searchContextSize ?? "medium" }],
      // Without this the search calls come back with the query and nothing
      // else, and there is no way to tell a page the model read from one it
      // made up.
      include: ["web_search_call.action.sources"],
      text: {
        format: {
          type: "json_schema",
          name: call.schemaName,
          strict: true,
          schema: call.schema as Record<string, unknown>,
        },
      },
      // Nothing here is a multi-turn conversation, and the brainstorm belongs
      // to the people having it: no reason to leave it on someone's server.
      store: false,
    });

    const { text, citations, searchedUrls, searched } = readGrounded(response);
    const reasoning = response.usage?.output_tokens_details?.reasoning_tokens;
    this.logger.log(
      `[model] ${call.label}: ${response.status ?? "no status"}` +
        `, ${response.usage?.output_tokens ?? 0} output tokens` +
        (reasoning === undefined ? "" : ` (${reasoning} reasoning)`) +
        `, ${searched ? `${searchedUrls.length} page(s) searched` : "no search"}` +
        `, ${citations.length} annotated citation(s)`,
    );
    this.reportUsage(call.label, {
      input: response.usage?.input_tokens,
      output: response.usage?.output_tokens,
      reasoning,
    });

    // The Responses API's version of running out of budget: a 200, a status of
    // `incomplete`, and whatever text had been produced so far.
    if (response.status !== undefined && response.status !== "completed") {
      const why = response.incomplete_details?.reason ?? response.error?.message ?? "no detail";
      throw new ModelCallError(
        `${call.label}: the response came back ${response.status} (${why})` +
          `; raise maxTokens above ${call.maxTokens ?? DEFAULT_MAX_TOKENS} if it ran out of room`,
      );
    }
    if (text.trim() === "") {
      throw new ModelCallError(`${call.label}: the model returned no text`);
    }
    try {
      return { value: JSON.parse(text) as unknown, citations, searchedUrls, searched };
    } catch (error) {
      throw new ModelCallError(
        `${call.label}: the model's reply was not JSON (${error instanceof Error ? error.message : String(error)}): ${text.slice(0, 200)}`,
      );
    }
  }

  /**
   * The prose call, which is a loop whenever there are function tools.
   *
   * A round is one streamed response. If the model finished it by calling a
   * tool, its handler runs and the result goes back as a `function_call_output`
   * — because a round that ends in a tool call carries **no answer at all**,
   * only the model's own narration (measured against the real API; see
   * `fixtures/events/NOTES.md`). So the answer comes from the first round that
   * ends without one.
   */
  async prose(call: ProseCall): Promise<ProseReply> {
    const tools = call.functions ?? [];
    const rounds = tools.length === 0 ? 1 : PROSE_MAX_ROUNDS;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    // Only the user message, the tool calls and their results are resent: the
    // model's reasoning and narration items are its own working, and the
    // follow-up turn needs neither (measured).
    const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content: call.user }];
    const citations = new Map<string, Citation>();
    const searchedUrls: string[] = [];
    let searched = false;
    let functionCalls = 0;

    for (let round = 1; round <= rounds; round += 1) {
      const response = await this.streamProse(call, input, tools);
      const output = readGrounded(response);
      for (const citation of output.citations) {
        if (!citations.has(citation.url)) citations.set(citation.url, citation);
      }
      for (const url of output.searchedUrls) {
        if (!searchedUrls.includes(url)) searchedUrls.push(url);
      }
      searched = searched || output.searched;

      const calls = (response.output ?? []).filter(
        (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call",
      );
      this.logger.log(
        `[model] ${call.label}: ${response.status ?? "no status"}` +
          ` (round ${round}/${rounds})` +
          `, ${response.usage?.output_tokens ?? 0} output tokens` +
          reasoningNote(response) +
          `, ${output.searched ? `${output.searchedUrls.length} page(s) searched` : "no search"}` +
          `, ${output.citations.length} annotated citation(s)` +
          `, ${calls.length} tool call(s)`,
      );
      this.reportUsage(call.label, {
        input: response.usage?.input_tokens,
        output: response.usage?.output_tokens,
        reasoning: response.usage?.output_tokens_details?.reasoning_tokens,
      });

      if (response.status !== undefined && response.status !== "completed") {
        const why = response.incomplete_details?.reason ?? response.error?.message ?? "no detail";
        throw new ModelCallError(
          `${call.label}: the response came back ${response.status} (${why})` +
            `; raise maxTokens above ${call.maxTokens ?? DEFAULT_MAX_TOKENS} if it ran out of room`,
        );
      }

      if (calls.length === 0) {
        if (output.text.trim() === "") {
          throw new ModelCallError(`${call.label}: the model returned no text`);
        }
        return {
          text: output.text,
          citations: [...citations.values()],
          searchedUrls,
          searched,
          functionCalls,
        };
      }

      for (const made of calls) {
        functionCalls += 1;
        input.push(made);
        input.push({
          type: "function_call_output",
          call_id: made.call_id,
          output: await this.runFunction(call.label, byName, made),
        });
      }
    }

    throw new ModelCallError(
      `${call.label}: the model called a tool on all ${rounds} rounds and never wrote an answer`,
    );
  }

  /** One streamed response, with {@link ProseCall.onText} fed as it arrives. */
  private async streamProse(
    call: ProseCall,
    input: readonly OpenAI.Responses.ResponseInputItem[],
    functions: readonly FunctionTool[],
  ): Promise<OpenAI.Responses.Response> {
    const stream = await this.streamingResponses.create({
      model: this.model,
      instructions: call.system,
      input: [...input],
      max_output_tokens: call.maxTokens ?? DEFAULT_MAX_TOKENS,
      tools: [
        { type: "web_search", search_context_size: call.searchContextSize ?? "medium" },
        // Confirmed against the real API: `web_search` and a function tool in
        // one request are accepted, so the PRD's intent-routing fallback is
        // not needed (`fixtures/events/NOTES.md`).
        ...functions.map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          strict: true,
          parameters: tool.parameters as Record<string, unknown>,
        })),
      ],
      include: ["web_search_call.action.sources"],
      store: false,
      stream: true,
    });

    let response: OpenAI.Responses.Response | undefined;
    let failure: string | undefined;
    let itemId = "";
    let item = "";
    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          // A new item starts the text again: the model narrates in items of
          // its own before it writes the answer.
          if (event.item_id !== itemId) {
            itemId = event.item_id;
            item = "";
          }
          item += event.delta;
          call.onText?.({ itemId, text: item });
          break;
        case "response.completed":
        case "response.incomplete":
        case "response.failed":
          response = event.response;
          break;
        case "error":
          // The stream can carry a failure instead of ending: keep the first,
          // which is the one that explains the rest.
          failure ??= event.message;
          break;
        default:
          break;
      }
    }

    if (response === undefined) {
      throw new ModelCallError(
        `${call.label}: the stream ended without a response (${failure ?? "no detail"})`,
      );
    }
    return response;
  }

  /**
   * Runs one tool call and returns the line the model is told about it.
   *
   * Nothing here throws. A tool the model invented, arguments that are not
   * JSON and a handler that failed are all things to tell the model in words,
   * because it can still answer in sentences — losing the whole answer
   * because a diagram did not render would be the worse outcome.
   */
  private async runFunction(
    label: string,
    tools: ReadonlyMap<string, FunctionTool>,
    made: OpenAI.Responses.ResponseFunctionToolCall,
  ): Promise<string> {
    const tool = tools.get(made.name);
    if (tool === undefined) {
      this.logger.warn(`[model] ${label}: the model called an unknown tool ${made.name}`);
      return `There is no tool called ${made.name}. Answer in words instead.`;
    }
    let args: unknown;
    try {
      args = JSON.parse(made.arguments === "" ? "{}" : made.arguments) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[model] ${label}: ${made.name} arguments were not JSON (${detail})`);
      return `Those arguments were not valid JSON (${detail}). Answer in words instead.`;
    }
    try {
      return await tool.run(args);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[model] ${label}: ${made.name} failed (${detail})`);
      return `${made.name} failed (${detail}). Answer in words instead.`;
    }
  }
}

/** `, 962 reasoning` for a log line, or nothing when the API did not say. */
function reasoningNote(response: OpenAI.Responses.Response): string {
  const reasoning = response.usage?.output_tokens_details?.reasoning_tokens;
  return reasoning === undefined ? "" : ` (${reasoning} reasoning)`;
}

/** What {@link readGrounded} finds in a response's `output` list. */
export interface GroundedOutput {
  /** The structured reply itself, without the narration around it. */
  text: string;
  citations: Citation[];
  searchedUrls: string[];
  searched: boolean;
}

/**
 * Reads a grounded response's `output` list.
 *
 * Two things about that list are worth knowing, both measured against the
 * real API rather than read in the docs (`CLAUDE.md`):
 *
 *   - **The model narrates while it works.** A single response holds several
 *     `message` items — "I'll search for that", "the results point to 2010" —
 *     interleaved with `web_search_call`s, and the structured reply is the
 *     *last* one. Concatenating them all, as `response.output_text` does,
 *     produces prose with JSON stuck on the end.
 *   - **A JSON reply carries no annotations.** `url_citation` annotations are
 *     character ranges into the model's prose, so a reply that is pure JSON
 *     has none. The URLs the search touched are the fallback, which is why
 *     `include: ["web_search_call.action.sources"]` is on the request.
 */
export function readGrounded(response: OpenAI.Responses.Response): GroundedOutput {
  // Deduplicated by URL: one page cited three times is one source.
  const byUrl = new Map<string, Citation>();
  const searchedUrls: string[] = [];
  const texts: string[] = [];
  let searched = false;
  for (const item of response.output ?? []) {
    if (item.type === "web_search_call") {
      searched = true;
      for (const url of searchUrls(item)) {
        if (!searchedUrls.includes(url)) searchedUrls.push(url);
      }
      continue;
    }
    if (item.type !== "message") continue;
    for (const block of item.content) {
      if (block.type !== "output_text") continue;
      texts.push(block.text);
      for (const annotation of block.annotations ?? []) {
        if (annotation.type !== "url_citation") continue;
        const url = annotation.url.trim();
        if (url === "" || byUrl.has(url)) continue;
        byUrl.set(url, { url, title: citationTitle(annotation.title, url) });
      }
    }
  }
  return {
    text: structuredReply(texts),
    citations: [...byUrl.values()],
    searchedUrls,
    searched,
  };
}

/**
 * The structured reply among the model's messages: the last one that looks
 * like JSON, or failing that the last one at all, so a failure message shows
 * what did come back.
 */
function structuredReply(texts: readonly string[]): string {
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = (texts[index] ?? "").trim();
    if (text.startsWith("{") || text.startsWith("[")) return text;
  }
  return texts[texts.length - 1] ?? "";
}

/** The URLs one search call returned, searched or opened. */
function searchUrls(call: OpenAI.Responses.ResponseFunctionWebSearch): string[] {
  const action = call.action;
  if (action.type === "search") return (action.sources ?? []).map((source) => source.url);
  if (action.type === "open_page" || action.type === "find_in_page") {
    return action.url === null || action.url === undefined ? [] : [action.url];
  }
  return [];
}

/** A source needs a name on the card, so an untitled page falls back to its host. */
export function citationTitle(title: string | undefined, url: string): string {
  const named = (title ?? "").trim();
  if (named !== "") return named;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
