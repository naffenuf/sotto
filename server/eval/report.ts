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
  SpokenScore,
} from "./score.js";
import {
  MIN_MOMENT_RECALL,
  MIN_RESEARCH_RECALL,
  MIN_SPEAK_RECALL,
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
  const rows: string[][] = [
    ["fixture", "moment", "type", "want", "got", "outcome", "delay", "claimed"],
  ];
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
    // V3-015, scored apart from the catch: Sotto said it would look this up.
    moment.reserved === null ? "—" : seconds(moment.reserved.questionToReserveMs),
  ];
}

/**
 * One row per unprompted line (V3-010), in the order they were said.
 *
 * The columns the story asks for, in its own order: which moment it was about,
 * what kind of line it was, what it said, the two latencies a claim and an
 * answer have, how long it waited for a pause, what the still-current check
 * thought and how many times the room talked over it. `pause` and `over` are
 * here too because they are what two of the gates read.
 */
function spokenRows(group: SettingsScore, escape = false): string[][] {
  const rows: string[][] = [
    [
      "fixture",
      "moment",
      "kind",
      "said",
      "at",
      "pause",
      "claim",
      "speech",
      "waited",
      "current",
      "yields",
      "over",
      "text",
    ],
  ];
  for (const fixture of group.fixtures) {
    for (const line of fixture.spoken) rows.push(spokenRow(fixture, line, escape));
  }
  return rows;
}

function spokenRow(fixture: FixtureScore, line: SpokenScore, escape: boolean): string[] {
  return [
    fixture.fixture,
    line.matchedMomentIds.join(", ") ||
      (line.falseSpeech ? "**FALSE SPEECH**" : line.unprompted ? "_none_" : "(asked for)"),
    line.kind,
    line.spoken ? "yes" : `no (${line.reason ?? "—"})`,
    seconds(line.atMs),
    line.inPause === null ? "—" : line.inPause ? "yes" : "**NO**",
    seconds(line.questionToReserveMs),
    seconds(line.questionToSpeechMs),
    seconds(line.pauseWaitMs),
    line.stillCurrent ?? "—",
    String(line.yields),
    // `?` rather than `—` for a line this run could not tell about: a `max`
    // replay spends no time speaking, so it never knows (V3-010).
    !line.spoken ? "—" : !line.overrunMeasured ? "?" : line.overTurnId ?? "—",
    escape ? line.text.replace(/\|/g, "\\|") : line.text,
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

/**
 * How many moments the run planted, in every bucket.
 *
 * `totals.moments` is the policy's bucket alone (V2-019, V3-010), so a run
 * whose only moments are research hooks or spoken questions would otherwise
 * have its per-moment table hidden.
 */
function plantedMoments(group: SettingsScore): number {
  return group.fixtures.reduce((total, fixture) => total + fixture.moments.length, 0);
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
      label: "speak recall",
      value:
        `${fraction(totals.speakCaught, totals.speakMoments)}` +
        ` — caught ${totals.speakCaught}, card only ${totals.speakCaughtLow},` +
        ` late ${totals.speakLate}, missed ${totals.speakMissed}`,
    },
    {
      label: "unprompted speech",
      value: describeSpeech(totals),
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
 * `4 line(s) heard, 4 in a pause, 0 false, 0 over a human turn; 2 claim(s)`.
 *
 * The lines Sotto *decided against* are the other half of the story and are
 * counted separately, because at the default settings most of what the fast
 * path produces is a card and no sentence — and the reasons are in the table
 * below, which is where a tuning run looks next.
 */
function describeSpeech(totals: ScoreTotals): string {
  if (totals.spokenLines === 0 && totals.spokenSkipped === 0 && totals.calledOn === 0) {
    return "Sotto said nothing unprompted";
  }
  return (
    `${totals.spokenLines} line(s) heard, ` +
    `${totals.spokenInPause}/${totals.spokenPlaced} in a pause, ` +
    `${totals.falseSpeech} false, ` +
    (totals.spokenOverrunMeasured === 0
      ? "overruns not measurable here"
      : `${totals.spokenOverHuman} over a human turn`) +
    "; " +
    `${totals.reservations} claim(s)` +
    (totals.calledOn === 0 ? "" : `, ${totals.calledOn} called for`) +
    `, ${totals.spokenSkipped} decided against`
  );
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
    if (plantedMoments(group) > 0) {
      parts.push("");
      parts.push(renderTable(momentRows(group)));
    }
    if (group.totals.researchIdeas > 0 || group.totals.researchCards > 0) {
      parts.push("");
      parts.push(renderTable(researchRows(group)));
    }
    if (group.fixtures.some((fixture) => fixture.spoken.length > 0)) {
      parts.push("");
      parts.push(renderTable(spokenRows(group)));
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
    ["speak recall gate", `>= ${MIN_SPEAK_RECALL}`],
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
      "since it runs on this Mac. Nothing is synthesized either: a replay " +
      "speaks through `transcriptOnlyVoice`, so the unprompted lines below " +
      "are real decisions with no ElevenLabs bill and no audio latencies — " +
      "`npm run e2e` is the clock that charges for those.",
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
      plantedMoments(group) === 0
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
    out.push("");
    out.push("### Unprompted speech");
    out.push("");
    out.push(
      group.fixtures.every((fixture) => fixture.spoken.length === 0)
        ? "_Sotto said nothing unprompted._"
        : markdownTable(spokenRows(group, true)),
    );
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
