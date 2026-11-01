import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Board } from "../../shared/board.js";
import type { HistoryDetail, HistoryEntry } from "../../shared/history.js";
import type { CandidateLogLine } from "../../shared/candidates.js";
import { describeSource, type SessionSource } from "../../shared/session.js";
import { SESSION_FILES, SESSIONS_DIR } from "./SessionStore.js";

/** A finished microphone session: what a group means by a past discussion. */
const micFolderPattern = /^\d{4}-\d{2}-\d{2}_\d{4}-mic(?:-\d+)?$/;

/**
 * The same, plus the replays (V2-018).
 *
 * A `wav` or `events` session is a recording being played back rather than a
 * conversation somebody had, so it is not in the list a group browses — but
 * it is the only kind a check or a demo can produce on demand, and its
 * Backstage view and digest are the real ones. `npm run dev:server` sets
 * `SOTTO_DEV=1` and gets both.
 */
const replayFolderPattern =
  /^\d{4}-\d{2}-\d{2}_\d{4}-(?:mic|wav-[a-z0-9-]+|events-[a-z0-9-]+)(?:-\d+)?$/;

/** The source kinds each pattern admits. */
const kinds = { mic: ["mic"], replays: ["mic", "wav", "events"] } as const;

export interface HistoryOptions {
  /** Include replayed sessions as well as microphone ones. Off by default. */
  replays?: boolean;
}

function pattern(options: HistoryOptions): RegExp {
  return options.replays === true ? replayFolderPattern : micFolderPattern;
}

function allowed(options: HistoryOptions): readonly string[] {
  return options.replays === true ? kinds.replays : kinds.mic;
}

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function listHistory(root = SESSIONS_DIR, options: HistoryOptions = {}): Promise<HistoryEntry[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const folders = pattern(options);
  const sources = allowed(options);
  const results = await Promise.all(entries.filter((entry) => entry.isDirectory() && folders.test(entry.name)).map(async (entry) => {
    try {
      const meta = JSON.parse(await readFile(join(root, entry.name, "session.json"), "utf8")) as { startedAt?: unknown; endedAt?: unknown; source?: SessionSource };
      const kind = meta.source?.kind;
      if (typeof meta.startedAt !== "string" || typeof meta.endedAt !== "string" || kind === undefined || !sources.includes(kind)) return null;
      const raw = await readOptional(join(root, entry.name, "board.json"));
      const board = raw ? JSON.parse(raw) as Board : null;
      // A replay of a conversation that produced no board is named by what
      // it replayed; a microphone session with no board has nothing to go on.
      const untitled = kind === "mic" ? "Untitled discussion" : describeSource(meta.source as SessionSource);
      return { folder: entry.name, startedAt: meta.startedAt, title: board?.summary?.trim() || untitled };
    } catch { return null; }
  }));
  return results.filter((entry): entry is HistoryEntry => entry !== null).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function readHistory(folder: string, root = SESSIONS_DIR, options: HistoryOptions = {}): Promise<HistoryDetail | null> {
  if (!pattern(options).test(folder)) return null;
  const entry = (await listHistory(root, options)).find((item) => item.folder === folder);
  if (!entry) return null;
  const dir = join(root, folder);
  const [boardText, transcript, answersText, candidatesText, digest] = await Promise.all([
    readOptional(join(dir, "board.json")), readOptional(join(dir, "transcript.md")),
    readOptional(join(dir, "answers.jsonl")), readOptional(join(dir, "candidates.jsonl")),
    readOptional(join(dir, SESSION_FILES.digest)),
  ]);
  const lines = (text: string): Record<string, any>[] => text.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as Record<string, any>]; } catch { return []; } });
  const candidates = lines(candidatesText);
  const delivered = new Set(candidates.filter((line) => line.kind === "decision" && (line.decision === "interject" || line.decision === "glow")).map((line) => line.candidateId));
  const contributions = [
    ...candidates.filter((line) => line.kind === "candidate" && delivered.has(line.candidate?.id)).map((line) => ({ kind: "Sotto noticed", headline: String(line.candidate.headline ?? ""), detail: String(line.candidate.detail ?? "") })),
    ...lines(answersText).filter((line) => line.status === "done").map((line) => ({ kind: "Answer", headline: String(line.headline ?? ""), detail: String(line.detailMd ?? "") })),
  ];
  return { ...entry, board: boardText ? JSON.parse(boardText) as Board : null, transcript, digest, contributions, candidateLog: candidates as CandidateLogLine[] };
}
