import type {
  ApiError,
  FixtureListResponse,
  SessionSource,
  SessionStartResponse,
  SessionStopResponse,
} from "../../shared/index.js";

/** A route answered with a 4xx or 5xx; the message is meant to be shown. */
export class ApiCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { method: "GET" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const response = await fetch(url, init);
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as ApiError | null;
    throw new ApiCallError(problem?.error ?? `${url} answered ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

/** Which fixtures this checkout can replay. */
export function fetchFixtures(): Promise<FixtureListResponse> {
  return call<FixtureListResponse>("/api/fixtures");
}

export function startSession(source: SessionSource): Promise<SessionStartResponse> {
  return call<SessionStartResponse>("/api/session/start", { source });
}

export function stopSession(): Promise<SessionStopResponse> {
  return call<SessionStopResponse>("/api/session/stop", {});
}
