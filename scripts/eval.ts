/**
 * The interjection eval harness (PRD US-016, part 1).
 *
 *   npm run eval                                  # every eval fixture, normal
 *   npm run eval -- --chattiness all              # quiet, normal and active
 *   npm run eval -- --fixtures moment-fact        # one conversation
 *   npm run eval -- --no-judge                    # replay only, match nothing
 *
 * Every captured conversation is replayed at `max` speed through the real
 * board → observer → verification → policy chain, and every card that reached
 * the stage is judged against the moments its fixture planted. The whole run
 * lands in `eval/runs/<timestamp>.json`; the scoring, the report and the gates
 * read that file (US-016 part 2).
 *
 * This calls the real API. A replay costs the model calls the conversation
 * would really have made — six or seven board updates, a look after each, a
 * web check for each claim — so the seven-fixture set is tens of calls and
 * takes as long as those calls take. Judge verdicts are cached in
 * `eval/cache/`, so a rerun after tuning only pays for the cards that changed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalRunRecord, FixtureRunRecord } from "../shared/eval.js";
import type { Chattiness } from "../shared/policy.js";
import { loadConfig } from "../server/config.js";
import { listFixtures } from "../server/fixtures.js";
import { Judge, JudgeCache, JUDGE_CACHE_DIR } from "../server/eval/judge.js";
import { evalFixtures, parseEvalArgs, runTimestamp, EVAL_USAGE } from "../server/eval/options.js";
import { runFixture } from "../server/eval/runner.js";
import { MuseClient, SPARK_MODEL } from "../server/model/client.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const RUNS_DIR = join(repoRoot, "eval/runs");
const SESSIONS_DIR = join(repoRoot, "eval/sessions");

/** The commit the numbers belong to; a dirty tree gets a `+` after it. */
function gitCommit(): string | null {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return dirty === "" ? head : `${head}+`;
  } catch {
    return null;
  }
}

/** One line per replay, so a long run says where it has got to. */
function report(run: FixtureRunRecord): void {
  if (run.error !== undefined) {
    console.error(`  ${run.fixture} [${run.chattiness}] FAILED: ${run.error}`);
    return;
  }
  const matched = new Set(run.matches.filter((match) => match.matches).map((m) => m.momentId));
  const outside = run.deliveries.filter((delivery) => !delivery.inPause).length;
  const levels = run.deliveries.map((delivery) => delivery.level[0]).join("") || "-";
  console.log(
    `  ${run.fixture} [${run.chattiness}]: ${run.finalTurns} turns, ` +
      `${run.candidates} candidate(s), ${run.deliveries.length} delivered (${levels}), ` +
      `${matched.size}/${run.moments.length} moment(s) matched` +
      (outside > 0 ? `, ${outside} OUTSIDE A PAUSE` : "") +
      `, ${(run.elapsedMs / 1000).toFixed(0)}s`,
  );
}

async function main(): Promise<void> {
  const parsed = parseEvalArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(EVAL_USAGE);
    process.exitCode = 1;
    return;
  }

  const captured = listFixtures().events;
  const fixtures = parsed.fixtures ?? evalFixtures(captured);
  const missing = fixtures.filter((name) => !captured.includes(name));
  if (missing.length > 0) {
    console.error(
      `no captured events for: ${missing.join(", ")}\n` +
        `run \`npm run capture -- <fixture>\` first; captured: ${captured.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  if (fixtures.length === 0) {
    console.error("there is nothing to evaluate: no captured events match the eval set");
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

  const startedAt = new Date();
  const id = runTimestamp(startedAt);
  const judge = parsed.skipJudge
    ? undefined
    : new Judge({
        model: new MuseClient({ apiKey }),
        cache: new JudgeCache(join(repoRoot, JUDGE_CACHE_DIR)),
        modelName: SPARK_MODEL,
      });

  console.log(
    `[eval] ${id}: ${fixtures.length} fixture(s) × ${parsed.chattiness.join(", ")}` +
      (judge === undefined ? " (judging skipped)" : ""),
  );

  const runs: FixtureRunRecord[] = [];
  for (const chattiness of parsed.chattiness as Chattiness[]) {
    console.log(`\n=== chattiness: ${chattiness} ===`);
    for (const fixture of fixtures) {
      const run = await runFixture({
        fixture,
        chattiness,
        sessionRoot: join(SESSIONS_DIR, id, chattiness),
        apiKey,
        judge,
      });
      runs.push(run);
      report(run);
    }
  }

  const record: EvalRunRecord = {
    id,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    chattiness: [...parsed.chattiness],
    fixtures,
    judge: {
      model: SPARK_MODEL,
      promptHash: judge?.promptHash ?? "",
      calls: judge?.counts().calls ?? 0,
      cacheHits: judge?.counts().cacheHits ?? 0,
    },
    runs,
  };
  mkdirSync(RUNS_DIR, { recursive: true });
  const path = join(RUNS_DIR, `${id}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

  const delivered = runs.reduce((total, run) => total + run.deliveries.length, 0);
  const outside = runs.reduce(
    (total, run) => total + run.deliveries.filter((one) => !one.inPause).length,
    0,
  );
  console.log(
    `\n[eval] ${delivered} card(s) delivered, ${outside} outside a pause, ` +
      `${record.judge.calls} judge call(s) (${record.judge.cacheHits} cached)`,
  );
  console.log(`[eval] written to ${path}`);
  // The gates — recall, precision, false interjects — are US-016 part 2. A
  // replay that failed is still a failed run, and says so here.
  if (runs.some((run) => run.error !== undefined)) process.exitCode = 1;
}

await main();
