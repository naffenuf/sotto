/**
 * Which model Sotto's judgment calls go to (V2-010).
 *
 * A judgment call is short, private and nobody's asked for it out loud — the
 * research gate (V2-012) is the first one — so it belongs on Muse Glimmer,
 * running on this Mac. But Glimmer is an optional local server: it can be
 * unconfigured, not running, or serving some other model. So every role asks
 * this router for a client rather than constructing one, and gets Muse Spark
 * instead when the local one is not there. There is one router per session and
 * the choice is made once, at session start, which is also what the
 * "judgment: local / cloud" dot in the header is reporting.
 *
 * The fallback is not an error path: a session with no Glimmer judges in the
 * cloud and loses nothing but privacy and the cost of the call. A session with
 * neither — no `GLIMMER_BASE_URL` and no `MODEL_API_KEY` — has no judgment at
 * all, and {@link JudgmentRouter.client} answers `null`, the same way the rest
 * of the pipeline treats a missing model.
 */
import type { ModelClient, StructuredCall } from "./client.js";
import type { GlimmerClient } from "./GlimmerClient.js";

/** Where a judgment call ran. What the dot shows. */
export type JudgmentWhere = "local" | "cloud";

/** What a judgment role needs: one structured call, and where it will run. */
export interface JudgmentClient {
  /** `local` for Glimmer on this Mac, `cloud` for Muse Spark. */
  readonly where: JudgmentWhere;
  /**
   * Returns the reply parsed as JSON, for the caller to validate with zod.
   *
   * @throws {ModelCallError} when the reply was truncated, empty or not JSON.
   */
  structured(call: StructuredCall): Promise<unknown>;
}

type Logger = Pick<Console, "log" | "warn">;

/** Muse Spark, wearing the judgment interface. */
export function cloudJudgment(model: ModelClient): JudgmentClient {
  return {
    where: "cloud",
    structured: (call) => model.structured(call),
  };
}

/** Glimmer, wearing the judgment interface. */
export function localJudgment(glimmer: GlimmerClient): JudgmentClient {
  return {
    where: "local",
    structured: (call) => glimmer.structured(call),
  };
}

export interface JudgmentRouterOptions {
  /** Glimmer, or `null` when `GLIMMER_BASE_URL` is unset. */
  glimmer?: GlimmerClient | null;
  /** Muse Spark: what a judgment call falls back to. `null` with no API key. */
  spark?: ModelClient | null;
  logger?: Logger;
  /**
   * Told which way the check went, and why, so the session can push the
   * header's judgment dot. Called once, when {@link JudgmentRouter.check}
   * settles, and never after {@link JudgmentRouter.stop}.
   */
  onWhere?: (where: JudgmentWhere | null, detail: string) => void;
  /** Passed to {@link GlimmerClient.health}. */
  healthTimeoutMs?: number;
  /** False to skip paying Glimmer's cold load at session start. */
  warm?: boolean;
}

export class JudgmentRouter {
  private readonly glimmer: GlimmerClient | null;
  private readonly spark: ModelClient | null;
  private readonly logger: Logger;
  private readonly options: JudgmentRouterOptions;
  /** The check, once started. Awaited by every caller of {@link client}. */
  private checking: Promise<JudgmentClient | null> | undefined;
  private chosen: JudgmentClient | null = null;
  private stopped = false;

  constructor(options: JudgmentRouterOptions = {}) {
    this.options = options;
    this.glimmer = options.glimmer ?? null;
    this.spark = options.spark ?? null;
    this.logger = options.logger ?? console;
  }

  /**
   * Starts the health check and returns immediately. Safe to call twice: the
   * second call joins the first.
   *
   * Nothing registers this with {@link Clock.track}. The check is a real-time
   * request to a local server, and a `max`-speed replay has no reason to stand
   * still for it — the roles that need the answer await {@link client}, which
   * is where the waiting belongs.
   */
  check(): Promise<JudgmentClient | null> {
    return (this.checking ??= this.resolve());
  }

  /**
   * The client a judgment role should use, once the check has settled, or
   * `null` when there is no model at all. Starts the check if nothing has.
   */
  async client(): Promise<JudgmentClient | null> {
    return await this.check();
  }

  /** Where judgment is running, or `null` before the check settles. */
  where(): JudgmentWhere | null {
    return this.chosen?.where ?? null;
  }

  /** Stops reporting: a check that lands after the session ended says nothing. */
  stop(): void {
    this.stopped = true;
  }

  private async resolve(): Promise<JudgmentClient | null> {
    const fallback = this.spark === null ? null : cloudJudgment(this.spark);
    if (this.glimmer === null) {
      this.settle(
        fallback,
        fallback === null
          ? "no GLIMMER_BASE_URL and no MODEL_API_KEY: nothing to judge with"
          : "GLIMMER_BASE_URL is not set; judging with Muse Spark",
      );
      return fallback;
    }
    const health = await this.glimmer.health(this.options.healthTimeoutMs);
    if (!health.ok) {
      // A warning, not an error: the session runs, it just runs in the cloud.
      this.logger.warn(
        `[judgment] Glimmer is unavailable — ${health.detail}. ` +
          (fallback === null
            ? "No MODEL_API_KEY either, so judgment calls are off."
            : "Falling back to Muse Spark for every judgment call."),
      );
      this.settle(fallback, health.detail);
      return fallback;
    }
    if (this.options.warm !== false) this.glimmer.warm();
    const local = localJudgment(this.glimmer);
    this.settle(local, `${health.detail} (${health.latencyMs} ms)`);
    return local;
  }

  private settle(client: JudgmentClient | null, detail: string): void {
    this.chosen = client;
    if (this.stopped) return;
    this.logger.log(`[judgment] ${client?.where ?? "none"}: ${detail}`);
    this.options.onWhere?.(client?.where ?? null, detail);
  }
}
