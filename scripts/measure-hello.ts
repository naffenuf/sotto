/**
 * Measures how long the opening hello takes to say (V3-012).
 *
 *   npm run hello:measure
 *
 * Renders `server/prompts/hello.md` once through the real ElevenLabs REST
 * endpoint, in Sotto's own voice and on the same flash model the live socket
 * uses, and prints the duration of the audio that came back. The PRD's budget
 * for the hello is about 20 seconds, so this is the instrument that answers
 * whether an edit to those words still fits — words per second is a guess and
 * a render is not.
 *
 * Costs one request (~half an ElevenLabs credit per character) and writes
 * nothing: the audio is measured and thrown away, because the live hello is
 * synthesized afresh every session.
 */
import { AUDIO_SAMPLE_RATE } from "../shared/audio.js";
import {
  loadElevenLabsApiKey,
  loadSottoVoiceId,
  MissingElevenLabsKeyError,
} from "../server/config.js";
import { PROMPTS, loadPrompt } from "../server/prompts/index.js";
import { DEFAULT_TTS_MODEL, synthesizeSpeech } from "../server/voice/elevenlabs.js";
import { DEFAULT_VOICE_SETTINGS } from "../server/voice/Speaker.js";

/**
 * The PRD's budget is "under about 20 s spoken" (V3-012). It was written
 * against the River voice (18.4 s); Matilda, chosen on 2026-11-02 for how she
 * sounds, reads the same 74 words in 21.5 s at speed 1.1, and the words are
 * all demo exposition. "About" is read as two seconds either way.
 */
const BUDGET_MS = 22_000;

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  let apiKey: string;
  try {
    apiKey = loadElevenLabsApiKey();
  } catch (error) {
    die(error instanceof MissingElevenLabsKeyError ? error.message : String(error));
  }
  const voiceId = loadSottoVoiceId();
  const text = loadPrompt(PROMPTS.hello);
  const words = text.split(/\s+/).filter((word) => word !== "").length;

  console.log(`Rendering the hello with ${DEFAULT_TTS_MODEL} as ${voiceId}:`);
  console.log(`  ${JSON.stringify(text)}`);
  const audio = await synthesizeSpeech(
    { text, voiceId, modelId: DEFAULT_TTS_MODEL, voiceSettings: DEFAULT_VOICE_SETTINGS },
    { apiKey },
  );

  // Raw PCM16 mono, so the byte count is the duration. Every utterance comes
  // back padded with a little near-silence (54-91 ms head, 268-371 ms tail),
  // which is counted here rather than trimmed: it is the longer, safer number.
  const ms = (audio.length / 2 / AUDIO_SAMPLE_RATE) * 1000;
  const seconds = ms / 1000;
  console.log(
    `\n${words} words, ${text.length} characters -> ${seconds.toFixed(1)}s` +
      ` (${(words / seconds).toFixed(2)} words/second)`,
  );
  if (ms > BUDGET_MS) {
    die(`FAIL: over the ${BUDGET_MS / 1000}s budget by ${((ms - BUDGET_MS) / 1000).toFixed(1)}s.`);
  }
  console.log(`PASS: under the ${BUDGET_MS / 1000}s budget by ${((BUDGET_MS - ms) / 1000).toFixed(1)}s.`);
}

await main();
