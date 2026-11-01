import type { Board } from "./board.js";
import type { CandidateLogLine } from "./candidates.js";

export interface HistoryEntry {
  folder: string;
  startedAt: string;
  title: string;
}

export interface HistoryDetail extends HistoryEntry {
  board: Board | null;
  transcript: string;
  /** `digest.md` as it was written (V2-018), or `""` for a session with none. */
  digest: string;
  contributions: { kind: string; headline: string; detail: string }[];
  candidateLog: CandidateLogLine[];
}
