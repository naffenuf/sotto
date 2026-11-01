import { describe, expect, it } from "vitest";
import type { EvalRunRecord, FixtureRunRecord } from "../../shared/eval.js";
import { headlines, renderReportMarkdown, renderTable, renderTerminalReport } from "./report.js";
import { scoreRun } from "./score.js";

/**
 * One small run with everything a report has to render: a caught moment, a
 * missed one, a false interject on a quiet fixture and a replay that failed.
 */
const runs: FixtureRunRecord[] = [
  {
    fixture: "brainstorm",
    chattiness: "normal",
    sessionDir: "/tmp/brainstorm",
    durationMs: 180_000,
    finalTurns: 40,
    candidates: 1,
    decisions: 2,
    gateCalls: [
      {
        candidateId: "cand-9",
        gate: "spark-fallback",
        score: 0.72,
        observerScore: 0.72,
        latencyMs: 3_000,
        error: "Glimmer is unavailable",
      },
    ],
    deliveries: [
      {
        cardId: "card-cand-9",
        candidateId: "cand-9",
        type: "untested_assumption",
        level: "interject",
        headline: "Nobody has checked the pipe | yet",
        detail: "detail",
        whyNow: "pause",
        deliveredAtMs: 90_000,
        inPause: true,
        pause: { speaking: false, silentForMs: 1_800 },
        reason: "delivered",
        score: 0.72,
      },
    ],
    moments: [],
    matches: [],
    elapsedMs: 50_000,
  },
  {
    fixture: "moment-contradiction",
    chattiness: "normal",
    sessionDir: "/tmp/contradiction",
    durationMs: 130_000,
    finalTurns: 26,
    candidates: 1,
    decisions: 2,
    gateCalls: [
      { candidateId: "cand-1", gate: "glimmer", score: 0.81, observerScore: 0.9, latencyMs: 17_000 },
      { candidateId: "cand-2", gate: "glimmer", score: 0.2, observerScore: 0.7, latencyMs: 21_000 },
    ],
    deliveries: [
      {
        cardId: "card-cand-1",
        candidateId: "cand-1",
        type: "contradiction",
        level: "interject",
        headline: "The $20k studio breaks the $4k cap",
        detail: "detail",
        whyNow: "pause",
        deliveredAtMs: 110_000,
        inPause: true,
        pause: { speaking: false, silentForMs: 3_000 },
        reason: "delivered",
        score: 0.81,
      },
    ],
    moments: [
      {
        id: "budget-contradiction",
        type: "contradiction",
        expectedLevel: "interject",
        description: "the $4k cap is contradicted",
        triggerLine: 10,
        deadlineLine: 14,
        triggerEndMs: 99_877,
        deadlineEndMs: 118_048,
        setupTurnIds: ["0:4"],
        triggerTurnIds: ["0:10"],
        triggerTurnEndMs: 102_000,
        deadlineTurnEndMs: 120_000,
      },
      {
        id: "scope-assumption",
        type: "untested_assumption",
        expectedLevel: "glow",
        description: "nobody tested the scope",
        triggerLine: 18,
        deadlineLine: 22,
        triggerEndMs: 125_000,
        deadlineEndMs: 129_000,
        setupTurnIds: [],
        triggerTurnIds: [],
        triggerTurnEndMs: null,
        deadlineTurnEndMs: null,
      },
    ],
    matches: [
      {
        cardId: "card-cand-1",
        momentId: "budget-contradiction",
        matches: true,
        reason: "the card names both figures",
        cached: true,
      },
      {
        cardId: "card-cand-1",
        momentId: "scope-assumption",
        matches: false,
        reason: "different issue",
        cached: false,
      },
    ],
    elapsedMs: 60_000,
  },
  {
    fixture: "moment-fact",
    chattiness: "normal",
    sessionDir: null,
    durationMs: 0,
    finalTurns: 0,
    candidates: 0,
    decisions: 0,
    deliveries: [],
    moments: [],
    matches: [],
    elapsedMs: 100,
    error: "no captured events for moment-fact",
  },
];

