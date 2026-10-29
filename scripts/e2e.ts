/**
 * The end-to-end live-audio check (PRD US-021).
 *
 *   npm run e2e                                   # all four conversations
 *   npm run e2e -- --fixtures ask-search          # just one
 *
 * Four fixture WAVs are streamed at real-time pace into the *real* realtime
 * transcription and through the whole loop — board, observer, verifier,
 * policy, wake phrase, answer agent, session folder. Every other automated
 * check in the project either replays captured events or fakes a seam; this
 * one proves the path from audio, which is the only path a room full of people
 * will ever use.
 *
 * It costs real money and real time: about five and a half minutes of audio
 * plus the drain at the end of each conversation, and the model calls that
 * conversation would really have made. The bill is printed and gated.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { E2eFixtureReport, E2eRunReport } from "../shared/e2e.js";
import { loadConfig } from "../server/config.js";
import { checkFixture, type E2eCheckInput } from "../server/e2e/checks.js";
import { fixtureLatency } from "../server/e2e/latency.js";
import { readSessionFiles, runLive } from "../server/e2e/live.js";
import { E2E_USAGE, parseE2eArgs } from "../server/e2e/options.js";
import { renderRun, runPassed } from "../server/e2e/report.js";
import {
  UsageMeter,
  estimateAsrCostUsd,
  estimateCostUsd,
  formatUsd,
} from "../server/eval/cost.js";
import { resolveMoments } from "../server/eval/moments.js";
import { runTimestamp } from "../server/eval/options.js";
import { finalCards } from "../server/e2e/checks.js";
import { MuseClient } from "../server/model/client.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SESSIONS_DIR = join(repoRoot, "e2e/sessions");

async function main(): Promise<void> {
  const parsed = parseE2eArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(E2E_USAGE);
    process.exitCode = 1;
    return;
  }

  let apiKey: string;
  try {
    apiKey = loadConfig().modelApiKey;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const id = runTimestamp(new Date());
  // One meter for the run: the board, observer, verifier and answer calls of
  // all four conversations land in it, and the report prices it beside the
  // audio.
  const meter = new UsageMeter();
  mkdirSync(SESSIONS_DIR, { recursive: true });

  console.log(
    `[e2e] ${id}: ${parsed.fixtures.length} fixture(s) at real-time pace ` +
      `through the real APIs — ${parsed.fixtures.join(", ")}`,
  );

  const fixtures: E2eFixtureReport[] = [];
  for (const fixture of parsed.fixtures) {
    console.log(`\n=== ${fixture} ===`);
    const observed = await runLive({
      fixture,
      apiKey,
      sessionRoot: join(SESSIONS_DIR, id),
      createModel: () => new MuseClient({ apiKey, onUsage: meter.record }),
    });
    const files = readSessionFiles(observed.sessionDir);
    const input: E2eCheckInput = {
      observed,
      files,
      moments: resolveMoments(
        fixture,
        observed.turns.map((stamped) => stamped.value),
      ),
    };
    const report: E2eFixtureReport = {
      fixture,
      sessionDir: observed.sessionDir,
      elapsedMs: observed.elapsedMs,
      audioSeconds: observed.audioSeconds,
      finalTurns: observed.turns.length,
      cards: finalCards(observed.cards).length,
      candidates: files.candidates,
      checks: observed.error === undefined ? checkFixture(input) : [],
      latency: fixtureLatency(input),
      moments: input.moments,
      ...(observed.error === undefined ? {} : { error: observed.error }),
    };
    fixtures.push(report);
    // One line per conversation while it is still running, so a long run
    // says where it has got to without waiting for the report.
    const failed = report.checks.filter((check) => !check.ok);
    console.log(
      `  ${fixture}: ${report.checks.length - failed.length}/${report.checks.length} check(s), ` +
        `${formatUsd(estimateCostUsd(meter.total()))} so far` +
        (failed.length === 0 ? "" : `, FAILED: ${failed.map((one) => one.name).join(", ")}`),
    );
  }

  const usage = meter.total();
  const audioSeconds = fixtures.reduce((total, one) => total + one.audioSeconds, 0);
  const modelCostUsd = estimateCostUsd(usage);
  const asrCostUsd = estimateAsrCostUsd(audioSeconds);
  const partial: Omit<E2eRunReport, "passed"> = {
    id,
    fixtures,
    usage,
    audioSeconds,
    modelCostUsd,
    asrCostUsd,
    totalCostUsd: modelCostUsd + asrCostUsd,
  };
  const report: E2eRunReport = { ...partial, passed: runPassed(partial) };

  console.log(`\n${renderRun(report)}`);
  if (!report.passed) process.exitCode = 1;
}

await main();
