/**
 * Muse Glimmer, running on this Mac: the seam for judgment calls that should
 * be fast, free and private (V2-010).
 *
 * It is the same shape as {@link MuseClient.structured} — a system prompt, a
 * rendered request, a JSON Schema, and the caller validates with zod — so a
 * role can be handed either client and not care which answered. Everything
 * below comes from measuring the real endpoint rather than from the docs:
 *
 *   - **The schema constrains the tokens; it does not brief the model.**
 *     Ollama turns the JSON Schema into a grammar, so the reply always has
 *     the right keys and types, and the model never sees a word of it — a
 *     probe whose properties were described as `"0-1"` came back
 *     `{"useful": 8, "unknown": 2, "answerable": 9}` while its own reasoning
 *     said "No schema given". So ranges, limits and units belong in the
 *     prompt. On Meta's strict structured output they can live in both.
 *   - **Reasoning level decides everything.** `reasoning_effort: "low"` is
 *     the default here: the model's default (high) spends ~35 s on a short
 *     gate prompt, and turning thinking off is 2–3 s but returns noisy or
 *     all-zero scores and leaks `<|eot|>` into the content (stripped below
 *     anyway, since a leak would otherwise be a `JSON.parse` failure).
 *   - **It unloads itself.** Ollama drops the model after five idle minutes
 *     and the first call after that takes ~44 s, so every request carries
 *     `keep_alive` — a field the OpenAI-compatible endpoint is not supposed
 *     to have and honours anyway (measured: `/api/ps` moved its `expires_at`
 *     thirty minutes out). {@link GlimmerClient.warm} exists to pay that
 *     first load before anybody is waiting on a verdict.
 *   - **No temperature.** Meta's docs say Glimmer must not run greedy, so
 *     nothing here sends `temperature`, which would otherwise be the obvious
 *     thing to pin at 0 for a judgment call.
 */
import OpenAI from "openai";
import { loadGlimmerConfig } from "../config.js";
import type { StructuredCall } from "./client.js";
import { ModelCallError } from "./client.js";
import { systemClock, type Clock } from "../clock.js";

/**
 * How long Ollama is asked to keep the model in memory after a call. Longer
 * than the five minutes it would otherwise wait, because a conversation can
 * easily go that long between judgment calls and a reload costs ~44 s.
 */
export const GLIMMER_KEEP_ALIVE = "30m";

/**
 * Completion budget for a judgment call. Unlike Muse Spark's, this is a *time*
 * budget rather than a cost one — the M1 Max generates about 13 tokens a
 * second — so it is sized for a short structured verdict with room to think,
 * not for the worst thinking imaginable. Measured on a four-score gate:
 * 180 completion tokens.
 */
export const GLIMMER_MAX_TOKENS = 2_048;

/** How long a reachability check waits before calling Glimmer absent. */
export const GLIMMER_HEALTH_TIMEOUT_MS = 3_000;

/** How long {@link GlimmerClient.warm} allows for a cold load (~44 s measured). */
export const GLIMMER_WARM_TIMEOUT_MS = 90_000;

/**
 * The marker a Glimmer build leaks into `content` when thinking is off. It is
 * never asked for here, but a stray one would turn a good reply into a
 * `JSON.parse` failure, so it is stripped rather than guarded against.
 */
const EOT = "<|eot|>";

type Logger = Pick<Console, "log" | "warn">;

/**
 * One chat-completions request, plus the one field Ollama adds. `keep_alive`
 * is not in the OpenAI schema, so it needs saying here for the body to
 * typecheck; the SDK passes unknown keys through untouched.
 */
export type GlimmerRequest =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    keep_alive?: string;
  };

/** The slice of the OpenAI SDK a Glimmer call uses. A test substitutes it. */
export interface GlimmerCompletions {
  create(
    body: GlimmerRequest,
    options?: { signal: AbortSignal },
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
}

/** The slice of the SDK the reachability check uses. */
export interface GlimmerModels {
  list(options?: { signal: AbortSignal }): Promise<{ data: { id: string }[] }>;
}

export interface GlimmerClientOptions {
  /** `GLIMMER_BASE_URL`, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  /** `GLIMMER_MODEL`, e.g. `muse-glimmer:30b-q4_K_M`. */
  model: string;
  logger?: Logger;
  /**
   * Real time, for the latency a judgment call took. The injected session
   * `Clock` cannot answer that: a `max`-speed replay's clock does not move
   * while a call is in flight.
   */
  wallClock?: Clock;
  /** Seam for tests: the completions endpoint to call instead of the real one. */
  completions?: GlimmerCompletions;
  /** Seam for tests: the models endpoint the reachability check asks. */
  models?: GlimmerModels;
}

/** What {@link GlimmerClient.health} found. */
export interface GlimmerHealth {
  /** True when the endpoint answered and is serving {@link GlimmerClientOptions.model}. */
  ok: boolean;
  /** How long the check took, in milliseconds of real time. */
  latencyMs: number;
  /** One short line for a log or a tooltip. */
  detail: string;
}

export class GlimmerClient {
  readonly model: string;
  readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly wallClock: Clock;
  private readonly options: GlimmerClientOptions;
  /** Built on first use: the SDK refuses an empty key, and tests have none. */
  private sdk: OpenAI | undefined;

  constructor(options: GlimmerClientOptions) {
    this.options = options;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.logger = options.logger ?? console;
    this.wallClock = options.wallClock ?? systemClock;
  }

  private get completions(): GlimmerCompletions {
    return this.options.completions ?? this.openai().chat.completions;
  }

