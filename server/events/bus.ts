/**
 * The in-process event bus: one place the pipeline publishes to, and every
 * `/ws/events` socket reads from.
 *
 * Only what the browser needs goes through here. The session folder (US-008)
 * is fed by {@link SessionManager} directly instead, because most of what it
 * saves — every raw transcription frame, 78% of them `audioProgress` — is
 * exactly what the browser must not be sent.
 *
 * It remembers the state an event implies — the four status dots, the running
 * session, the speaker names the user has given (US-007), the board (US-009),
 * the settings (US-014), whether somebody is addressing Sotto by name
 * (US-017), what the policy has held back (V3-016) and the cards Sotto has put
 * on the stage (US-015) — so a browser that attaches mid-session can be caught
 * up with {@link EventBus.snapshot} instead of asking. Turns are deliberately not
 * remembered: a transcript is the session folder's job, not the bus's. A card
 * is the opposite case — there are a handful of them in a conversation and
 * each one is the whole point of the app, so a reload must not lose them.
 */
import { emptyBoard } from "../../shared/board.js";
import type { SuppressedCandidate } from "../../shared/candidates.js";
import type { StageCard } from "../../shared/cards.js";
import {
  statusChannels,
  type BoardEvent,
  type ServerEvent,
  type SpeakerNames,
  type StatusChannel,
  type StatusState,
  type StatusUpdate,
} from "../../shared/events.js";
import { defaultSettings, type SessionInfo, type SessionSettings } from "../../shared/session.js";
import { silentVoice, type VoiceState } from "../../shared/voice.js";

export type EventListener = (event: ServerEvent) => void;

/**
 * How many cards a newly attached browser is caught up with. A conversation
 * produces a handful, not hundreds; the cap only stops a runaway loop from
 * growing the snapshot without bound.
 */
export const MAX_REMEMBERED_CARDS = 50;

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
    // Nothing is judged until a session is running, and which model will do
    // it is only known once that session has checked (V2-010).
    judgment: { channel: "judgment", state: "idle" },
  };
}

export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly statuses = initialStatuses();
  private readonly logger: Logger;
  private session: SessionInfo | null = null;
  private speakers: SpeakerNames = {};
  private board: BoardEvent = initialBoard();
  /** The cards put on the stage this session, oldest first (US-015). */
  private cards: StageCard[] = [];
  /** True while a partial turn is addressing Sotto by name (US-017). */
  private listening = false;
  /** What the policy has held back this session, best first (V3-016). */
  private suppressed: SuppressedCandidate[] = [];
  /** Server-wide, not per session: the next session inherits what is set. */
  private settings: SessionSettings = defaultSettings();
  private voice: VoiceState = silentVoice();

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
    if (event.type === "card") this.rememberCard(event.card);
    if (event.type === "settings") this.settings = event.settings;
    if (event.type === "wake") this.listening = event.listening;
    if (event.type === "suppressed") this.suppressed = event.suppressed;
    if (event.type === "voice") this.voice = event.voice;
    if (event.type === "session") {
      this.session = event.session;
      // Nobody is mid-question across the end of a session, whatever the
      // last partial said.
      this.listening = false;
      // Diarization labels belong to one session, so the names do too; a
      // listener clears its own on the same event.
      this.speakers = {};
      // The board and the cards are cleared by a session *starting*, not by
      // one ending: the last update of a replay is published after the
      // session has gone, and a finished board — or the thing Sotto noticed
      // in the last minute — is what you most want still on the screen.
      if (event.session !== null) {
        this.board = initialBoard();
        this.cards = [];
        // What was held back belongs to one conversation, unlike the cards:
        // the tray says "this session", and the policy's reasons are about
        // turns the next session will not have heard.
        this.suppressed = [];
      }
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn(`[bus] listener threw on ${event.type}: ${String(error)}`);
      }
    }
  }

  /** Puts one card on the stage, or replaces the one with the same id. */
  publishCard(card: StageCard): void {
    this.publish({ type: "card", card });
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

  /**
   * Publishes the settings as they now stand (V2-017's two). They are
   * deliberately *not* reset by a session starting: a user who turned Sotto
   * down meant it for the next conversation too.
   */
  setSettings(settings: SessionSettings): void {
    this.publish({ type: "settings", settings });
  }

  setVoice(voice: VoiceState): void { this.publish({ type: "voice", voice }); }
  voiceState(): VoiceState { return this.voice; }

  /**
   * Publishes whether somebody is in the middle of addressing Sotto by name
   * (US-017), skipping it when nothing changed — the watcher only calls on a
   * change, and this makes that a property of the bus rather than a promise.
   */
  setListening(listening: boolean): void {
    if (listening === this.listening) return;
    this.publish({ type: "wake", listening });
  }

  /**
   * Publishes what the policy has held back so far (V3-016), skipping it when
   * the list has not changed — it is recomputed from the digest on every
   * candidate line, and most of those change nothing about it.
   */
  setSuppressed(suppressed: readonly SuppressedCandidate[]): void {
    const next = [...suppressed];
    if (JSON.stringify(next) === JSON.stringify(this.suppressed)) return;
    this.publish({ type: "suppressed", suppressed: next });
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
      { type: "settings", settings: this.settings },
      { type: "wake", listening: this.listening },
      { type: "voice", voice: this.voice },
      { type: "suppressed", suppressed: [...this.suppressed] },
      // One event per card, in the order they went up, rather than a second
      // shape for "all of them": a browser folds each one in the same way it
      // folds a live arrival, and a session that has said nothing adds none.
      ...this.cards.map((card): ServerEvent => ({ type: "card", card })),
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

  /** The settings as they now stand. */
  settingsState(): SessionSettings {
    return this.settings;
  }

  /** True while somebody is addressing Sotto by name. */
  listeningState(): boolean {
    return this.listening;
  }

  /** What the policy has held back this session, best first (V3-016). */
  suppressedState(): readonly SuppressedCandidate[] {
    return this.suppressed;
  }

  /** The cards on the stage, oldest first. */
  cardState(): readonly StageCard[] {
    return this.cards;
  }

  /** The names given to diarization labels so far. */
  speakerNames(): SpeakerNames {
    return this.speakers;
  }

  /**
   * Folds one card into the remembered stage: a card whose id is already
   * there replaces it, so an answer arriving in pieces (US-018) does not
   * leave three of itself in a reloading browser's snapshot.
   */
  private rememberCard(card: StageCard): void {
    const index = this.cards.findIndex((one) => one.id === card.id);
    if (index !== -1) {
      this.cards[index] = card;
      return;
    }
    this.cards.push(card);
    if (this.cards.length > MAX_REMEMBERED_CARDS) {
      this.cards = this.cards.slice(this.cards.length - MAX_REMEMBERED_CARDS);
    }
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