const record: EvalRunRecord = {
  id: "2026-10-28_120000",
  startedAt: "2026-10-28T12:00:00.000Z",
  finishedAt: "2026-10-28T12:12:00.000Z",
  gitCommit: "abc1234+",
  chattiness: ["normal"],
  gate: "glimmer",
  fixtures: ["brainstorm", "moment-contradiction", "moment-fact"],
  judge: { model: "muse-spark-1.3", promptHash: "162841b6b7d8", calls: 1, cacheHits: 1 },
  promptHashes: [
    { file: "server/prompts/board.md", hash: "aaaaaaaaaaaa" },
    { file: "server/prompts/observer.md", hash: "bbbbbbbbbbbb" },
  ],
  usage: { calls: 42, inputTokens: 300_000, outputTokens: 60_000, reasoningTokens: 48_000 },
  runs,
};

describe("renderTable", () => {
  it("pads every column to its widest cell and rules off the header", () => {
    const table = renderTable([
      ["fixture", "n"],
      ["brainstorm", "40"],
      ["x", "1"],
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toBe("fixture     n");
    expect(lines[1]).toBe("----------  --");
    expect(lines[2]).toBe("brainstorm  40");
    // The last column is not padded, so there is no trailing whitespace.
    expect(lines.every((line) => line === line.trimEnd())).toBe(true);
  });

  it("is empty for no rows", () => {
    expect(renderTable([])).toBe("");
  });
});

describe("headlines", () => {
  it("states the three metrics the PRD asks to be printed", () => {
    const score = scoreRun(record);
    const group = score.groups[0];
    if (group === undefined) throw new Error("no group");
    const metrics = new Map(headlines(group).map((one) => [one.label, one.value]));
    expect(metrics.get("moment recall")).toContain("1/2 (50%)");
    expect(metrics.get("moment recall")).toContain("caught 1, low 0, late 0, missed 1");
    expect(metrics.get("interject precision")).toBe("1/2 (50%)");
    expect(metrics.get("false interjects on brainstorm + no-wake")).toBe("1");
    expect(metrics.get("deliveries in a pause")).toContain("2/2 (100%)");
    expect(metrics.get("deliveries in a pause")).toContain("8.0s");
  });

  it("states the gate's own numbers, latency first (V2-016)", () => {
    const score = scoreRun(record);
    const group = score.groups[0];
    if (group === undefined) throw new Error("no group");
    const metrics = new Map(headlines(group).map((one) => [one.label, one.value]));
    const gate = metrics.get("judgment gate (glimmer)");
    expect(gate).toContain("3 call(s)");
    expect(gate).toContain("2 on Glimmer, 1 on Spark");
    expect(gate).toContain("1 with no verdict");
    // Median of 3s, 17s and 21s.
    expect(gate).toContain("median latency 17.0s");
    expect(gate).toContain("max 21.0s");
  });

  it("says the observer scored its own candidates when the gate was spark", () => {
    const score = scoreRun({ ...record, gate: "spark" });
    const group = score.groups[0];
    if (group === undefined) throw new Error("no group");
    const metrics = new Map(headlines(group).map((one) => [one.label, one.value]));
    expect(metrics.get("judgment gate (spark)")).toContain("the observer's own scores");
  });

  it("reads a run recorded before V2-016 as the spark baseline", () => {
    const { gate: _dropped, ...before } = record;
    const group = scoreRun(before).groups[0];
    if (group === undefined) throw new Error("no group");
    expect(group.gate.mode).toBe("spark");
  });
});

describe("renderTerminalReport", () => {
  const text = renderTerminalReport(record, scoreRun(record));

  it("shows a row per fixture with its replay counts", () => {
    expect(text).toContain("=== chattiness: normal ===");
    expect(text).toMatch(/brainstorm\s+40\s+1\s+1/);
    expect(text).toContain("moment-fact (FAILED)");
  });

  it("shows a row per moment, with the outcome and the delay", () => {
    expect(text).toMatch(/budget-contradiction\s+contradiction\s+interject\s+interject\s+caught/);
    expect(text).toMatch(/scope-assumption\s+untested_assumption\s+glow\s+—\s+missed\s+—/);
  });

  it("marks each gate pass or fail with why", () => {
    expect(text).toContain("[FAIL] moment recall >= 0.7 — 0.50");
    expect(text).toContain("[FAIL] no false interject on brainstorm or no-wake — 1 found");
    expect(text).toContain("[PASS] every delivery in a pause — 2/2 (1.00)");
    expect(text).toContain("[FAIL] every replay completed — 1 failed");
  });

  it("says so when judging was skipped rather than quietly scoring zero", () => {
    const unjudged: EvalRunRecord = {
      ...record,
      judge: { ...record.judge, promptHash: "" },
    };
    const text = renderTerminalReport(unjudged, scoreRun(unjudged));
    expect(text).toContain("judging was skipped");
    expect(text).toContain("[SKIP] moment recall");
  });
});

describe("renderReportMarkdown", () => {
  const markdown = renderReportMarkdown({
    record,
    score: scoreRun(record),
    promptHashes: record.promptHashes ?? [],
    usage: record.usage ?? { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  });

  it("leads with the run and whether the gates passed", () => {
    expect(markdown.startsWith("# Eval report 2026-10-28_120000")).toBe(true);
    expect(markdown).toContain("**Gates: FAIL**");
  });

  it("records the settings, the commit and the judge prompt", () => {
    expect(markdown).toContain("| git commit | abc1234+ |");
    expect(markdown).toContain("| chattiness | normal |");
    expect(markdown).toContain("| gate | glimmer |");
    expect(markdown).toContain("| judge prompt | 162841b6b7d8 |");
    expect(markdown).toContain("| judge calls | 1 (1 cached) |");
    expect(markdown).toContain("- **interject precision**: 1/2 (50%)");
    expect(markdown).toContain("| recall gate | >= 0.7 |");
  });

  it("records a hash per prompt file", () => {
    expect(markdown).toContain("| server/prompts/observer.md | bbbbbbbbbbbb |");
  });

  it("estimates the API cost from the tokens the calls reported", () => {
    // 300k input at $1.25/M plus 60k output at $4.25/M.
    expect(markdown).toContain("| estimate | $0.6300 |");
    expect(markdown).toContain("| model calls | 42 |");
  });

  it("has a per-moment table and a per-delivery table", () => {
    expect(markdown).toContain("### Per moment");
    expect(markdown).toContain("| moment-contradiction | budget-contradiction |");
    expect(markdown).toContain("### Deliveries");
    expect(markdown).toContain("| budget-contradiction |");
    // A card matching nothing is named as matching nothing.
    expect(markdown).toContain("| _none_ |");
  });

  it("escapes a pipe in a headline so the table survives it", () => {
    expect(markdown).toContain("Nobody has checked the pipe \\| yet");
  });

  it("quotes the judge on every moment it matched", () => {
    expect(markdown).toContain("**budget-contradiction** (caught): the card names both figures");
  });

  it("names the replays that failed", () => {
    expect(markdown).toContain("- **moment-fact**: no captured events for moment-fact");
  });

  it("says when a run has no prompt hashes rather than printing an empty table", () => {
    const bare = renderReportMarkdown({
      record,
      score: scoreRun(record),
      promptHashes: [],
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    });
    expect(bare).toContain("_No prompt hashes were recorded for this run._");
    expect(bare).toContain("| estimate | $0.00 |");
  });
});

describe("the totals row", () => {
  it("closes the per-fixture table with the run's own sums", () => {
    const text = renderTerminalReport(record, scoreRun(record));
    // 40 + 26 turns, 1 + 1 candidates, 2 deliveries, 1 caught, 1 missed.
    expect(text).toMatch(/all\s+66\s+2\s+2\s+2\/2\s+1\s+0\s+0\s+1\s+1\/0/);
  });
});
