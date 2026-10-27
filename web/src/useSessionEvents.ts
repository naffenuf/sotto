import { useEffect, useRef, useState } from "react";
import type { ServerEvent, SessionInfo, StatusChannel, StatusUpdate } from "../../shared/index.js";

/** How long to wait before dialling `/ws/events` again after it drops. */
const RECONNECT_MS = 2_000;

export interface SessionEventsState {
  /** True while `/ws/events` is open. */
  connected: boolean;
  /** The latest state of each dot, as the server reported it. */
  statuses: Record<StatusChannel, StatusUpdate>;
  /** The session the server is running, or `null`. */
  session: SessionInfo | null;
  /** How many turns have gone final in this session. */
  turnCount: number;
}

function idle(channel: StatusChannel): StatusUpdate {
  return { channel, state: "idle" };
}

const initial: SessionEventsState = {
  connected: false,
  statuses: { server: idle("server"), transcription: idle("transcription"), model: idle("model") },
  session: null,
  turnCount: 0,
};

/**
 * Follows `/ws/events`: the status dots, the running session and the turns.
 *
 * The server sends its remembered state the moment the socket opens, so a
 * reload mid-session catches up without asking, and a dropped socket is
 * redialled every {@link RECONNECT_MS}.
 */
export function useSessionEvents(): SessionEventsState {
  const [state, setState] = useState<SessionEventsState>(initial);
  const closed = useRef(false);

  useEffect(() => {
    closed.current = false;
    let socket: WebSocket | undefined;
    let retry: number | undefined;

    const connect = (): void => {
      if (closed.current) return;
      const url = new URL("/ws/events", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);

      socket.addEventListener("open", () => {
        setState((previous) => ({ ...previous, connected: true }));
      });

      socket.addEventListener("message", (message: MessageEvent<string>) => {
        const event = JSON.parse(message.data) as ServerEvent;
        setState((previous) => apply(previous, event));
      });

      socket.addEventListener("close", () => {
        setState((previous) => ({ ...previous, connected: false }));
        if (closed.current) return;
        retry = window.setTimeout(connect, RECONNECT_MS);
      });
    };

    connect();
    return () => {
      closed.current = true;
      if (retry !== undefined) window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return state;
}

function apply(state: SessionEventsState, event: ServerEvent): SessionEventsState {
  switch (event.type) {
    case "status":
      return { ...state, statuses: { ...state.statuses, [event.status.channel]: event.status } };
    case "session":
      // A new session starts its turn count over; the end of one keeps it.
      return {
        ...state,
        session: event.session,
        turnCount: event.session === null ? state.turnCount : 0,
      };
    case "turn":
      return event.turn.final ? { ...state, turnCount: state.turnCount + 1 } : state;
  }
}
