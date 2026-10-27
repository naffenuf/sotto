/**
 * The recorded form of Meta's realtime transcription stream: one JSON frame
 * per line, with the time it arrived. `npm run capture` writes these to
 * `fixtures/events/<fixture>.jsonl`; the turn assembler (US-006) and fast
 * replay (US-008) read them back instead of calling the API.
 */
import { z } from "zod";

/** Modes the realtime endpoint accepts. Sotto needs speaker labels, so `DIARIZATION`. */
export const asrModes = ["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"] as const;
export type AsrMode = (typeof asrModes)[number];

/**
 * One frame as the server sent it, plus bookkeeping.
 *
 * Frames are kept as-is rather than narrowed to known event types: the point
 * of a capture is to record what the API actually sends, including anything
 * undocumented.
 */
export const AsrFrameRecordSchema = z.object({
  /** Milliseconds from the start of the stream to the arrival of this frame. */
  atMs: z.number().nonnegative(),
  /**
   * Which ASR session the frame came from, numbered from 0. A capture has more
   * than one only when the client reconnected (retry, or the 60-minute limit).
   */
  session: z.number().int().nonnegative(),
  /** The frame, parsed. Non-JSON frames are recorded as `{ raw: "<text>" }`. */
  frame: z.record(z.string(), z.unknown()),
});

export type AsrFrameRecord = z.infer<typeof AsrFrameRecordSchema>;

/** Reads a captured `.jsonl` file's text into validated records. */
export function parseAsrFrameRecords(jsonl: string): AsrFrameRecord[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, index) => {
      const parsed = AsrFrameRecordSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(`line ${index + 1} is not an ASR frame record: ${parsed.error.message}`);
      }
      return parsed.data;
    });
}

/**
 * The five frame types a turn is built from, as `fixtures/events/NOTES.md`
 * records them. Everything else the server sends (the handshake
 * acknowledgement, `audioProgress`) carries no turn information.
 */
const TurnIdSchema = z.number().int().nonnegative();
const AudioPositionSchema = z.number().nonnegative();

/** Opens a turn. */
export const SpeechStartEventSchema = z.object({
  type: z.literal("speechStart"),
  turnId: TurnIdSchema,
  audioProcessedMs: AudioPositionSchema,
});

/**
 * Cumulative text for the open turn. Carries no `turnId`: it belongs to the
 * most recent `speechStart` without a `speechEnd`. The one frame with
 * `final: true` is the empty flush marker the server sends after `endStream`.
 */
export const TranscriptEventSchema = z.object({
  type: z.literal("transcript"),
  transcript: z.string(),
  final: z.boolean(),
  audioProcessedMs: AudioPositionSchema,
});

/** Diarization label for the open turn. Carries no `turnId` either. */
export const SpeakerEventSchema = z.object({
  type: z.literal("speaker"),
  label: z.string().min(1),
  audioProcessedMs: AudioPositionSchema,
});

/** Closes a turn. */
export const SpeechEndEventSchema = z.object({
  type: z.literal("speechEnd"),
  turnId: TurnIdSchema,
  audioProcessedMs: AudioPositionSchema,
});

/** Final text for a closed turn, and the only text frame tied to a `turnId`. */
export const SpeechCompleteEventSchema = z.object({
  type: z.literal("speechComplete"),
  turnId: TurnIdSchema,
  transcript: z.string(),
  audioProcessedMs: AudioPositionSchema,
});

export const AsrEventSchema = z.discriminatedUnion("type", [
  SpeechStartEventSchema,
  TranscriptEventSchema,
  SpeakerEventSchema,
  SpeechEndEventSchema,
  SpeechCompleteEventSchema,
]);

export type AsrEvent = z.infer<typeof AsrEventSchema>;
export type AsrEventType = AsrEvent["type"];

/** The frame types that say something about turns. */
export const asrEventTypes: readonly AsrEventType[] = [
  "speechStart",
  "transcript",
  "speaker",
  "speechEnd",
  "speechComplete",
];

/**
 * Narrows a captured frame to one of the turn events.
 *
 * Returns `null` for frames that are none of Sotto's business — the handshake
 * acknowledgement, `audioProgress`, anything undocumented. A frame that claims
 * one of the five types but doesn't match its shape is a `{ error }`: our
 * reading of the API is wrong, and the caller should say so rather than
 * silently drop a turn.
 */
export function asAsrEvent(
  frame: Record<string, unknown>,
): { event: AsrEvent } | { error: string } | null {
  const type = frame["type"];
  if (typeof type !== "string" || !asrEventTypes.includes(type as AsrEventType)) return null;
  const parsed = AsrEventSchema.safeParse(frame);
  return parsed.success ? { event: parsed.data } : { error: parsed.error.message };
}
