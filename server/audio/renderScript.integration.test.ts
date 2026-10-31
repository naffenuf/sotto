/**
 * Renders a ten-line script through the real ElevenLabs API (PRD V2-001).
 *
 * The lines are deliberately short — this is the only test that pays per
 * character — and the output goes to a temp directory, never into
 * `fixtures/audio/`, because the committed fixtures' captured events are
 * measured against the exact WAVs on disk.
 *
 * What it actually proves is that the file the renderer writes is the file
 * `npm run fixtures:check` accepts: mono 16-bit PCM at 24 kHz, with a timing
 * entry per line whose gaps are the scripted pauses.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIXTURE_SAMPLE_RATE,
  FixtureScriptSchema,
  FixtureTimingSchema,
  FixtureVoicesSchema,
  type FixtureScript,
  type FixtureTiming,
} from "../../shared/fixtures.js";
import { synthesizeSpeech } from "../voice/elevenlabs.js";
import { renderScript } from "./renderScript.js";
import { parseWav } from "./wav.js";

// `globalSetup` loads `.env` in the main process; a test file runs in a worker
// and has to load it for itself.
loadDotenv({ quiet: true });

const apiKey = (process.env.ELEVENLABS_API_KEY ?? "").trim();

/** Ten short lines, alternating speakers, with one long pause in the middle. */
const script: FixtureScript = FixtureScriptSchema.parse({
  lines: [
    { speaker: "A", text: "Shall we start with the agenda?", pauseAfterMs: 600 },
    { speaker: "B", text: "Yes, let's keep it short.", pauseAfterMs: 500 },
    { speaker: "A", text: "First, the budget.", pauseAfterMs: 700 },
    { speaker: "B", text: "It's tighter than last quarter.", pauseAfterMs: 500 },
    { speaker: "A", text: "By how much, roughly?", pauseAfterMs: 600 },
    { speaker: "B", text: "About a fifth, I think.", pauseAfterMs: 1600 },
    { speaker: "A", text: "That changes the hiring plan.", pauseAfterMs: 500 },
    { speaker: "B", text: "It does. We should rework it.", pauseAfterMs: 600 },
    { speaker: "A", text: "I'll draft something tonight.", pauseAfterMs: 500 },
    { speaker: "B", text: "Thanks. Let's look tomorrow.", pauseAfterMs: 0 },
  ],
});

/** Ten sequential API calls, roughly a second each. */
const RENDER_TIMEOUT_MS = 120_000;

describe.skipIf(apiKey === "")("rendering a fixture script with ElevenLabs", () => {
  let dir: string;
  let wavPath: string;
  let timing: FixtureTiming;

  beforeAll(async () => {
    const voices = FixtureVoicesSchema.parse(
      JSON.parse(readFileSync(join(process.cwd(), "fixtures/voices.json"), "utf8")),
    );
    const startedAt = Date.now();

    const rendered = await renderScript("render-test", script, ({ speaker, text }) =>
      synthesizeSpeech(
        {
          text,
          voiceId: voices.voices[speaker].voiceId,
          modelId: voices.model,
          seed: voices.seed,
        },
        { apiKey },
      ),
    );

    dir = mkdtempSync(join(tmpdir(), "sotto-render-"));
    wavPath = join(dir, "render-test.wav");
    writeFileSync(wavPath, rendered.wav);
    writeFileSync(
      join(dir, "render-test.timing.json"),
      `${JSON.stringify(rendered.timing, null, 2)}\n`,
    );
    timing = rendered.timing;

    console.log(
      `rendered ${script.lines.length} lines (${(timing.durationMs / 1000).toFixed(1)}s audio)` +
        ` in ${((Date.now() - startedAt) / 1000).toFixed(1)}s with ${voices.model}`,
    );
  }, RENDER_TIMEOUT_MS);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a mono 16-bit 24 kHz WAV", () => {
    const wav = parseWav(readFileSync(wavPath));
    expect(wav.channels).toBe(1);
    expect(wav.bitsPerSample).toBe(16);
    expect(wav.sampleRate).toBe(FIXTURE_SAMPLE_RATE);
    // Ten spoken lines plus 6.1 s of scripted pause: a couple of seconds of
    // silence would mean the API answered with nothing.
    expect(wav.data.length / 2 / FIXTURE_SAMPLE_RATE).toBeGreaterThan(15);
  });

  it("writes timings that match the WAV and the script", () => {
    const wav = parseWav(readFileSync(wavPath));
    const durationMs = Math.round((wav.data.length / 2) * (1000 / FIXTURE_SAMPLE_RATE));

    expect(FixtureTimingSchema.safeParse(timing).success).toBe(true);
    expect(timing.lines).toHaveLength(script.lines.length);
    expect(Math.abs(timing.durationMs - durationMs)).toBeLessThanOrEqual(10);
    timing.lines.forEach((line, i) => {
      expect(line.index).toBe(i);
      expect(line.speaker).toBe(script.lines[i]?.speaker);
      expect(line.endMs).toBeGreaterThan(line.startMs);
    });
  });

  it("leaves exactly the scripted pause between consecutive lines", () => {
    timing.lines.slice(0, -1).forEach((line, i) => {
      const gap = (timing.lines[i + 1]?.startMs ?? 0) - line.endMs;
      expect(gap).toBe(script.lines[i]?.pauseAfterMs);
    });
  });

  it("speaks every line at a plausible rate", () => {
    // ~3.4-3.8 words a second is what the fixtures measured; anything far off
    // means a line came back as silence or as somebody else's text.
    timing.lines.forEach((line, i) => {
      const words = (script.lines[i]?.text ?? "").split(/\s+/).length;
      const seconds = (line.endMs - line.startMs) / 1000;
      expect(seconds).toBeGreaterThan(words / 8);
      expect(seconds).toBeLessThan(words / 1.2 + 1);
    });
  });
});
