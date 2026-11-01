/**
 * The report (PRD US-016 part 2).
 *
 * Two renderings of the same {@link RunScore}: a table for the terminal, so
 * `npm run eval` ends with the answer rather than a file path, and the
 * markdown that lands in `eval/reports/<run id>.md` — per-moment table,
 * totals, the settings, the commit, the prompt hashes and the estimated cost,
 * which together are what makes a number from last Tuesday worth comparing
 * to one from today.
 *
 * Pure: everything it needs is in the run record or handed in, so the report
 * for any run can be rebuilt from `eval/runs/` at any time.
 */
import type { EvalRunRecord } from "../../shared/eval.js";
import { policySettingsLabel } from "../../shared/policy.js";
import { estimateCostUsd, formatUsd, type TokenUsage } from "./cost.js";
import type {
  FixtureScore,
  GateResult,
  GateScore,
  MomentScore,
  PathGateScore,
  RunScore,
  ScoreTotals,
  SettingsScore,
} from "./score.js";
import {
  MIN_MOMENT_RECALL,
  MIN_RESEARCH_RECALL,
  settingsAsked,
  settingsOf,
} from "./score.js";

/** A moment's outcome as a reader sees it. */
const OUTCOME_LABEL = {
  caught: "caught",
  caught_low: "caught low",
  late: "late",
  missed: "missed",
} as const;

/** `1.2s`, `-0.4s`, or `—` for a moment nothing matched. */
function seconds(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}

/** `2/3 (67%)`. */
function fraction(part: number, whole: number): string {
  return `${part}/${whole} (${whole === 0 ? "—" : percent(part / whole)})`;
}

const GATE_MARK = { pass: "PASS", fail: "FAIL", skipped: "SKIP" } as const;

/** Pads every column to its widest cell. The first row is the header. */
export function renderTable(rows: readonly string[][]): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  const line = (row: readonly string[]): string =>
    row
      .map((cell, index) => cell.padEnd(index === row.length - 1 ? 0 : (widths[index] as number)))
      .join("  ")
      .trimEnd();
  const [header, ...body] = rows as [string[], ...string[][]];
  const rule = widths.map((width) => "-".repeat(width)).join("  ");
  return [line(header), rule, ...body.map(line)].join("\n");
}

/** One row per planted moment, in the order the fixtures ran. */
function momentRows(group: SettingsScore): string[][] {
  const rows: string[][] = [["fixture", "moment", "type", "want", "got", "outcome", "delay"]];
  for (const fixture of group.fixtures) {
    for (const moment of fixture.moments) {
      rows.push(momentRow(fixture, moment));
    }
  }
  return rows;
}

function momentRow(fixture: FixtureScore, moment: MomentScore): string[] {
  return [
    fixture.fixture,
    moment.momentId,
    moment.type,
    moment.expectedLevel,
    moment.deliveredLevel ?? "—",
    OUTCOME_LABEL[moment.outcome],
    seconds(moment.delayMs),
  ];
}

/**
 * One row per fixture and a totals row, which is the line a tuning run reads
 * first: what it delivered and what that did for the score.
 */
function fixtureRows(group: SettingsScore): string[][] {
  const rows: string[][] = [
    ["fixture", "turns", "cand", "deliv", "in pause", "caught", "low", "late", "missed", "false i/g"],
  ];
  for (const fixture of group.fixtures) {
    rows.push([
      fixture.error === undefined ? fixture.fixture : `${fixture.fixture} (FAILED)`,
      "",
      "",
      String(fixture.deliveries.length),
      `${fixture.deliveriesInPause}/${fixture.deliveries.length}`,
      String(fixture.caught),
      String(fixture.caughtLow),
      String(fixture.late),
      String(fixture.missed),
      `${fixture.falseInterjects}/${fixture.falseGlows}`,
    ]);
  }
  const { totals } = group;
  rows.push([
    "all",
    "",
    "",
    String(totals.deliveries),
    `${totals.deliveriesInPause}/${totals.deliveries}`,
    String(totals.caught),
    String(totals.caughtLow),
    String(totals.late),
    String(totals.missed),
    `${totals.falseInterjects}/${totals.falseGlows}`,
  ]);
  return rows;
}

/**
 * The run record's own counts, which the score does not carry: turns and
 * candidates are about the replay, not about the choosing.
 */
function withReplayCounts(rows: string[][], record: EvalRunRecord, group: SettingsScore): string[][] {
  return rows.map((row, index) => {
    if (index === 0) return row;
    const fixture = group.fixtures[index - 1];
    const label = policySettingsLabel(group.settings);
    const runsHere = record.runs.filter((one) => policySettingsLabel(settingsOf(one)) === label);
    // The last row is the totals row, which has no fixture of its own.
    const mine =
      fixture === undefined ? runsHere : runsHere.filter((one) => one.fixture === fixture.fixture);
    const next = [...row];
    next[1] = String(mine.reduce((total, one) => total + one.finalTurns, 0));
    next[2] = String(mine.reduce((total, one) => total + one.candidates, 0));
    return next;
  });
}

