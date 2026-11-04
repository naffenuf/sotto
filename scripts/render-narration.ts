/**
 * Renders the demo video's narration through ElevenLabs as Adam — the voice
 * that plays Craig at the table — into demo/narration/<n>.wav (24 kHz mono).
 *
 *   npm run demo:narration                 # every line
 *   npm run demo:narration -- 02-stack     # just the ones named
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AUDIO_SAMPLE_RATE } from "../shared/audio.js";
import { loadElevenLabsApiKey } from "../server/config.js";
import { DEFAULT_TTS_MODEL, synthesizeSpeech } from "../server/voice/elevenlabs.js";

const ADAM = "pNInz6obpgDQGcFmaJgB";

const LINES: Record<string, string> = {
  // Short on purpose: Sotto's own hello, seconds later, says how it behaves,
  // and the end card says where the code is.
  "01-title": "This is Sotto: a voice agent that sits in your meeting and speaks only when it has something worth saying.",
  "02-stack":
    "It's built on Meta's Muse Spark for everything it writes, Muse Glimmer running locally " +
    "for judgment calls, and Meta's realtime transcription. Let's watch a meeting.",
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
// Name lines to render only those (each costs credits): npm run demo:narration -- 01-title
const only = process.argv.slice(2);
const unknown = only.filter((n) => !(n in LINES));
if (unknown.length) throw new Error(`no narration line ${unknown.join(", ")}; lines: ${Object.keys(LINES).join(", ")}`);
for (const [name, text] of Object.entries(LINES).filter(([n]) => only.length === 0 || only.includes(n))) {
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
