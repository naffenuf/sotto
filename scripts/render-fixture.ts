/**
 * Renders a fixture script to audio with ElevenLabs.
 *
 *   npm run fixture:render -- brainstorm
 *
 * Reads `fixtures/scripts/<name>.json` and writes
 *
 *   fixtures/audio/<name>.wav          mono, 16-bit PCM, 24 kHz
 *   fixtures/audio/<name>.timing.json  startMs / endMs of every line
 *
 * Which voice speaks each speaker letter comes from `fixtures/voices.json`.
 * This calls the real ElevenLabs API — one request per line, roughly a second
 * each — and costs about half a credit per character on the default flash
 * model. Committed WAVs mean nothing downstream ever needs it.
 *
 * Existing fixtures are deliberately *not* re-rendered: their captured events
 * (`fixtures/events/<name>.jsonl`) are measured against the exact audio on
 * disk, so a fresh render would invalidate every capture.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderScript } from "../server/audio/renderScript.js";
import { loadElevenLabsApiKey, MissingElevenLabsKeyError } from "../server/config.js";
import { DEFAULT_TTS_MODEL, synthesizeSpeech } from "../server/voice/elevenlabs.js";
import { FixtureScriptSchema, FixtureVoicesSchema } from "../shared/fixtures.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptsDir = join(repoRoot, "fixtures/scripts");
const audioDir = join(repoRoot, "fixtures/audio");
const voicesPath = join(repoRoot, "fixtures/voices.json");

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    die(`${path}: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name || name.startsWith("-")) {
    die("Usage: npm run fixture:render -- <fixture name>");
  }

  const scriptPath = join(scriptsDir, `${name}.json`);
  const script = FixtureScriptSchema.safeParse(readJson(scriptPath));
  if (!script.success) {
    die(
      `${scriptPath} is not a valid fixture script:\n` +
        script.error.issues
          .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
    );
  }

  const voices = FixtureVoicesSchema.safeParse(readJson(voicesPath));
  if (!voices.success) {
    die(
      `${voicesPath} is not a valid voice map:\n` +
        voices.error.issues
          .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
    );
  }
  const { model, seed, voices: bySpeaker } = voices.data;

  let apiKey: string;
  try {
    apiKey = loadElevenLabsApiKey();
  } catch (error) {
    die(error instanceof MissingElevenLabsKeyError ? error.message : String(error));
  }

  const lines = script.data.lines.length;
  console.log(
    `Rendering ${name}: ${lines} lines with ${model}` +
      ` (A=${bySpeaker.A.name}, B=${bySpeaker.B.name})`,
  );
  const startedAt = Date.now();

  const rendered = await renderScript(
    name,
    script.data,
    ({ speaker, text }) =>
      synthesizeSpeech(
        { text, voiceId: bySpeaker[speaker].voiceId, modelId: model, seed },
        { apiKey },
      ),
    ({ index, total, speaker, text, durationMs }) => {
      const excerpt = text.length > 48 ? `${text.slice(0, 48)}…` : text;
      console.log(
        `  [${index + 1}/${total}] ${speaker}: ${JSON.stringify(excerpt)}` +
          ` -> ${(durationMs / 1000).toFixed(1)}s`,
      );
    },
  );

  mkdirSync(audioDir, { recursive: true });
  const wavPath = join(audioDir, `${name}.wav`);
  const timingPath = join(audioDir, `${name}.timing.json`);
  writeFileSync(wavPath, rendered.wav);
  writeFileSync(timingPath, `${JSON.stringify(rendered.timing, null, 2)}\n`);

  const elapsed = (Date.now() - startedAt) / 1000;
  const seconds = rendered.timing.durationMs / 1000;
  console.log(
    `Wrote ${wavPath} (${seconds.toFixed(1)}s audio) and ${timingPath} in ${elapsed.toFixed(0)}s`,
  );
  if (model !== DEFAULT_TTS_MODEL) {
    console.log(`Note: rendered with ${model}, not the default ${DEFAULT_TTS_MODEL}.`);
  }
  console.log(`Next: npm run capture -- ${name}, then npm run fixtures:check`);
}

await main();