/** One headline metric, so the terminal and the markdown can lay it out their own way. */
export interface Headline {
  label: string;
  value: string;
}

/** The headline metrics, in the order the PRD names them. */
export function headlines(group: SettingsScore): Headline[] {
  const { totals } = group;
  return [
    {
      label: "moment recall",
      value:
        `${fraction(totals.caught + totals.caughtLow, totals.moments)}` +
        ` — caught ${totals.caught}, low ${totals.caughtLow}, late ${totals.late}, missed ${totals.missed}`,
    },
    {
      label: "research recall",
      value:
        `${fraction(totals.researchCaught, totals.researchMoments)}` +
        ` — caught ${totals.researchCaught}, late ${totals.researchLate},` +
        ` missed ${totals.researchMissed}`,
    },
    {
      label: "interject precision",
      value: fraction(totals.trueInterjects, totals.interjects),
    },
    {
      label: "research packets",
      value: describeResearch(totals),
    },
    {
      label: "false interjects on brainstorm + no-wake",
      value: String(totals.quietFalseInterjects),
    },
    {
      label: `interjection gate (${group.gate.mode})`,
      value: describeGate(group.gate),
    },
    {
      label: "research gate (glimmer)",
      value: describeResearchGate(group.researchGate),
    },
    {
      label: "deliveries in a pause",
      value:
        `${fraction(totals.deliveriesInPause, totals.deliveries)}` +
        `, median delay from the trigger line ${seconds(group.medianDelayMs)}`,
    },
  ];
}

/**
 * `12 call(s), 12 on Glimmer, median 17.0s (max 21.4s)`, or what `--gate
 * spark` has instead: no calls at all, which is the baseline.
 */
function describeGate(gate: GateScore): string {
  if (gate.mode === "spark") return "not used — the observer's own scores stand";
  if (gate.calls === 0) return "no candidates reached it";
  const where =
    gate.local === gate.calls
      ? "all on Glimmer"
      : `${gate.local} on Glimmer, ${gate.calls - gate.local} on Spark`;
  return (
    `${gate.calls} call(s), ${where}` +
    (gate.failed > 0 ? `, ${gate.failed} with no verdict` : "") +
    `, median latency ${seconds(gate.medianLatencyMs)} (max ${seconds(gate.maxLatencyMs)})`
  );
}

/**
 * The other judgment path (V3-001): the one Glimmer kept, because nobody is
 * waiting on it out loud. Reported next to the interjection gate's so the
 * two latencies can be read against the windows they sit inside.
 */
function describeResearchGate(gate: PathGateScore): string {
  if (gate.calls === 0) return "no ideas reached it";
  const where =
    gate.local === gate.calls
      ? "all on Glimmer"
      : `${gate.local} on Glimmer, ${gate.calls - gate.local} on Spark`;
  return (
    `${gate.calls} call(s), ${where}` +
    (gate.failed > 0 ? `, ${gate.failed} with no verdict` : "") +
    (gate.medianLatencyMs === null
      ? ", latency not recorded"
      : `, median latency ${seconds(gate.medianLatencyMs)} (max ${seconds(gate.maxLatencyMs)})`)
  );
}

/**
 * `3 packet(s) from 7 idea(s), 1 unsourced, 0 failed; 3 card(s), 3 in a pause`.
 *
 * The unsourced count is in the headline on purpose (v2 PRD V2-019): a
 * discarded packet is a search that was paid for and showed nobody anything,
 * which is the number to watch when the research prompts are tuned.
 */
function describeResearch(totals: ScoreTotals): string {
  if (totals.researchIdeas === 0 && totals.researchCards === 0) {
    return "nothing was looked up";
  }
  return (
    `${totals.researchPackets} packet(s) from ${totals.researchIdeas} idea(s)` +
    ` (${totals.researchQueued} queued, ${totals.researchRejected} rejected)` +
    `, ${totals.unsourcedPackets} unsourced, ${totals.failedPackets} failed` +
    `; ${totals.researchCards} card(s), ` +
    `${totals.researchCardsInPause} in a pause` +
    (totals.researchCardsAtSessionEnd > 0
      ? `, ${totals.researchCardsAtSessionEnd} after the conversation ended`
      : "")
  );
}

