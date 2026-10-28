/**
 * The in-process event bus: one place the pipeline publishes to, and every
 * `/ws/events` socket reads from.
 *
 * Only what the browser needs goes through here. The session folder (US-008)
 * is fed by {@link SessionManager} directly instead, because most of what it
 * saves — every raw transcription frame, 78% of them `audioProgress` — is
 * exactly what the browser must not be sent.
 *
 * It remembers the state an event implies — the three status dots, the running
 * session, the speaker names the user has given (US-007) and the board
 * (US-009) — so a browser that attaches mid-session can be caught up with
 * {@link EventBus.snapshot}
 * instead of asking. Turns are deliberately not remembered: a transcript is
 * the session folder's job, not the bus's.
 */
import { emptyBoard } from "../../shared/board.js";
import {
  statusChannels,
  type BoardEvent,
  type ServerEvent,
  type SpeakerNames,
  type StatusChannel,
  type StatusState,
  type StatusUpdate,
} from "../../shared/events.js";
import type { SessionInfo } from "../../shared/session.js";

export type EventListener = (event: ServerEvent) => void;

type Logger = Pick<Console, "warn">;

/** The board a listener is told about before anything has been said. */
function initialBoard(): BoardEvent {
  return { type: "board", board: emptyBoard(), changedIds: [], updatedAtMs: 0 };
}

/** Where each dot starts: the server is up, nothing else is happening. */
function initialStatuses(): Record<StatusChannel, StatusUpdate> {
  return {
    server: { channel: "server", state: "active" },
    transcription: { channel: "transcription", state: "idle" },
    model: { channel: "model", state: "idle" },
  };
}

export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly statuses = initialStatuses();
  private readonly logger: Logger;
  private session: SessionInfo | null = null;
  private speakers: SpeakerNames = {};
  private board: BoardEvent = initialBoard();

  constructor(logger: Logger = console) {
    this.logger = logger;
  }

  /**
   * Sends `event` to every listener, after folding it into the remembered
   * state. A listener that throws is logged and skipped: one broken socket
   * must not stop the pipeline.
   */
  publish(event: ServerEvent): void {
    if (event.type === "status") this.statuses[event.status.channel] = event.status;
    if (event.type === "speakers") this.speakers = event.speakers;
    if (event.type === "board") this.board = event;
    if (event.type === "session") {
      this.session = event.session;
      // Diarization labels belong to one session, so the names do too; a
      // listener clears its own on the same event.
      this.speakers = {};
      // The board is cleared by a session *starting*, not by one ending: the
      // last update of a replay is published after the session has gone, and
      // a finished board is the thing you most want still on the screen.
      if (event.session !== null) this.board = initialBoard();
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn(`[bus] listener threw on ${event.type}: ${String(error)}`);
      }
    }
  }

  /** Publishes a status change, skipping it when nothing actually changed. */
  setStatus(channel: StatusChannel, state: StatusState, detail?: string): void {
    const current = this.statuses[channel];
    if (current.state === state && current.detail === detail) return;
    this.publish({
      type: "status",
      status: detail === undefined ? { channel, state } : { channel, state, detail },
    });
  }

  /** Publishes the session that is now running, or `null` when it ends. */
  setSession(session: SessionInfo | null): void {
    this.publish({ type: "session", session });
  }

  /**
   * Publishes the display name for one diarization label, or clears it with
   * `null` or a blank name (US-007).
   */
  setSpeakerName(label: string, name: string | null): void {
    const next = { ...this.speakers };
    const display = name === null ? "" : name.trim();
    if (display === "") delete next[label];
    else next[label] = display;
    this.publish({ type: "speakers", speakers: next });
  }

  /** The events a newly attached listener needs to be up to date. */
  snapshot(): ServerEvent[] {
    return [
      ...statusChannels.map((channel): ServerEvent => ({
        type: "status",
        status: this.statuses[channel],
      })),
      { type: "session", session: this.session },
      { type: "speakers", speakers: this.speakers },
      this.board,
    ];
  }

  /** Current state of one dot. */
  status(channel: StatusChannel): StatusUpdate {
    return this.statuses[channel];
  }

  /** The running session, or `null`. */
  currentSession(): SessionInfo | null {
    return this.session;
  }

  /** The board as the last update left it. */
  boardState(): BoardEvent {
    return this.board;
  }

  /** The names given to diarization labels so far. */
  speakerNames(): SpeakerNames {
    return this.speakers;
  }

  /** Attaches a listener; call the returned function to detach it. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** How many listeners are attached. */
  get listenerCount(): number {
    return this.listeners.size;
  }
}
