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
}

/** The slice of the OpenAI SDK a structured call uses. */
export interface ChatCompletions {
  create(
    body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
}

type Logger = Pick<Console, "log" | "warn">;

export interface MuseClientOptions {
  /** Meta Model API key. Never logged. */
  apiKey?: string;
  model?: string;
  logger?: Logger;
  /** Seam for tests: the completions endpoint to call instead of the real one. */
  completions?: ChatCompletions;
}

export class MuseClient implements ModelClient {
  private readonly model: string;
  private readonly logger: Logger;
  private readonly completions: ChatCompletions;

  constructor(options: MuseClientOptions = {}) {
    this.model = options.model ?? SPARK_MODEL;
    this.logger = options.logger ?? console;
    this.completions =
      options.completions ??
      new OpenAI({ apiKey: options.apiKey ?? "", baseURL: MODEL_BASE_URL }).chat.completions;
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
}