/** One row per fixture: what the research pipeline did in each conversation. */
function researchRows(group: SettingsScore): string[][] {
  const rows: string[][] = [
    ["fixture", "ideas", "queued", "packets", "unsourced", "failed", "cards", "in pause"],
  ];
  for (const fixture of group.fixtures) {
    const research = fixture.research;
    rows.push([
      fixture.fixture,
      String(research?.ideas ?? 0),
      String(research?.queued ?? 0),
      String(research?.packets ?? 0),
      String(research?.unsourced ?? 0),
      String(research?.failed ?? 0),
      String(fixture.researchCards.length),
      `${fixture.researchCards.filter((one) => one.inPause).length}/${fixture.researchCards.length}`,
    ]);
  }
  const { totals } = group;
  rows.push([
    "all",
    String(totals.researchIdeas),
    String(totals.researchQueued),
    String(totals.researchPackets),
    String(totals.unsourcedPackets),
    String(totals.failedPackets),
    String(totals.researchCards),
    `${totals.researchCardsInPause}/${totals.researchCards}`,
  ]);
  return rows;
}

/**
 * Calls that ran on the local model, over the whole run: the candidate gate's
 * (V2-016) and the research gate's (V2-012).
 *
 * They are counted rather than priced because Muse Glimmer runs on this Mac —
 * it bills nothing, and a report that said `$0.00` with no count would read
 * as though no judgment had happened at all.
 */
function localCalls(score: RunScore): number {
  return score.groups.reduce(
    (total, group) => total + group.gate.local + group.totals.localResearchGateCalls,
    0,
  );
}

function gateLines(gates: readonly GateResult[]): string[] {
  return gates.map((gate) => `[${GATE_MARK[gate.status]}] ${gate.name} — ${gate.detail}`);
}

/** What `npm run eval` prints when the replaying is done. */
export function renderTerminalReport(record: EvalRunRecord, score: RunScore): string {
  const parts: string[] = [];
  for (const group of score.groups) {
    parts.push(`\n=== frequency/boldness: ${policySettingsLabel(group.settings)} ===`);
    parts.push(renderTable(withReplayCounts(fixtureRows(group), record, group)));
    if (group.totals.moments > 0) {
      parts.push("");
      parts.push(renderTable(momentRows(group)));
    }
    if (group.totals.researchIdeas > 0 || group.totals.researchCards > 0) {
      parts.push("");
      parts.push(renderTable(researchRows(group)));
    }
    parts.push("");
    parts.push(
      renderTable([
        ["metric", "value"],
        ...headlines(group).map((one) => [one.label, one.value]),
      ]),
    );
    parts.push("");
    parts.push(...gateLines(group.gates));
  }
  if (!score.judged) {
    parts.push("");
    parts.push("judging was skipped (--no-judge): recall and precision are not measured.");
  }
  return parts.join("\n");
}

/** A markdown table from the same rows the terminal gets. */
function markdownTable(rows: readonly string[][]): string {
  if (rows.length === 0) return "";
  const [header, ...body] = rows as [string[], ...string[][]];
  const row = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  return [
    row(header),
    row(header.map(() => "---")),
    ...body.map((cells) => row(cells)),
  ].join("\n");
}

export interface ReportContext {
  record: EvalRunRecord;
  score: RunScore;
  /** `server/prompts/*.md` and their hashes: the run's other inputs. */
  promptHashes: readonly { file: string; hash: string }[];
  usage: TokenUsage;
  /**
   * Markdown written by hand about this run — the spot-check of the judge's
   * decisions US-023 asks for, say. It is kept in its own file next to the
   * report (`<id>-notes.md`) rather than typed into the report, because
   * `npm run eval:report` rebuilds the report from the run record and would
   * otherwise overwrite it.
   */
  notes?: string;
}

