/**
 * The end-to-end live-audio check (PRD US-021, extended by V2-021).
 *
 *   npm run e2e                                   # all five conversations
 *   npm run e2e -- --fixtures ask-search          # just one
 *   npm run e2e -- --gate glimmer                 # the local candidate gate,
 *                                                 # charged for its real seconds
 *
 * Five fixture WAVs are streamed at real-time pace into the *real* realtime
 * transcription and through the whole loop — board, observer, candidate gate,
 * verifier, policy, wake phrase, research planner, gate and searches, answer
 * agent, voice, session folder. Every other automated check in the project
 * either replays captured events or fakes a seam; this one proves the path
 * from audio, which is the only path a room full of people will ever use.
 *
 * It is also the only check that runs against a real wall clock, which is why
 * the local judgment model and the voice are wired in here rather than left
 * out: simulated time does not move inside a tracked model call, so the
 * Glimmer gate's twenty-odd seconds and a research search's fifteen cost
 * `npm run eval` nothing and cost a room everything (V2-020). Sotto really
 * speaks, through a null sink — the ElevenLabs socket, the streaming, the
 * alignment and the latencies are live and nothing comes out of a speaker.
 *
 * It costs real money and real time: about nine minutes of audio plus the
 * drain at the end of each conversation, and the model calls that conversation
 * would really have made. The bill is printed and gated.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { E2eFixtureReport, E2eRunReport } from "../shared/e2e.js";
import { loadConfig, loadSottoVoiceId } from "../server/config.js";
import {
  checkFixture,
  finalCards,
  researchFrom,
  spokenFrom,
  type E2eCheckInput,
} from "../server/e2e/checks.js";
import { fixtureLatency } from "../server/e2e/latency.js";
import { readSessionFiles, runLive } from "../server/e2e/live.js";
import { E2E_USAGE, parseE2eArgs } from "../server/e2e/options.js";
import { fixtureCostUsd, renderRun, runPassed } from "../server/e2e/report.js";
import {
  UsageMeter,
  addUsage,
  emptyUsage,
  estimateAsrCostUsd,
  estimateCostUsd,
  estimateTtsCostUsd,
  formatUsd,
} from "../server/eval/cost.js";
import { resolveMoments } from "../server/eval/moments.js";
import { runTimestamp } from "../server/eval/options.js";
import { glimmerFromEnv } from "../server/model/GlimmerClient.js";
import { MuseClient } from "../server/model/client.js";
import { Speaker } from "../server/voice/Speaker.js";
import { meteredVoice, nullSinkVoice } from "../server/voice/voiceOut.js";

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

  const voiceKey = (process.env["ELEVENLABS_API_KEY"] ?? "").trim();
  if (voiceKey === "") {
    console.error(
      "ELEVENLABS_API_KEY is missing: the check speaks through a real ElevenLabs " +
        "socket with the audio discarded, so it cannot run without one.",
    );
    process.exitCode = 1;
    return;
  }

  const id = runTimestamp(new Date());
  mkdirSync(SESSIONS_DIR, { recursive: true });

  console.log(
    `[e2e] ${id}: ${parsed.fixtures.length} fixture(s) at real-time pace ` +
      `through the real APIs, interjection gate ${parsed.gate} — ` +
      `${parsed.fixtures.join(", ")}`,
  );

  const fixtures: E2eFixtureReport[] = [];
  for (const fixture of parsed.fixtures) {
    console.log(`\n=== ${fixture} ===`);
    // One meter and one metered voice per conversation, so the bill is
    // reported per fixture as well as summed: the conversations differ by
    // several times, and a search resends its whole request each round. The
    // speech sink itself is new for each utterance.
    const meter = new UsageMeter();
    const voice = meteredVoice(
      nullSinkVoice(() => new Speaker({ apiKey: voiceKey, voiceId: loadSottoVoiceId() })),
    );
    const observed = await runLive({
      fixture,
      apiKey,
      sessionRoot: join(SESSIONS_DIR, id),
      createModel: () => new MuseClient({ apiKey, onUsage: meter.record }),
      // What `server/app.ts` passes: Glimmer when the local server is there,
      // and Muse Spark for every judgment when it is not (FR-V7).
      createGlimmer: () => glimmerFromEnv(),
      gate: parsed.gate,
      createVoice: () => voice,
      voiceSpend: () => voice.spent(),
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
      research: researchFrom(input),
      spoken: spokenFrom(input),
      voice: observed.voice,
      usage: meter.total(),
      ...(observed.error === undefined ? {} : { error: observed.error }),
    };
    fixtures.push(report);
    // One line per conversation while it is still running, so a long run
    // says where it has got to without waiting for the report.
    const failed = report.checks.filter((check) => !check.ok);
    console.log(
      `  ${fixture}: ${report.checks.length - failed.length}/${report.checks.length} check(s), ` +
        `${formatUsd(fixtureCostUsd(report))}` +
        (failed.length === 0 ? "" : `, FAILED: ${failed.map((one) => one.name).join(", ")}`),
    );
  }

  const usage = fixtures.reduce((total, one) => addUsage(total, one.usage), emptyUsage());
  const audioSeconds = fixtures.reduce((total, one) => total + one.audioSeconds, 0);
  const ttsCharacters = fixtures.reduce((total, one) => total + one.voice.characters, 0);
  const modelCostUsd = estimateCostUsd(usage);
  const asrCostUsd = estimateAsrCostUsd(audioSeconds);
  const ttsCostUsd = estimateTtsCostUsd(ttsCharacters);
  const partial: Omit<E2eRunReport, "passed"> = {
    id,
    fixtures,
    usage,
    audioSeconds,
    modelCostUsd,
    asrCostUsd,
    ttsCharacters,
    ttsCostUsd,
    totalCostUsd: modelCostUsd + asrCostUsd + ttsCostUsd,
  };
  const report: E2eRunReport = { ...partial, passed: runPassed(partial) };

  console.log(`\n${renderRun(report)}`);
  if (!report.passed) process.exitCode = 1;
}

await main();
