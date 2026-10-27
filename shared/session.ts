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
