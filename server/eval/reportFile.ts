/**
 * Writing a report next to its run (PRD US-016 part 2).
 *
 * A report is named after the run it scores, so `eval/runs/<id>.json` and
 * `eval/reports/<id>.md` are one pair and re-scoring a run overwrites its
 * report rather than leaving two versions of the same numbers around.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalRunRecord } from "../../shared/eval.js";
import { emptyUsage } from "./cost.js";
import { renderReportMarkdown } from "./report.js";
import { scoreRun, type RunScore } from "./score.js";

/** Where reports go, relative to the repo root. Committed, unlike `runs/`. */
export const REPORTS_DIR = "eval/reports";

/** Scores `record`, writes its report, and hands back both. */
export function writeReport(
  record: EvalRunRecord,
  repoRoot: string,
): { score: RunScore; path: string } {
  const score = scoreRun(record);
  const markdown = renderReportMarkdown({
    record,
    score,
    promptHashes: record.promptHashes ?? [],
    usage: record.usage ?? emptyUsage(),
  });
  const dir = join(repoRoot, REPORTS_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.id}.md`);
  writeFileSync(path, markdown);
  return { score, path };
}
