import { useEffect, useRef, useState } from "react";
import type {
  ServerEvent,
  SessionInfo,
  SpeakerNames,
  StatusChannel,
  StatusUpdate,
  TurnUpdate,
} from "../../shared/index.js";

/** How long to wait before dialling `/ws/events` again after it drops. */
const RECONNECT_MS = 2_000;

/**
 * How many turns the panel keeps. A long session would otherwise grow an
 * unbounded list of DOM rows; the whole transcript is on disk either way
 * (`transcript.md`, US-008).
 */
export const MAX_TURNS = 500;

export interface SessionEventsState {
  /** True while `/ws/events` is open. */
  connected: boolean;
  /** The latest state of each dot, as the server reported it. */
  statuses: Record<StatusChannel, StatusUpdate>;
  /** The session the server is running, or `null`. */
  session: SessionInfo | null;
  /**
   * Every turn of this session, oldest first — the newest snapshot of each,
   * since a turn arrives again on every partial and once more as `final`.
   */
  turns: TurnUpdate[];
  /** Display names the user has given diarization labels. */
  speakers: SpeakerNames;
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
  turns: [],
  speakers: {},
  turnCount: 0,
};

/**
 * Follows `/ws/events`: the status dots, the running session, the turns and
 * the speaker names.
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
      // A new session starts over; the end of one leaves its transcript up to
      // read. Diarization labels belong to a session, so the names go with it.
      return event.session === null
        ? { ...state, session: null }
        : { ...state, session: event.session, turns: [], speakers: {}, turnCount: 0 };
    case "speakers":
      return { ...state, speakers: event.speakers };
    case "turn":
      return {
        ...state,
        turns: withTurn(state.turns, event.turn),
        turnCount: event.turn.final ? state.turnCount + 1 : state.turnCount,
      };
  }
}

/**
 * Folds one snapshot into the list: a turn already there is replaced in place,
 * so a partial turning into its final text never doubles the row.
 */
function withTurn(turns: TurnUpdate[], turn: TurnUpdate): TurnUpdate[] {
  const index = turns.findIndex((existing) => existing.turnId === turn.turnId);
  if (index !== -1) {
    const next = [...turns];
    next[index] = turn;
    return next;
  }
  const next = [...turns, turn];
  return next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next;
}
