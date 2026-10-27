/**
 * Records what Meta's realtime transcription actually sends, by replaying
 * fixture audio through it and appending every server frame to
 * `fixtures/events/<fixture>.jsonl`.
 *
 *   npm run capture -- brainstorm     # one fixture
 *   npm run capture -- --all          # every fixture, in order
 *
 * This calls the real API and runs at real time: the full set is about 15
 * minutes of audio.
 */
import { createWriteStream, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { WavReplaySource } from "../server/audio/WavReplaySource.js";
import { RealtimeTranscriptionClient } from "../server/asr/realtimeClient.js";
import { loadConfig } from "../server/config.js";
import type { AsrFrameRecord } from "../shared/asr.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptsDir = join(repoRoot, "fixtures/scripts");
export const EVENTS_DIR = join(repoRoot, "fixtures/events");

/** Every fixture that has a script, in the order they were written. */
function allFixtures(): string[] {
  return readdirSync(scriptsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => basename(file, ".json"))
    .sort();
}

/** What the run looked like, printed so NOTES.md can be written from real data. */
interface Summary {
  frames: number;
  byType: Map<string, number>;
  speakerLabels: Set<string>;
  wakeSpellings: Set<string>;
  sessionIds: string[];
  durationMs: number;
}

/** Catches how the model spelled the wake word, which `keywords` only biases. */
const wakeLikePattern = /\b(?:s[ouè]t+[oa]+|soda|zotto|sato)\w*\b/gi;

function summarize(records: AsrFrameRecord[]): Omit<Summary, "sessionIds" | "durationMs"> {
  const byType = new Map<string, number>();
  const speakerLabels = new Set<string>();
  const wakeSpellings = new Set<string>();
  for (const { frame } of records) {
    const type = typeof frame["type"] === "string" ? frame["type"] : "<handshake ack>";
    byType.set(type, (byType.get(type) ?? 0) + 1);
    const label = frame["label"] ?? frame["speaker"];
    if (typeof label === "string") speakerLabels.add(label);
    for (const value of Object.values(frame)) {
      if (typeof value !== "string") continue;
      for (const match of value.matchAll(wakeLikePattern)) wakeSpellings.add(match[0]);
    }
  }
  return { frames: records.length, byType, speakerLabels, wakeSpellings };
}

async function capture(fixture: string, apiKey: string): Promise<Summary> {
  const source = WavReplaySource.forFixture(fixture);
  const outPath = join(EVENTS_DIR, `${fixture}.jsonl`);
  const out = createWriteStream(outPath, { flags: "w" });
  const records: AsrFrameRecord[] = [];

  const seconds = ((source.chunkCount * 80) / 1000).toFixed(1);
  console.log(`\n=== ${fixture} (${seconds}s of audio) ===`);

  const client = new RealtimeTranscriptionClient({
    apiKey,
    onFrame: (record) => {
      records.push(record);
      out.write(`${JSON.stringify(record)}\n`);
    },
  });

  try {
    const result = await client.run(source);
    return { ...summarize(records), sessionIds: result.sessionIds, durationMs: result.durationMs };
  } finally {
    out.end();
    await once(out, "close");
  }
}

function printSummary(fixture: string, summary: Summary): void {
  const types = [...summary.byType]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} x${count}`)
    .join(", ");
  console.log(`[${fixture}] ${summary.frames} frames in ${Math.round(summary.durationMs)} ms`);
  console.log(`[${fixture}] frames: ${types}`);
  console.log(`[${fixture}] speaker labels: ${[...summary.speakerLabels].sort().join(", ") || "none"}`);
  console.log(
    `[${fixture}] wake-word spellings: ${[...summary.wakeSpellings].sort().join(", ") || "none"}`,
  );
  console.log(`[${fixture}] asr sessions: ${summary.sessionIds.length}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: npm run capture -- <fixture> | --all");
    process.exitCode = 1;
    return;
  }

  const available = allFixtures();
  const fixtures = args[0] === "--all" ? available : args;
  const unknown = fixtures.filter((name) => !available.includes(name));
  if (unknown.length > 0) {
    console.error(`unknown fixture(s): ${unknown.join(", ")}\navailable: ${available.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const { modelApiKey } = loadConfig();
  mkdirSync(EVENTS_DIR, { recursive: true });

  for (const fixture of fixtures) {
    const summary = await capture(fixture, modelApiKey);
    printSummary(fixture, summary);
  }
}

await main();
