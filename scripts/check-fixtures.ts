/**
 * Validates every fixture script in `fixtures/scripts/` and the audio rendered
 * from it. Run with `npm run fixtures:check`.
 *
 * Checks, per script:
 *   - it parses against {@link FixtureScriptSchema}, which also enforces that
 *     every line index exists and `setupLines` < `triggerLine` <= `deadlineLine`
 *   - `fixtures/audio/<name>.wav` exists and is mono 16-bit PCM at 24 kHz
 *   - `fixtures/audio/<name>.timing.json` exists, parses, and has one entry per
 *     line, in order, within the WAV
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_SAMPLE_RATE,
  FixtureScriptSchema,
  FixtureTimingSchema,
  type FixtureScript,
  type FixtureTiming,
} from "../shared/fixtures.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptsDir = join(repoRoot, "fixtures/scripts");
const audioDir = join(repoRoot, "fixtures/audio");

interface WavFormat {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
}

/** Reads just enough of a RIFF header to confirm the format. */
function readWavFormat(path: string): WavFormat {
  const buf = readFileSync(path);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let format: Omit<WavFormat, "dataBytes"> | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataBytes = Math.min(size, buf.length - body);
    }
    offset = body + size + (size % 2);
  }
  if (!format || dataBytes === undefined) throw new Error("missing fmt or data chunk");
  return { ...format, dataBytes };
}

function checkScript(name: string, problems: string[]): void {
  const fail = (message: string) => problems.push(`${name}: ${message}`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(scriptsDir, `${name}.json`), "utf8"));
  } catch (error) {
    fail(`script is not valid JSON (${(error as Error).message})`);
    return;
  }

  const parsed = FixtureScriptSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      fail(`${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return;
  }
  const script: FixtureScript = parsed.data;

  const wavPath = join(audioDir, `${name}.wav`);
  const timingPath = join(audioDir, `${name}.timing.json`);
  let durationMs: number | undefined;

  try {
    const wav = readWavFormat(wavPath);
    if (wav.channels !== 1) fail(`${name}.wav has ${wav.channels} channels, expected mono`);
    if (wav.sampleRate !== FIXTURE_SAMPLE_RATE)
      fail(`${name}.wav is ${wav.sampleRate} Hz, expected ${FIXTURE_SAMPLE_RATE} Hz`);
    if (wav.bitsPerSample !== 16) fail(`${name}.wav is ${wav.bitsPerSample}-bit, expected 16-bit`);
    durationMs = Math.round((wav.dataBytes / 2) * (1000 / FIXTURE_SAMPLE_RATE));
  } catch (error) {
    fail(`${name}.wav: ${(error as Error).message} — regenerate with make_fixture.py`);
  }

  let timing: FixtureTiming | undefined;
  try {
    const parsedTiming = FixtureTimingSchema.safeParse(
      JSON.parse(readFileSync(timingPath, "utf8")),
    );
    if (parsedTiming.success) {
      timing = parsedTiming.data;
    } else {
      for (const issue of parsedTiming.error.issues) {
        fail(`${name}.timing.json ${issue.path.join(".") || "<root>"}: ${issue.message}`);
      }
    }
  } catch (error) {
    fail(`${name}.timing.json: ${(error as Error).message} — regenerate with make_fixture.py`);
  }

  if (!timing) return;

  if (timing.name !== name) fail(`${name}.timing.json names "${timing.name}"`);
  if (timing.lines.length !== script.lines.length) {
    fail(
      `${name}.timing.json has ${timing.lines.length} line timings, script has ${script.lines.length} lines`,
    );
    return;
  }

  let previousEnd = 0;
  timing.lines.forEach((lineTiming, i) => {
    const line = script.lines[i];
    if (lineTiming.index !== i) fail(`${name}.timing.json line ${i} has index ${lineTiming.index}`);
    if (line && lineTiming.speaker !== line.speaker)
      fail(`${name}.timing.json line ${i} is speaker ${lineTiming.speaker}, script says ${line.speaker}`);
    if (lineTiming.endMs <= lineTiming.startMs)
      fail(`${name}.timing.json line ${i} ends at or before it starts`);
    if (lineTiming.startMs < previousEnd)
      fail(`${name}.timing.json line ${i} starts before line ${i - 1} ends`);
    previousEnd = lineTiming.endMs;
  });

  if (durationMs !== undefined) {
    if (Math.abs(timing.durationMs - durationMs) > 10)
      fail(`${name}.timing.json says ${timing.durationMs} ms, ${name}.wav is ${durationMs} ms`);
    if (previousEnd > durationMs)
      fail(`${name}.timing.json ends at ${previousEnd} ms, past the end of ${name}.wav`);
  }
}

function main(): void {
  let names: string[];
  try {
    names = readdirSync(scriptsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => basename(file, ".json"))
      .sort();
  } catch {
    console.error(`No fixture scripts directory at ${scriptsDir}`);
    process.exit(1);
  }

  if (names.length === 0) {
    console.error(`No fixture scripts found in ${scriptsDir}`);
    process.exit(1);
  }

  const problems: string[] = [];
  for (const name of names) checkScript(name, problems);

  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) in ${names.length} fixture(s).`);
    process.exit(1);
  }

  for (const name of names) {
    const seconds = statSync(join(audioDir, `${name}.wav`)).size / (2 * FIXTURE_SAMPLE_RATE);
    console.log(`✓ ${name} (${seconds.toFixed(1)}s)`);
  }
  console.log(`\n${names.length} fixture(s) OK.`);
}

main();
