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
 */
export const DEFAULT_MAX_TOKENS = 4_096;

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

  private openai(): OpenAI {
    return (this.sdk ??= new OpenAI({
      apiKey: this.options.apiKey ?? "",
      baseURL: MODEL_BASE_URL,
    }));
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
