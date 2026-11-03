/**
 * Everything the server pushes to the browser over `/ws/events`, as one union.
 *
 * The server publishes to an in-process bus (`server/events/bus.ts`) and each
 * attached socket gets the events as JSON lines. A socket that attaches part
 * way through a session is caught up first with the bus's remembered state
 * (the four statuses, the running session, the speaker names, the board, the
 * settings, whether somebody is addressing Sotto, what it is holding back,
 * and every card it has put up), so the UI never has to poll.
 */
import type { SuppressedCandidate } from "./candidates.js";
import type { TurnUpdate } from "./turns.js";
import type { SessionInfo, SessionSettings } from "./session.js";
import type { Board } from "./board.js";
import type { StageCard } from "./cards.js";
import type { VoiceState } from "./voice.js";

/**
 * The four things the header shows a dot for.
 *
 * - `server`: this server is up and the events socket is attached.
 * - `transcription`: turns are arriving — from the realtime API for a `wav` or
 *   `mic` session, or from a capture being replayed for an `events` one.
 * - `model`: a model client is configured, so the board, observer and answers
 *   (US-009 onwards) can call Muse Spark. `connecting` means a call is in
 *   flight — a board update, say — not that the client is still starting up.
 * - `judgment`: where the short, private judgment calls are running (V2-010).
 *   `connecting` while the session is checking, then `active` with a `detail`
 *   of `local` (Muse Glimmer on this Mac) or `cloud` (Muse Spark, because
 *   Glimmer is not there). Both are working states, which is why the detail
 *   rather than the state is what the dot reads out.
 */
export const statusChannels = ["server", "transcription", "model", "judgment"] as const;

/**
 * The `transcription` dot's detail while a `mic` session's audio socket has
 * dropped and the session is holding on for it. A page that loads and finds
 * this takes it as its cue to dial the microphone back in.
 */
export const MIC_AWAY_DETAIL = "waiting for the microphone to come back";
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

/**
 * The display names the user has given diarization labels (US-007).
 *
 * A label with no name is simply absent, so a reader falls back to the bare
 * label. The whole map goes out on every change, which is also what a newly
 * attached socket is caught up with.
 */
export type SpeakerNames = Readonly<Record<string, string>>;

/** A speaker was named, or had its name cleared. */
export interface SpeakersEvent {
  type: "speakers";
  speakers: SpeakerNames;
}

/**
 * The board after an update (US-009).
 *
 * The whole board goes out every time, because it is small and because the
 * browser must never have to replay operations to stay in step; `changedIds`
 * is what the board panel (US-010) highlights.
 */
export interface BoardEvent {
  type: "board";
  board: Board;
  /** Ids of the items the latest update added or changed. */
  changedIds: string[];
  /** When the update was applied, on the session clock. */
  updatedAtMs: number;
}

/**
 * The settings as the server now holds them (V2-017's frequency and
 * boldness, and the voice mute).
 *
 * The setting belongs to the server rather than to one browser tab — the
 * policy reads it, and `session.json` records it — so the header shows what
 * came back on this event rather than what it last clicked.
 */
export interface SettingsEvent {
  type: "settings";
  settings: SessionSettings;
}

/**
 * A card for the stage (US-011): an interjection, a glow, or an answer.
 *
 * The whole card goes out every time, and a card with an id that has already
 * been seen *replaces* the one on the stage rather than joining it — which is
 * how a card arrives in pieces (`thinking`, then a headline, then the detail)
 * without the stage growing three of them.
 */
export interface CardEvent {
  type: "card";
  card: StageCard;
}

/**
 * Whether somebody is in the middle of addressing Sotto by name (US-017).
 *
 * It goes up on the *partial* turn that first matches the wake phrase — the
 * question is still being asked — and down when that turn goes final, which
 * is when the question itself is handed to the answer agent (US-018). A turn
 * that stops matching as the speaker says more takes it down again, so
 * "sotto voce" raises it for no longer than it takes to hear the next word.
 *
 * V3-014 adds the second way it goes up: for a few seconds after Sotto has
 * answered, the room can carry on without the name, and the indicator says so
 * in its own style. `listening` is true for either, so anything that only
 * wants to know whether Sotto is paying attention reads one field;
 * `inConversation` is what makes the two look different.
 */
export interface WakeEvent {
  type: "wake";
  listening: boolean;
  /** V3-014: the follow-up window is open, so no wake word is needed. */
  inConversation?: boolean;
}

/**
 * Whether Sotto is speaking (V2-004): up when an utterance opens, `playing`
 * once the page reports sound, and down when the page has played it out or
 * somebody stopped it. What the stage's speaking indicator and Stop show.
 */
export interface VoiceEvent {
  type: "voice";
  voice: VoiceState;
}

/**
 * What the policy has held back this session (V3-016).
 *
 * The same list `digest.md`'s "What Sotto almost said" is rendered from, sent
 * as it changes so the stage can show restraint while the conversation is
 * still going. The whole list goes out every time, like the board's and the
 * speakers': it is short, and a browser must never have to accumulate it.
 */
export interface SuppressedEvent {
  type: "suppressed";
  suppressed: SuppressedCandidate[];
}

/**
 * One line Sotto has written and is waiting for a gap to say (V3-004,
 * V3-015, V3-008, V3-013, V3-005): the stage's "waiting for a gap" state.
 */
export interface WaitingLine {
  /** Which kind of line, as `timing.jsonl` names them. */
  kind: string;
  /** The sentence, as it would be said. */
  text: string;
  /** When it started waiting, on the session clock. */
  sinceMs: number;
  /** The room asked for this one (V3-017), so it waits only its turn. */
  asked?: boolean;
}

/**
 * Everything Sotto has ready to say and has not said yet, in queue order
 * (first is the next to be said). The whole list every time, like the
 * speakers' and the suppressed list: it is short and a browser must never
 * have to accumulate it. Empty the moment the line is handed to the voice —
 * what is being *said* is the `voice` event's.
 */
export interface WaitingEvent {
  type: "waiting";
  lines: WaitingLine[];
}

/** A session started (`session`) or ended (`null`). */
export interface SessionEvent {
  type: "session";
  session: SessionInfo | null;
}

/** Everything `/ws/events` sends. Narrow on `type`. */
export type ServerEvent =
  | StatusEvent
  | TurnEvent
  | SessionEvent
  | SpeakersEvent
  | BoardEvent
  | SettingsEvent
  | CardEvent
  | WakeEvent
  | VoiceEvent
  | WaitingEvent
  | SuppressedEvent;
