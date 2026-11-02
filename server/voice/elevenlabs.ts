/**
 * ElevenLabs text-to-speech, the one-shot kind.
 *
 * This is the whole-utterance REST endpoint
 * (https://elevenlabs.io/docs/api-reference/text-to-speech/convert): POST the
 * text, get the audio back as one body. The fixture renderer (V2-001) wants
 * exactly that — a line at a time, written to disk — while Sotto's own voice
 * wants the streaming socket, which is a separate seam (V2-003).
 *
 * Two facts worth knowing before changing anything here:
 *
 *   - **`pcm_24000` comes back raw**, with no RIFF framing and no JSON wrapper:
 *     little-endian 16-bit mono samples, which is the same shape as
 *     {@link AUDIO_SAMPLE_RATE} audio everywhere else in Sotto.
 *   - **The key is scoped.** The one in `.env` can synthesize speech but has
 *     neither `voices_read` nor `user_read`, so nothing here may list voices or
 *     check the subscription — voice ids are configuration
 *     (`fixtures/voices.json`), not something to discover at runtime.
 */
import { AUDIO_SAMPLE_RATE } from "../../shared/audio.js";

/** ElevenLabs' API root. */
export const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

/**
 * Raw mono 16-bit PCM at 24 kHz — the one audio shape the rest of Sotto
 * speaks, so nothing downstream has to resample.
 */
export const ELEVENLABS_OUTPUT_FORMAT = `pcm_${AUDIO_SAMPLE_RATE}` as const;

/**
 * Default model. Flash is the fastest and cheapest (half the credits of
 * `eleven_multilingual_v2`) and measured no worse for scripted conversation:
 * the same line rendered 4.6 s on flash against 4.2 s on multilingual, with
 * clean word boundaries either way. It is also the model Sotto's live voice
 * uses, so the project talks to one model.
 */
export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";

/** One utterance to synthesize. */
export interface SynthesizeRequest {
  text: string;
  /** An ElevenLabs voice id, e.g. a library voice from `fixtures/voices.json`. */
  voiceId: string;
  modelId?: string | undefined;
  /** Makes a render repeatable, the way the old Chatterbox seed did. */
  seed?: number | undefined;
  /**
   * `voice_settings` for the render. Fixtures leave it out so their bytes
   * stay what the captures were checked against; Sotto's own lines pass
   * `DEFAULT_VOICE_SETTINGS` so a measurement is of what the room will hear.
   */
  voiceSettings?: Record<string, number | boolean> | undefined;
}

/** Just the part of `fetch` this module uses, so a unit test can stand in for it. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBufferLike>;
}>;

export interface SynthesizeOptions {
  /** ElevenLabs API key. Never logged. */
  apiKey: string;
  /** Seam for tests: the fetch to call instead of the global one. */
  fetch?: FetchLike | undefined;
  baseUrl?: string | undefined;
}

export class ElevenLabsError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`ElevenLabs text-to-speech failed (HTTP ${status}): ${detail}`);
    this.name = "ElevenLabsError";
  }
}

/**
 * Synthesizes one utterance and returns the raw PCM16 samples.
 *
 * Throws {@link ElevenLabsError} with the API's own message on a non-2xx —
 * which is how a missing permission or an unknown voice id shows up — and
 * never puts the key in the message.
 */
export async function synthesizeSpeech(
  request: SynthesizeRequest,
  options: SynthesizeOptions,
): Promise<Buffer> {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = options.baseUrl ?? ELEVENLABS_API_BASE;
  const url =
    `${base}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}` +
    `?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;

  const response = await doFetch(url, {
    method: "POST",
    headers: { "xi-api-key": options.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text: request.text,
      model_id: request.modelId ?? DEFAULT_TTS_MODEL,
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...(request.voiceSettings === undefined ? {} : { voice_settings: request.voiceSettings }),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ElevenLabsError(response.status, detail.slice(0, 400) || "no response body");
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 2) {
    throw new ElevenLabsError(response.status, `returned ${audio.length} bytes of audio`);
  }
  // An odd byte count would split a sample in half for every reader downstream.
  return audio.length % 2 === 0 ? audio : audio.subarray(0, audio.length - 1);
}
