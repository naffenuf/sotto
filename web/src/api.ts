import type {
  ApiError,
  AskResponse,
  Chattiness,
  FeedbackResponse,
  FeedbackVerdict,
  FixtureListResponse,
  SessionSettingsResponse,
  SessionSource,
  SessionStartResponse,
  SessionStopResponse,
  SpeakerRenameResponse,
} from "../../shared/index.js";
import type { HistoryDetail, HistoryEntry } from "../../shared/history.js";

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

export function fetchHistory(): Promise<HistoryEntry[]> { return call("/api/history"); }
export function fetchDiscussion(folder: string): Promise<HistoryDetail> { return call(`/api/history/${encodeURIComponent(folder)}`); }

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

/**
 * Sets how talkative Sotto is (US-014). The server answers with the settings
 * as they now stand and pushes them to every tab, so the header follows the
 * reply rather than its own click.
 */
export function setChattiness(chattiness: Chattiness): Promise<SessionSettingsResponse> {
  return call<SessionSettingsResponse>("/api/session/settings", { chattiness });
}

export function setVoiceMuted(voiceMuted: boolean): Promise<SessionSettingsResponse> {
  return call<SessionSettingsResponse>("/api/session/settings", { voiceMuted });
}
export function stopVoice(): Promise<unknown> { return call("/api/voice/stop", {}); }

/**
 * Files the group's verdict on a card Sotto put up (US-015). Only the card id
 * goes over the wire: the server knows which candidate it was and at what
 * level it was shown.
 */
export function sendFeedback(
  cardId: string,
  verdict: FeedbackVerdict,
): Promise<FeedbackResponse> {
  return call<FeedbackResponse>("/api/feedback", { cardId, verdict });
}

/**
 * Asks Sotto a question somebody typed (US-019).
 *
 * Only the acknowledgement comes back: the answer itself arrives on
 * `/ws/events` as an answer card, thinking first and finished later, exactly
 * as a spoken question's does.
 */
export function askSotto(question: string): Promise<AskResponse> {
  return call<AskResponse>("/api/ask", { question });
}

/** Names one diarization label for the running session; `null` clears it. */
export function renameSpeaker(label: string, name: string | null): Promise<SpeakerRenameResponse> {
  return call<SpeakerRenameResponse>("/api/session/speaker", { label, name });
}
