/**
 * Re-scoring a run that already happened (PRD US-016 part 2).
 *
 *   npm run eval:report                    # the newest run in eval/runs/
 *   npm run eval:report -- 2026-10-28_091323
 *   npm run eval:report -- eval/runs/2026-10-28_091323.json
 *
 * `eval/runs/<id>.json` is the raw record of what a replay saw, so every
 * number in a report is recomputed from it: change the window, the gates or
 * the table and the answer costs nothing but reading a file. Exits non-zero
 * on the same gates `npm run eval` does, which is what makes it usable as the
 * check while tuning (US-023).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalRunRecord } from "../shared/eval.js";
import { estimateCostUsd, formatUsd } from "../server/eval/cost.js";
import { renderTerminalReport } from "../server/eval/report.js";
import { writeReport } from "../server/eval/reportFile.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const RUNS_DIR = join(repoRoot, "eval/runs");

const USAGE = "usage: npm run eval:report -- [<run id>|<path to run json>]";

/** The newest run on disk, by file name — which is its timestamp. */
function newestRun(): string | null {
  try {
    const files = readdirSync(RUNS_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();
    const last = files[files.length - 1];
    return last === undefined ? null : join(RUNS_DIR, last);
  } catch {
    return null;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length > 1) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const asked = argv[0];
  const path =
    asked === undefined
      ? newestRun()
      : asked.endsWith(".json")
        ? asked
        : join(RUNS_DIR, `${asked}.json`);
  if (path === null) {
    console.error(`no runs in ${RUNS_DIR}; run \`npm run eval\` first`);
    process.exitCode = 1;
    return;
  }

  let record: EvalRunRecord;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as EvalRunRecord;
  } catch (error) {
    console.error(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const { score, path: reportPath } = writeReport(record, repoRoot);
  console.log(`[eval] scoring ${path} (commit ${record.gitCommit ?? "unknown"})`);
  console.log(renderTerminalReport(record, score));
  if (record.usage !== undefined) {
    console.log(`\n[eval] about ${formatUsd(estimateCostUsd(record.usage))} of model calls`);
  }
  console.log(`[eval] report  ${reportPath}`);
  if (!score.passed) {
    console.error("[eval] GATES FAILED");
    process.exitCode = 1;
  }
}

main();
