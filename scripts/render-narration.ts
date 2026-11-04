/**
 * Renders the demo video's narration through ElevenLabs as Adam — the voice
 * that plays Craig at the table — into demo/narration/<n>.wav (24 kHz mono).
 *
 *   npm run demo:narration
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AUDIO_SAMPLE_RATE } from "../shared/audio.js";
import { loadElevenLabsApiKey } from "../server/config.js";
import { DEFAULT_TTS_MODEL, synthesizeSpeech } from "../server/voice/elevenlabs.js";

const ADAM = "pNInz6obpgDQGcFmaJgB";

const LINES: Record<string, string> = {
  "01-title":
    "This is Sotto: a voice agent that sits in your meeting, answers when it's asked, " +
    "and looks things up on its own when the room wonders something out loud. " +
    "It speaks only in a pause, and only when it has something worth saying.",
  "02-stack":
    "Sotto is built on Meta's Muse Spark 1.3 for everything it writes, Muse Glimmer running " +
    "locally for judgment calls, and Meta's realtime transcription. " +
    "The code is open source on GitHub under the MIT licence. Let's watch Sotto in a meeting.",
  "03-end": "That's Sotto. The code is on GitHub, at naffenuf slash sotto.",
};

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(AUDIO_SAMPLE_RATE, 24);
  header.writeUInt32LE(AUDIO_SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const apiKey = loadElevenLabsApiKey();
const out = resolve("demo/narration");
mkdirSync(out, { recursive: true });
for (const [name, text] of Object.entries(LINES)) {
  const pcm = await synthesizeSpeech(
    {
      text, voiceId: ADAM, modelId: DEFAULT_TTS_MODEL, seed: 7,
      voiceSettings: { stability: 0.55, similarity_boost: 0.75, use_speaker_boost: true, speed: 1.0 },
    },
    { apiKey },
  );
  const path = resolve(out, `${name}.wav`);
  writeFileSync(path, wav(pcm));
  console.log(`${name}: ${(pcm.length / 2 / AUDIO_SAMPLE_RATE).toFixed(1)} s -> ${path}`);
}
