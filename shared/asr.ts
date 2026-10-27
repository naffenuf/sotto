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
