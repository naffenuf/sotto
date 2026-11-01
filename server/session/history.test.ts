import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { listHistory, readHistory } from "./history.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("lists completed microphone discussions and opens their saved material without exposing other paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "sotto-history-"));
  roots.push(root);
  const folder = "2026-10-30_0919-mic";
  const dir = join(root, folder);
  mkdirSync(dir);
  writeFileSync(join(dir, "session.json"), JSON.stringify({ startedAt: "2026-10-30T13:19:31Z", endedAt: "2026-10-30T13:23:55Z", source: { kind: "mic" } }));
  writeFileSync(join(dir, "board.json"), JSON.stringify({ summary: "Planning a garden", constraints: [], points: [], questions: [], decisions: [] }));
  writeFileSync(join(dir, "transcript.md"), "A: Hello\n");
  writeFileSync(join(dir, "candidates.jsonl"), [
    JSON.stringify({ kind: "candidate", candidate: { id: "c1", headline: "Budget", detail: "Too much" } }),
    JSON.stringify({ kind: "candidate", candidate: { id: "c2", headline: "Hidden" } }),
    JSON.stringify({ kind: "decision", candidateId: "c1", decision: "interject" }),
  ].join("\n"));
  writeFileSync(join(dir, "answers.jsonl"), JSON.stringify({ status: "done", headline: "An answer", detailMd: "Details" }));
  expect(await listHistory(root)).toEqual([{ folder, startedAt: "2026-10-30T13:19:31Z", title: "Planning a garden" }]);
  expect(await readHistory(folder, root)).toMatchObject({ transcript: "A: Hello\n", contributions: [{ headline: "Budget" }, { headline: "An answer" }] });
  expect((await readHistory(folder, root))?.candidateLog).toHaveLength(3);
  expect(await readHistory("../other", root)).toBeNull();
});

it("reads the digest back, and browses replays only when asked to", async () => {
  const root = mkdtempSync(join(tmpdir(), "sotto-history-"));
  roots.push(root);
  const mic = "2026-11-01_0919-mic";
  const replay = "2026-11-01_1030-events-offsite-plan";
  for (const [folder, startedAt, source] of [
    [mic, "2026-11-01T13:19:31Z", { kind: "mic" }],
    [replay, "2026-11-01T14:30:02Z", { kind: "events", fixture: "offsite-plan" }],
  ] as const) {
    const dir = join(root, folder);
    mkdirSync(dir);
    writeFileSync(join(dir, "session.json"), JSON.stringify({ startedAt, endedAt: "2026-11-01T14:33:55Z", source }));
    writeFileSync(join(dir, "digest.md"), "# Digest\n\n## Summary\n\nWe planned the offsite.\n");
  }

  // The group's list is microphone sessions only.
  expect((await listHistory(root)).map((entry) => entry.folder)).toEqual([mic]);
  expect(await readHistory(replay, root)).toBeNull();

  // A dev build browses the replays too, named by what they replayed.
  const all = await listHistory(root, { replays: true });
  expect(all.map((entry) => entry.folder)).toEqual([replay, mic]);
  expect(all[0]?.title).toContain("offsite-plan");
  const detail = await readHistory(replay, root, { replays: true });
  expect(detail?.digest).toContain("## Summary");
  expect((await readHistory(mic, root))?.digest).toContain("We planned the offsite.");
});
