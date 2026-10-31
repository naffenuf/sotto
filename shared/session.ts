/**
 * A listening session: which input it is reading and what the API calls that
 * start and stop it look like.
 *
 * One session at a time. The three sources all end up in the same pipeline —
 * source -> turn assembler -> event bus (`server/session/SessionManager.ts`) —
 * they only differ in where the frames come from: live transcription of audio
 * (`wav`, `mic`) or a capture replayed at 1x (`events`, US-006).
 */
import { z } from "zod";
import type { SpeakerNames } from "./events.js";
import { ChattinessSchema, DEFAULT_CHATTINESS, type Chattiness } from "./policy.js";

/** Fixture names are file stems under `fixtures/`, never paths. */
const FixtureNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "fixture names are lowercase, digits and dashes");

export const SessionSourceSchema = z.discriminatedUnion("kind", [
  /** A fixture WAV replayed at real time through the live transcription API. */
  z.object({ kind: z.literal("wav"), fixture: FixtureNameSchema }),
  /** A captured event stream replayed at 1x, with no API call at all. */
  z.object({ kind: z.literal("events"), fixture: FixtureNameSchema }),
  /** The browser's microphone, over `/ws/audio` (US-012). */
  z.object({ kind: z.literal("mic") }),
]);

export type SessionSource = z.infer<typeof SessionSourceSchema>;
export type SessionSourceKind = SessionSource["kind"];

/** Body of `POST /api/session/start`. */
export const SessionStartRequestSchema = z.object({
  source: SessionSourceSchema,
});
export type SessionStartRequest = z.infer<typeof SessionStartRequestSchema>;

/** What the source is called in the UI and in session folder names (US-010). */
export function describeSource(source: SessionSource): string {
  switch (source.kind) {
    case "wav":
      return `WAV: ${source.fixture}`;
    case "events":
      return `Replay events: ${source.fixture}`;
    case "mic":
      return "Microphone";
  }
}

/** Slug for a source, used in session folder names (US-010). */
export function sourceSlug(source: SessionSource): string {
  return source.kind === "mic" ? "mic" : `${source.kind}-${source.fixture}`;
}

/** The session the server is running, as the browser sees it. */
export interface SessionInfo {
  /** Unique within this server run: `<slug>-<n>`. */
  id: string;
  source: SessionSource;
  /** Start time on the pipeline clock, which is 0 for a replay. */
  startedAtMs: number;
}

/**
 * Body of `POST /api/session/speaker`: the display name for one diarization
 * label (US-007). `null`, or anything blank, goes back to the bare label.
 */
export const SpeakerRenameRequestSchema = z.object({
  label: z.string().trim().min(1).max(40),
  name: z.string().max(40).nullable(),
});
export type SpeakerRenameRequest = z.infer<typeof SpeakerRenameRequestSchema>;

/** Response to it: the names as they now stand for the running session. */
export interface SpeakerRenameResponse {
  renamed: boolean;
  speakers: SpeakerNames;
}

/** Response to `POST /api/session/start`. */
export interface SessionStartResponse {
  session: SessionInfo;
}

/** Response to `POST /api/session/stop`. `stopped` is false if none was running. */
export interface SessionStopResponse {
  stopped: boolean;
}

/** Response to `GET /api/fixtures`: the fixture names each source kind can take. */
export interface FixtureListResponse {
  /** Fixtures with a rendered WAV in `fixtures/audio/`. */
  wav: string[];
  /** Fixtures with a captured event stream in `fixtures/events/`. */
  events: string[];
}

/**
 * Whatever the user can change about a running session, saved to
 * `session.json` so a session folder can be read back in the context it was
 * recorded in — which is what the eval harness (US-016) reports alongside its
 * numbers.
 */
export interface SessionSettings {
  /** How talkative Sotto is being (US-014), set from the header. */
  readonly chattiness: Chattiness;
  readonly voiceMuted: boolean;
}

/** Where a server starts, before the header has said anything. */
export function defaultSettings(): SessionSettings {
  return { chattiness: DEFAULT_CHATTINESS, voiceMuted: false };
}

/**
 * Body of `POST /api/session/settings`. It works with no session running
 * too — the setting is the server's, and the next session inherits it.
 */
export const SessionSettingsRequestSchema = z.object({
  chattiness: ChattinessSchema.optional(),
  voiceMuted: z.boolean().optional(),
}).refine((value) => value.chattiness !== undefined || value.voiceMuted !== undefined);
export type SessionSettingsRequest = z.infer<typeof SessionSettingsRequestSchema>;

/** Response to it: the settings as they now stand. */
export interface SessionSettingsResponse {
  settings: SessionSettings;
}

/** One diarization label, and the display name the user gave it (US-007). */
export interface SpeakerRecord {
  name: string | null;
}

/**
 * `session.json` in a session folder (US-008): the whole session as metadata,
 * rewritten atomically on every change.
 */
export interface SessionRecord {
  /** The {@link SessionInfo} id this folder belongs to. */
  id: string;
  /** Wall-clock ISO timestamp of the start. */
  startedAt: string;
  /** Wall-clock ISO timestamp of the end, or `null` while it runs. */
  endedAt: string | null;
  source: SessionSource;
  /** Diarization labels met so far, in order of first appearance. */
  speakers: Record<string, SpeakerRecord>;
  /**
   * `sessionId` of every realtime transcription session the conversation used
   * — more than one only after a reconnect (`fixtures/events/NOTES.md`).
   */
  asrSessions: string[];
  settings: SessionSettings;
}