  private get models(): GlimmerModels {
    return this.options.models ?? this.openai().models;
  }

  private openai(): OpenAI {
    // A local server needs no credential, but the SDK insists on a string.
    return (this.sdk ??= new OpenAI({ apiKey: "local", baseURL: this.baseUrl }));
  }

  /**
   * Returns the reply parsed as JSON, for the caller to validate.
   *
   * @throws {ModelCallError} when the call came back truncated, empty, or not
   * as JSON. Transport failures — which for a local server means "it is not
   * running" — arrive as whatever the SDK threw.
   */
  async structured(call: StructuredCall): Promise<unknown> {
    const startedAt = this.wallClock.now();
    const body: GlimmerRequest = {
      model: this.model,
      max_tokens: call.maxTokens ?? GLIMMER_MAX_TOKENS,
      // Not the model's default (high), which spends ~35 s on a short prompt.
      reasoning_effort: call.reasoningEffort ?? "low",
      keep_alive: GLIMMER_KEEP_ALIVE,
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
    };
    const completion = await this.completions.create(
      body,
      call.signal === undefined ? undefined : { signal: call.signal },
    );

    const elapsed = Math.round(this.wallClock.now() - startedAt);
    const choice = completion.choices[0];
    this.logger.log(
      `[glimmer] ${call.label}: ${choice?.finish_reason ?? "no choice"}` +
        `, ${completion.usage?.completion_tokens ?? 0} completion tokens, ${elapsed} ms`,
    );

    if (choice === undefined) {
      throw new ModelCallError(`${call.label}: Glimmer returned no choices`);
    }
    // Same trap as Muse Spark: a reasoning model that runs out of budget
    // stops with "length", hands back nothing, and reports a 200.
    if (choice.finish_reason !== "stop") {
      throw new ModelCallError(
        `${call.label}: Glimmer stopped with finish_reason ${JSON.stringify(choice.finish_reason)}` +
          `; raise maxTokens above ${call.maxTokens ?? GLIMMER_MAX_TOKENS}`,
      );
    }
    const content = (choice.message.content ?? "").split(EOT).join("").trim();
    if (content === "") {
      throw new ModelCallError(`${call.label}: Glimmer returned empty content`);
    }
    try {
      return JSON.parse(content) as unknown;
    } catch (error) {
      throw new ModelCallError(
        `${call.label}: Glimmer's reply was not JSON (${error instanceof Error ? error.message : String(error)}): ${content.slice(0, 200)}`,
      );
    }
  }

  /**
   * Is Glimmer there, and is it serving the configured model?
   *
   * Deliberately a model listing rather than a trivial structured request:
   * this runs at session start, and a cold structured request is ~44 s of a
   * group waiting to see which way the judgment dot went. `ralph/preflight.sh`
   * is where a real structured request is checked, because a preflight can
   * afford to wait. Never throws — a check that failed is an answer.
   */
  async health(timeoutMs = GLIMMER_HEALTH_TIMEOUT_MS): Promise<GlimmerHealth> {
    const startedAt = this.wallClock.now();
    const { signal, done } = this.deadline(timeoutMs);
    try {
      const listed = await this.models.list({ signal });
      const latencyMs = Math.round(this.wallClock.now() - startedAt);
      const ids = listed.data.map((one) => one.id);
      if (!ids.includes(this.model)) {
        return {
          ok: false,
          latencyMs,
          detail:
            `${this.baseUrl} is up but is not serving ${this.model}` +
            (ids.length === 0 ? "" : ` (it has ${ids.slice(0, 5).join(", ")})`),
        };
      }
      return { ok: true, latencyMs, detail: `${this.model} at ${this.baseUrl}` };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Math.round(this.wallClock.now() - startedAt),
        detail: `${this.baseUrl} did not answer (${error instanceof Error ? error.message : String(error)})`,
      };
    } finally {
      done();
    }
  }

  /**
   * An {@link AbortSignal} that trips after `timeoutMs` of real time. `done()`
   * clears the timer, so a call that answered leaves nothing pending — the
   * reason this is a clock timer rather than `AbortSignal.timeout`.
   */
  private deadline(timeoutMs: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const cancel = this.wallClock.setTimeout(() => controller.abort(), timeoutMs);
    return { signal: controller.signal, done: cancel };
  }

  /**
   * Pays the cold load now, so the first real judgment call does not.
   *
   * Fire and forget: nothing waits for it, nothing fails because of it, and
   * it is deliberately *not* registered with {@link Clock.track} — it is a
   * real-time local request that the conversation's timeline has no business
   * waiting for.
   */
  warm(): void {
    const { signal, done } = this.deadline(GLIMMER_WARM_TIMEOUT_MS);
    void this.structured({
      label: "glimmer_warm",
      signal,
      system: "Reply with the JSON object the schema describes.",
      user: "Say that you are ready.",
      schemaName: "glimmer_warm",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ready"],
        properties: { ready: { type: "boolean" } },
      },
      maxTokens: 512,
    }).then(
      () => done(),
      (error: unknown) => {
        done();
        this.logger.warn(
          `[glimmer] warm-up failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }
}

/**
 * The Glimmer `.env` names, or `null` when it names none — the shape
 * {@link SessionManagerOptions.createGlimmer} wants. Lives here rather than in
 * `server/config.ts` so nothing that only reads configuration has to import
 * the client.
 */
export function glimmerFromEnv(logger?: Logger): GlimmerClient | null {
  const config = loadGlimmerConfig();
  if (config === null) return null;
  return new GlimmerClient({ ...config, ...(logger === undefined ? {} : { logger }) });
}