/** `eval/reports/<run id>.md`. */
export function renderReportMarkdown(context: ReportContext): string {
  const { record, score, promptHashes, usage } = context;
  const out: string[] = [];
  out.push(`# Eval report ${record.id}`);
  out.push("");
  out.push(score.passed ? "**Gates: PASS**" : "**Gates: FAIL**");
  out.push("");
  out.push("## Settings");
  out.push("");
  out.push(markdownTable([
    ["setting", "value"],
    ["run", record.id],
    ["started", record.startedAt],
    ["finished", record.finishedAt],
    ["git commit", record.gitCommit ?? "(not a checkout)"],
    ["frequency/boldness", settingsAsked(record).map(policySettingsLabel).join(", ")],
    ["interjection gate", record.gate ?? "spark (recorded before V2-016)"],
    ["fixtures", record.fixtures.join(", ")],
    ["judge model", record.judge.model],
    ["judge prompt", record.judge.promptHash === "" ? "(judging skipped)" : record.judge.promptHash],
    ["judge calls", `${record.judge.calls} (${record.judge.cacheHits} cached)`],
    ["recall gate", `>= ${MIN_MOMENT_RECALL}`],
    ["research recall gate", `>= ${MIN_RESEARCH_RECALL}`],
  ]));
  out.push("");
  out.push("## Prompts");
  out.push("");
  out.push(
    promptHashes.length === 0
      ? "_No prompt hashes were recorded for this run._"
      : markdownTable([
          ["file", "sha256 (12)"],
          ...promptHashes.map((one) => [one.file, one.hash]),
        ]),
  );
  out.push("");
  out.push("## Estimated API cost");
  out.push("");
  out.push(
    markdownTable([
      ["", "value"],
      ["model calls", String(usage.calls)],
      ["input tokens", usage.inputTokens.toLocaleString("en-US")],
      ["output tokens", usage.outputTokens.toLocaleString("en-US")],
      ["of which reasoning", usage.reasoningTokens.toLocaleString("en-US")],
      ["local calls (Glimmer, $0)", String(localCalls(score))],
      ["estimate", formatUsd(estimateCostUsd(usage))],
    ]),
  );
  out.push("");
  out.push(
    "Replays cost no transcription: the conversations are captured events. " +
      "The estimate prices input and output tokens at the published Muse Spark 1.3 " +
      "rates and does not include the verifier's or the research runner's web " +
      "searches. Every call the research pipeline made at Muse Spark — the " +
      "planner, a gate verdict that fell back to the cloud, and each search — is " +
      "in the tokens above, because they all go through the one metered client; " +
      "the calls that ran on Muse Glimmer are counted and priced at nothing, " +
      "since it runs on this Mac.",
  );

  for (const group of score.groups) {
    out.push("");
    out.push(`## Frequency/boldness: ${policySettingsLabel(group.settings)}`);
    out.push("");
    out.push(...headlines(group).map((one) => `- **${one.label}**: ${one.value}`));
    out.push("");
    out.push("### Gates");
    out.push("");
    out.push(...gateLines(group.gates).map((line) => `- ${line}`));
    out.push("");
    out.push("### Per fixture");
    out.push("");
    out.push(markdownTable(withReplayCounts(fixtureRows(group), record, group)));
    out.push("");
    out.push("### Per moment");
    out.push("");
    out.push(
      group.totals.moments === 0
        ? "_No planted moments in this run._"
        : markdownTable(momentRows(group)),
    );
    out.push("");
    out.push("### Deliveries");
    out.push("");
    out.push(
      group.totals.deliveries === 0
        ? "_Nothing was delivered._"
        : markdownTable([
            ["fixture", "card", "level", "type", "at", "pause", "reason", "score", "matched", "headline"],
            ...group.fixtures.flatMap((fixture) =>
              fixture.deliveries.map((delivery) => [
                fixture.fixture,
                delivery.cardId,
                delivery.level,
                delivery.type ?? "—",
                seconds(delivery.deliveredAtMs),
                delivery.inPause ? "yes" : "**NO**",
                delivery.reason ?? "—",
                delivery.score === null ? "—" : delivery.score.toFixed(2),
                delivery.matchedMomentIds.join(", ") || "_none_",
                delivery.headline.replace(/\|/g, "\\|"),
              ]),
            ),
          ]),
    );
    out.push("");
    out.push("### Research");
    out.push("");
    out.push(
      group.totals.researchIdeas === 0 && group.totals.researchCards === 0
        ? "_Nothing was looked up._"
        : markdownTable(researchRows(group)),
    );
    if (group.totals.researchCards > 0) {
      out.push("");
      out.push(
        markdownTable([
          ["fixture", "card", "at", "pause", "at end", "matched", "title"],
          ...group.fixtures.flatMap((fixture) =>
            fixture.researchCards.map((card) => [
              fixture.fixture,
              card.cardId,
              seconds(card.deliveredAtMs),
              card.inPause ? "yes" : "no",
              card.atSessionEnd ? "yes" : "no",
              card.matchedMomentIds.join(", ") || "_none_",
              card.title.replace(/\|/g, "\\|"),
            ]),
          ),
        ]),
      );
    }
    const judged = group.fixtures
      .flatMap((fixture) => fixture.moments)
      .filter((moment) => moment.judgeReason !== null);
    if (judged.length > 0) {
      out.push("");
      out.push("### Judge notes");
      out.push("");
      for (const moment of judged) {
        out.push(`- **${moment.momentId}** (${OUTCOME_LABEL[moment.outcome]}): ${moment.judgeReason}`);
      }
    }
    const failures = group.fixtures.filter((fixture) => fixture.error !== undefined);
    if (failures.length > 0) {
      out.push("");
      out.push("### Replay failures");
      out.push("");
      for (const fixture of failures) out.push(`- **${fixture.fixture}**: ${fixture.error}`);
    }
  }
  if (context.notes !== undefined && context.notes.trim() !== "") {
    out.push("");
    out.push("## Notes");
    out.push("");
    out.push(context.notes.trim());
  }
  out.push("");
  return `${out.join("\n")}`;
}
