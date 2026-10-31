/**
 * The `/ws/voice` protocol: how Sotto's speech reaches the browser, and how
 * the browser says what it has actually played (V2-004).
 *
 * Audio and control travel on the same socket, told apart the way `/ws/audio`
 * tells them apart: **binary frames are PCM16 mono 24 kHz samples** of the
 * current utterance, and **text frames are JSON control messages**. There is
 * no length prefix and no header on an audio frame, because an utterance is
 * announced before its first sample and nothing else is ever playing: the
 * stream is one voice, so the browser only has to know which utterance it is
 * in, not which one each chunk belongs to.
 *
 * The playback reports are the other half. The server knows what it *sent* to
 * ElevenLabs and what came back, but only the page knows what came out of the
 * speakers — which is what the speaking indicator shows, what ends an
 * utterance, and what makes "the exact text spoken before it was cut off"
 * answerable after a barge-in (`Speaker.spokenSoFar`, V2-007).
 */
import { z } from "zod";
import { AUDIO_SAMPLE_RATE } from "./audio.js";

/** Speech is the same PCM16 mono 24 kHz the rest of the pipeline uses. */
export const VOICE_SAMPLE_RATE = AUDIO_SAMPLE_RATE;

/** Why an utterance stopped producing audio. */
export const voiceEndReasons = ["complete", "cancelled"] as const;
export type VoiceEndReason = (typeof voiceEndReasons)[number];

/**
 * Server to browser, as JSON text frames.
 *
 * - `utterance`: a new one begins; every binary frame after this belongs to it
 *   until the next `utterance`. A socket that attaches mid-utterance is sent
 *   this first, so late audio is still playable.
 * - `end`: no more audio is coming. Whatever is buffered still plays out.
 * - `cancel`: stop now and throw away what is buffered — the Stop button and
 *   a barge-in. The browser answers with a final `ended` report.
 */
export type VoiceServerFrame =
  | { type: "utterance"; id: string; sampleRate: number; text: string }
  | { type: "end"; id: string; reason: VoiceEndReason }
  | { type: "cancel"; id: string };

/**
 * Browser to server, as JSON text frames.
 *
 * `playedMs` is always milliseconds of *this utterance's* audio that have
 * finished playing, which is the unit `Speaker.notePlayedMs` wants.
 */
export const VoiceClientFrameSchema = z.discriminatedUnion("type", [
  /** The first sample of this utterance has reached the speakers. */
  z.object({ type: z.literal("started"), id: z.string().min(1) }),
  /** How far playback has got; sent every {@link VOICE_REPORT_MS} while playing. */
  z.object({
    type: z.literal("position"),
    id: z.string().min(1),
    playedMs: z.number().min(0),
  }),
  /** Playback finished, or was flushed by a `cancel`. */
  z.object({
    type: z.literal("ended"),
    id: z.string().min(1),
    playedMs: z.number().min(0),
    flushed: z.boolean(),
  }),
  /** The page could not play it — a blocked AudioContext, say. */
  z.object({
    type: z.literal("error"),
    id: z.string().min(1),
    message: z.string().max(400),
  }),
]);
export type VoiceClientFrame = z.infer<typeof VoiceClientFrameSchema>;

/** How often the browser reports its playback position while speaking. */
export const VOICE_REPORT_MS = 200;

/**
 * Whether Sotto is speaking, as the stage shows it.
 *
 * `speaking` is the server's view — an utterance is open — and `playing` is
 * the browser's: audio has started coming out and has not finished. They
 * differ for the few hundred milliseconds of ElevenLabs' first chunk, and for
 * a session with no browser attached, where `speaking` is true and nothing is
 * heard at all.
 */
export interface VoiceState {
  speaking: boolean;
  playing: boolean;
  /** The open utterance's id, or `null` when nothing is being said. */
  utteranceId: string | null;
  /** What Sotto is saying, as far as it has been written. */
  text: string;
}

/** Nothing is being said. */
export function silentVoice(): VoiceState {
  return { speaking: false, playing: false, utteranceId: null, text: "" };
}

/** Body of `POST /api/voice/test`, the dev route that speaks a test line. */
export const VoiceTestRequestSchema = z.object({
  text: z.string().trim().min(1).max(600).optional(),
});
export type VoiceTestRequest = z.infer<typeof VoiceTestRequestSchema>;

/** Response to it, and to `POST /api/voice/stop`. */
export interface VoiceActionResponse {
  /** The utterance that is now open, or `null`. */
  utteranceId: string | null;
  speaking: boolean;
}
