/**
 * What `npm run e2e` prints (PRD US-021).
 *
 * One table of checks per fixture, the latencies the story asks for, and the
 * bill. Pure, so the layout is unit-tested and the run itself only has to
 * produce the numbers.
 */
import type { E2eFixtureReport, E2eRunReport } from "../../shared/e2e.js";
import { RESEARCH_FIXTURE } from "../../shared/e2e.js";
import {
  estimateAsrCostUsd,
  estimateCostUsd,
  estimateTtsCostUsd,
  formatUsd,
} from "../eval/cost.js";
import { renderTable } from "../eval/report.js";

/**
 * What each conversation is allowed to cost, in US dollars (V2-021).
 *
 * The core PRD put one flat $0.50 on the whole run (US-021), measured at
 * $0.4826 against a pipeline that neither searched nor spoke. V2 gave Sotto
 * both, and both are charged per conversation rather than per run: every
 * fixture now runs the research planner and may spend a grounded search —
 * which resends its whole request each round, so one is tens of thousands of
 * input tokens (V2-013) — and every one of them says hello out loud, which
 * ElevenLabs bills by the character. So the ceiling is a sum of allowances,
 * which also means `--fixtures <one>` is gated on that one rather than on the
 * whole set's headroom.
 *
 * The numbers are the measured cost with room over it, from the first full
 * run of the extended check: brainstorm $0.2471, moment-contradiction
 * $0.3371, ask-search $0.4700, ask-diagram $0.1513 and the research
 * conversation $1.1354. The four core ones share one allowance because what
 * separates them is not the conversation but whether the planner happened to
 * spend a search in it — a 48-second `ask-search` that searched twice cost
 * three times a two-minute `brainstorm` that searched not at all.
 */
export const FIXTURE_BUDGET_USD: Record<string, number> = {
  brainstorm: 0.7,
  "moment-contradiction": 0.7,
  "ask-search": 0.7,
  "ask-diagram": 0.7,
  [RESEARCH_FIXTURE]: 1.6,
};

/** What a conversation nobody has measured yet is allowed to cost. */
export const DEFAULT_FIXTURE_BUDGET_USD = 0.7;

/** What one conversation cost: model calls, transcription and speech. */
export function fixtureCostUsd(report: E2eFixtureReport): number {
  return (
    estimateCostUsd(report.usage) +
    estimateAsrCostUsd(report.audioSeconds) +
    estimateTtsCostUsd(report.voice.characters)
  );
}

/** What one conversation is allowed to cost. */
export function budgetFor(fixture: string): number {
  return FIXTURE_BUDGET_USD[fixture] ?? DEFAULT_FIXTURE_BUDGET_USD;
}

/** What the fixtures in `report` are between them allowed to cost. */
export function runBudgetUsd(fixtures: readonly { fixture: string }[]): number {
  return fixtures.reduce((total, one) => total + budgetFor(one.fixture), 0);
}

const MARK = { pass: "ok  ", fail: "FAIL" } as const;

/** `1.4s`, or `—` for a latency this run could not measure. */
function seconds(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

/** The lines under one fixture's table: its latencies, its research, its bill. */
function detailLines(report: E2eFixtureReport): string[] {
  const lines: string[] = [];
  const { wakeToHeadlineMs, wakeToDoneMs, ackMs, firstAudioMs, moments } = report.latency;
  if (wakeToHeadlineMs !== null || wakeToDoneMs !== null) {
    lines.push(
      `  latency  wake -> headline ${seconds(wakeToHeadlineMs)}, ` +
        `wake -> done ${seconds(wakeToDoneMs)}`,
    );
  }
  // V2-021: what the room heard, in real milliseconds. A briefing has no
  // acknowledgment by design — it goes straight to speech — so the dash is a
  // result rather than a gap in the measurement.
  if (ackMs !== null || firstAudioMs !== null) {
    lines.push(
      `  voice    ack ${seconds(ackMs)}, first audio ${seconds(firstAudioMs)}` +
        (report.voice.characters === 0
          ? ""
          : `; ${report.voice.utterances} utterance(s), ` +
            `${report.voice.characters} character(s)`),
    );
  }
  const { research } = report;
  if (research.ideas > 0 || research.packets > 0) {
    lines.push(
      `  research ${research.ideas} idea(s), ${research.queued} queued, ` +
        `${research.rejected} rejected, ${research.packets} packet(s)` +
        (research.unsourced === 0 ? "" : `, ${research.unsourced} unsourced`) +
        (research.failed === 0 ? "" : `, ${research.failed} failed`) +
        `; ${research.cardAtMs.length} card(s)` +
        (research.cardAtMs.length === 0
          ? ""
          : ` at ${research.cardAtMs.map((atMs) => seconds(atMs)).join(", ")}`) +
        `; ${research.localGateCalls} local gate call(s)`,
    );
  }
  lines.push(
    `  cost     ${formatUsd(fixtureCostUsd(report))} of a ` +
      `${formatUsd(budgetFor(report.fixture))} allowance (${report.usage.calls} call(s), ` +
      `${report.usage.inputTokens} in, ${report.usage.outputTokens} out, ` +
      `${report.audioSeconds.toFixed(0)}s of audio, ${report.voice.characters} spoken character(s))`,
  );
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
    ...detailLines(report),
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
    report.totalCostUsd < runBudgetUsd(report.fixtures)
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
      `(${report.audioSeconds.toFixed(0)}s of audio) + ${formatUsd(report.ttsCostUsd)} of speech ` +
      `(${report.ttsCharacters} character(s)); budget ${formatUsd(runBudgetUsd(report.fixtures))}`,
    report.passed ? "E2E PASSED" : "E2E FAILED",
  ];
  return [...report.fixtures.map(renderFixture), summary.join("\n")].join("\n\n");
}
