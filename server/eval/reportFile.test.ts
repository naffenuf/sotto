import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalRunRecord } from "../../shared/eval.js";
import { REPORTS_DIR, writeReport } from "./reportFile.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sotto-report-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const record: EvalRunRecord = {
  id: "2026-10-28_120000",
  startedAt: "2026-10-28T12:00:00.000Z",
  finishedAt: "2026-10-28T12:01:00.000Z",
  gitCommit: "abc1234",
  chattiness: ["normal"],
  fixtures: ["brainstorm"],
  judge: { model: "muse-spark-1.3", promptHash: "162841b6b7d8", calls: 0, cacheHits: 0 },
  runs: [
    {
      fixture: "brainstorm",
      chattiness: "normal",
      sessionDir: null,
      durationMs: 1_000,
      finalTurns: 4,
      candidates: 0,
      decisions: 0,
      deliveries: [],
      moments: [],
      matches: [],
      elapsedMs: 10,
    },
  ],
};

describe("writeReport", () => {
  it("names the report after the run it scores and creates the folder", () => {
    const root = tempRoot();
    const { path, score } = writeReport(record, root);
    expect(path).toBe(join(root, REPORTS_DIR, "2026-10-28_120000.md"));
    expect(readFileSync(path, "utf8")).toContain("# Eval report 2026-10-28_120000");
    expect(score.passed).toBe(true);
  });

  it("overwrites, so re-scoring a run leaves one report, not two", () => {
    const root = tempRoot();
    const first = writeReport(record, root).path;
    const second = writeReport({ ...record, gitCommit: "def5678" }, root).path;
    expect(second).toBe(first);
    expect(readFileSync(first, "utf8")).toContain("def5678");
  });

  it("reports a run from before US-016 part 2, which recorded no usage", () => {
    const root = tempRoot();
    const { path } = writeReport(record, root);
    const markdown = readFileSync(path, "utf8");
    expect(markdown).toContain("_No prompt hashes were recorded for this run._");
    expect(markdown).toContain("| estimate | $0.00 |");
  });

  it("folds hand-written notes in, so a re-score does not lose them", () => {
    const root = tempRoot();
    mkdirSync(join(root, REPORTS_DIR), { recursive: true });
    writeFileSync(
      join(root, REPORTS_DIR, `${record.id}-notes.md`),
      "Spot-checked five judge decisions; agreed with all five.\n",
    );
    const { path } = writeReport(record, root);
    const markdown = readFileSync(path, "utf8");
    expect(markdown).toContain("## Notes");
    expect(markdown).toContain("Spot-checked five judge decisions; agreed with all five.");
    // Written again from the same record: the notes are still there.
    expect(readFileSync(writeReport(record, root).path, "utf8")).toContain("## Notes");
  });

  it("leaves the notes section out when nobody wrote any", () => {
    const root = tempRoot();
    expect(readFileSync(writeReport(record, root).path, "utf8")).not.toContain("## Notes");
  });
});
