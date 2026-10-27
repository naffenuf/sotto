/**
 * Everything the server pushes to the browser over `/ws/events`, as one union.
 *
 * The server publishes to an in-process bus (`server/events/bus.ts`) and each
 * attached socket gets the events as JSON lines. A socket that attaches part
 * way through a session is caught up first with the bus's remembered state
 * (the three statuses and the running session), so the UI never has to poll.
 */
import type { TurnUpdate } from "./turns.js";
import type { SessionInfo } from "./session.js";

/**
 * The three things the header shows a dot for.
 *
 * - `server`: this server is up and the events socket is attached.
 * - `transcription`: turns are arriving — from the realtime API for a `wav` or
 *   `mic` session, or from a capture being replayed for an `events` one.
 * - `model`: a model client is configured, so the board, observer and answers
 *   (US-009 onwards) can call Muse Spark.
 */
export const statusChannels = ["server", "transcription", "model"] as const;
export type StatusChannel = (typeof statusChannels)[number];

/**
 * - `idle`: nothing wrong, nothing happening (no session running).
 * - `connecting`: on its way up — the ASR socket is opening, say.
 * - `active`: working.
 * - `error`: broken, and `detail` says how.
 */
export const statusStates = ["idle", "connecting", "active", "error"] as const;
export type StatusState = (typeof statusStates)[number];

export interface StatusUpdate {
  channel: StatusChannel;
  state: StatusState;
  /** Short human-readable reason, shown as the dot's tooltip. */
  detail?: string;
}

/** A status dot changed. */
export interface StatusEvent {
  type: "status";
  status: StatusUpdate;
}

/** A turn opened, grew, or went final. Partials arrive here too (US-007). */
export interface TurnEvent {
  type: "turn";
  turn: TurnUpdate;
}

/** A session started (`session`) or ended (`null`). */
export interface SessionEvent {
  type: "session";
  session: SessionInfo | null;
}

/** Everything `/ws/events` sends. Narrow on `type`. */
export type ServerEvent = StatusEvent | TurnEvent | SessionEvent;
