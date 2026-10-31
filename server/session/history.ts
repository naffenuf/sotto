import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Board } from "../../shared/board.js";
import type { HistoryDetail, HistoryEntry } from "../../shared/history.js";
import type { CandidateLogLine } from "../../shared/candidates.js";
import { SESSIONS_DIR } from "./SessionStore.js";

const folderPattern = /^\d{4}-\d{2}-\d{2}_\d{4}-mic(?:-\d+)?$/;

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function listHistory(root = SESSIONS_DIR): Promise<HistoryEntry[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const results = await Promise.all(entries.filter((entry) => entry.isDirectory() && folderPattern.test(entry.name)).map(async (entry) => {
    try {
      const meta = JSON.parse(await readFile(join(root, entry.name, "session.json"), "utf8")) as { startedAt?: unknown; endedAt?: unknown; source?: { kind?: string } };
      if (typeof meta.startedAt !== "string" || typeof meta.endedAt !== "string" || meta.source?.kind !== "mic") return null;
      const raw = await readOptional(join(root, entry.name, "board.json"));
      const board = raw ? JSON.parse(raw) as Board : null;
      return { folder: entry.name, startedAt: meta.startedAt, title: board?.summary?.trim() || "Untitled discussion" };
    } catch { return null; }
  }));
  return results.filter((entry): entry is HistoryEntry => entry !== null).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function readHistory(folder: string, root = SESSIONS_DIR): Promise<HistoryDetail | null> {
  if (!folderPattern.test(folder)) return null;
  const entry = (await listHistory(root)).find((item) => item.folder === folder);
  if (!entry) return null;
  const dir = join(root, folder);
  const [boardText, transcript, answersText, candidatesText] = await Promise.all([
    readOptional(join(dir, "board.json")), readOptional(join(dir, "transcript.md")),
    readOptional(join(dir, "answers.jsonl")), readOptional(join(dir, "candidates.jsonl")),
  ]);
  const lines = (text: string): Record<string, any>[] => text.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as Record<string, any>]; } catch { return []; } });
  const candidates = lines(candidatesText);
  const delivered = new Set(candidates.filter((line) => line.kind === "decision" && (line.decision === "interject" || line.decision === "glow")).map((line) => line.candidateId));
  const contributions = [
    ...candidates.filter((line) => line.kind === "candidate" && delivered.has(line.candidate?.id)).map((line) => ({ kind: "Sotto noticed", headline: String(line.candidate.headline ?? ""), detail: String(line.candidate.detail ?? "") })),
    ...lines(answersText).filter((line) => line.status === "done").map((line) => ({ kind: "Answer", headline: String(line.headline ?? ""), detail: String(line.detailMd ?? "") })),
  ];
  return { ...entry, board: boardText ? JSON.parse(boardText) as Board : null, transcript, contributions, candidateLog: candidates as CandidateLogLine[] };
}
