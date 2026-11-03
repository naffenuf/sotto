/**
 * TypeSafe's Jev: a "System One" model that answers typed questions about a
 * piece of text — pick one of these, is this true — and writes no prose.
 *
 * It is the fast per-turn read in front of Muse Spark (post-V3-011). Spark
 * reasons before it answers, and on an ambiguous turn that is six to
 * fourteen seconds and, once, the whole token budget with no answer. Jev
 * answered the same turns in 65–690 ms. So Jev decides *whether* a turn is
 * worth a Spark call (a lookup, a decision being settled, a request to
 * Sotto), and Spark still writes every word the room hears or reads. The
 * key is `TYPESAFE_API_KEY`; without it {@link jevFromEnv} is `null` and
 * every call goes to Spark as before.
 *
 * Request shape, from https://docs.typesafe.ai/api/system-one.md: `POST
 * /v1/systemone` with `{ model, state, questions }`, each question
 * `{ type: "choice" | "noul" | "score", instructions, criteria? }` under an
 * id of the caller's choosing; the reply has `answers` under the same ids.
 */

export const JEV_BASE_URL = "https://api.typesafe.ai/v1";
export const JEV_MODEL = "jev-latest";
/** A real-time deadline: measured 65–690 ms, and a slow reply is worth less than Spark. */
export const JEV_TIMEOUT_MS = 2_500;

export interface JevChoice {
  type: "choice";
  instructions: string;
  /** Option name → what it means. The model sees both. */
  criteria: Record<string, string>;
}

export interface JevNoul {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export type JevQuestion = JevChoice | JevNoul;

export interface JevRequest {
  state: string;
  questions: Record<string, JevQuestion>;
}

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** What the fast paths depend on, so a test can hand them a fake. */
export interface JevLike {
  systemOne(request: JevRequest, signal?: AbortSignal): Promise<JevResponse>;
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  logger?: Pick<Console, "warn">;
}

export class JevClient implements JevLike {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Pick<Console, "warn">;

  constructor(options: JevClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? JEV_BASE_URL;
    this.model = options.model ?? JEV_MODEL;
    this.fetchImpl = options.fetch ?? fetch;
    this.logger = options.logger ?? console;
  }

  async systemOne(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/systemone`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, state: request.state, questions: request.questions }),
      ...(signal === undefined ? {} : { signal }),
    });
    const body = (await response.json()) as JevResponse & { error?: unknown };
    if (!response.ok) {
      throw new Error(`jev: HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return body;
  }
}

/** The client, or `null` when `TYPESAFE_API_KEY` is blank: Spark alone, as before. */
export function jevFromEnv(logger?: Pick<Console, "warn">): JevClient | null {
  const apiKey = (process.env["TYPESAFE_API_KEY"] ?? "").trim();
  if (apiKey === "") return null;
  return new JevClient({ apiKey, ...(logger === undefined ? {} : { logger }) });
}

/**
 * One typed question, with the real-time deadline and never a throw: `null`
 * means "ask Spark", which is what every failure here should cost.
 */
export async function askJev(
  jev: JevLike,
  request: JevRequest,
  wallSetTimeout: (fn: () => void, ms: number) => () => void,
  signal?: AbortSignal,
): Promise<JevResponse | null> {
  const controller = new AbortController();
  const cancel = wallSetTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
  const onOuter = (): void => controller.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  try {
    return await jev.systemOne(request, controller.signal);
  } catch {
    return null;
  } finally {
    cancel();
    signal?.removeEventListener("abort", onOuter);
  }
}
