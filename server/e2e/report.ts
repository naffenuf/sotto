/**
 * What `npm run e2e` prints (PRD US-021).
 *
 * One table of checks per fixture, the latencies the story asks for, and the
 * bill. Pure, so the layout is unit-tested and the run itself only has to
 * produce the numbers.
 */
import type { E2eFixtureReport, E2eRunReport } from "../../shared/e2e.js";
import { formatUsd } from "../eval/cost.js";
import { renderTable } from "../eval/report.js";

/** The ceiling the story puts on one run. */
export const MAX_RUN_COST_USD = 0.5;

const MARK = { pass: "ok  ", fail: "FAIL" } as const;

/** `1.4s`, or `—` for a latency this run could not measure. */
function seconds(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

/** The latency lines for one fixture, or nothing when it has none. */
function latencyLines(report: E2eFixtureReport): string[] {
  const lines: string[] = [];
  const { wakeToHeadlineMs, wakeToDoneMs, moments } = report.latency;
  if (wakeToHeadlineMs !== null || wakeToDoneMs !== null) {
    lines.push(
      `  latency  wake -> headline ${seconds(wakeToHeadlineMs)}, ` +
        `wake -> done ${seconds(wakeToDoneMs)}`,
    );
  }
  for (const moment of moments) {
    lines.push(
      `  latency  ${moment.momentId}: trigger -> delivery ${seconds(moment.deliveredAfterMs)}` +
        (moment.beforeDeadline === null
          ? ""
          : moment.beforeDeadline
            ? " (before the deadline)"
            : " (after the deadline)"),
    );
  }
  return lines;
}

/** One fixture: its checks, its latencies and where its folder is. */
export function renderFixture(report: E2eFixtureReport): string {
  const head =
    `${report.fixture}: ${report.finalTurns} turn(s), ${report.cards} card(s), ` +
    `${report.candidates} candidate(s), ${report.audioSeconds.toFixed(0)}s of audio in ` +
    `${(report.elapsedMs / 1000).toFixed(0)}s`;
  if (report.error !== undefined) {
    return [`${head}`, `  FAIL  did not run: ${report.error}`].join("\n");
  }
  const rows = [
    ["", "check", "detail"],
    ...report.checks.map((one) => [one.ok ? MARK.pass : MARK.fail, one.name, one.detail]),
  ];
  return [
    head,
    renderTable(rows)
      .split("\n")
      // The header rule belongs to the table, not to the page.
      .filter((line, index) => index !== 1)
      .map((line) => `  ${line}`)
      .join("\n"),
    ...latencyLines(report),
    `  folder   ${report.sessionDir ?? "none"}`,
  ].join("\n");
}

/** Whether the run passed: every fixture ran, every check held, cost in budget. */
export function runPassed(report: Omit<E2eRunReport, "passed">): boolean {
  return (
    report.fixtures.length > 0 &&
    report.fixtures.every(
      (fixture) =>
        fixture.error === undefined && fixture.checks.every((check) => check.ok),
    ) &&
    report.totalCostUsd < MAX_RUN_COST_USD
  );
}

/** The whole run, as it goes to the terminal. */
export function renderRun(report: E2eRunReport): string {
  const failed = report.fixtures.flatMap((fixture) =>
    fixture.error !== undefined
      ? [`${fixture.fixture}: did not run`]
      : fixture.checks.filter((check) => !check.ok).map((check) => `${fixture.fixture}: ${check.name}`),
  );
  const checks = report.fixtures.reduce((total, fixture) => total + fixture.checks.length, 0);
  const summary = [
    `${checks - failed.length}/${checks} check(s) passed` +
      (failed.length === 0 ? "" : `; failed: ${failed.join(", ")}`),
    `cost  ${formatUsd(report.totalCostUsd)} = ${formatUsd(report.modelCostUsd)} of model ` +
      `(${report.usage.calls} call(s), ${report.usage.inputTokens} in, ` +
      `${report.usage.outputTokens} out) + ${formatUsd(report.asrCostUsd)} of transcription ` +
      `(${report.audioSeconds.toFixed(0)}s of audio); budget ${formatUsd(MAX_RUN_COST_USD)}`,
    report.passed ? "E2E PASSED" : "E2E FAILED",
  ];
  return [...report.fixtures.map(renderFixture), summary.join("\n")].join("\n\n");
}
