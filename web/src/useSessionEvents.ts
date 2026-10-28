import { useEffect, useRef, useState } from "react";
import type {
  Board,
  ServerEvent,
  SessionInfo,
  SessionSettings,
  SpeakerNames,
  StatusChannel,
  StatusUpdate,
  TurnUpdate,
} from "../../shared/index.js";
import { defaultSettings, emptyBoard } from "../../shared/index.js";

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
  /** The board as the last update left it (US-009). */
  board: Board;
  /** Ids the latest board update added or changed, for the panel to highlight. */
  boardChangedIds: string[];
  /**
   * When the board was last updated, on the session clock; `0` until the
   * first update, which is how the panel knows there has not been one.
   */
  boardUpdatedAtMs: number;
  /**
   * When that update reached the browser, by `Date.now()`; `0` until the
   * first one. The session clock cannot answer "12s ago" — it is an offset
   * into the conversation, and a `max`-speed replay runs it far ahead of the
   * wall — so the panel's freshness line reads this instead.
   *
   * A socket that attaches mid-session counts the bus's snapshot as arriving
   * now, because the event carries no wall-clock stamp to do better with.
   */
  boardReceivedAtMs: number;
  /** How many turns have gone final in this session. */
  turnCount: number;
  /**
   * The settings as the server holds them (US-014's chattiness). The header's
   * selector shows this rather than its own last click, so two tabs agree.
   */
  settings: SessionSettings;
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
  board: emptyBoard(),
  boardChangedIds: [],
  boardUpdatedAtMs: 0,
  boardReceivedAtMs: 0,
  turnCount: 0,
  settings: defaultSettings(),
};

/**
 * Follows `/ws/events`: the status dots, the running session, the turns, the
 * speaker names, the board and the settings.
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
        : {
            ...state,
            session: event.session,
            turns: [],
            speakers: {},
            board: emptyBoard(),
            boardChangedIds: [],
            boardUpdatedAtMs: 0,
            boardReceivedAtMs: 0,
            turnCount: 0,
          };
    case "speakers":
      return { ...state, speakers: event.speakers };
    case "settings":
      return { ...state, settings: event.settings };
    case "turn":
      return {
        ...state,
        turns: withTurn(state.turns, event.turn),
        turnCount: event.turn.final ? state.turnCount + 1 : state.turnCount,
      };
    case "board":
      return {
        ...state,
        board: event.board,
        boardChangedIds: event.changedIds,
        boardUpdatedAtMs: event.updatedAtMs,
        // The bus opens every socket with a board, empty and `updatedAtMs: 0`
        // when there has not been an update; that is not an update arriving.
        boardReceivedAtMs: event.updatedAtMs === 0 ? 0 : Date.now(),
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
