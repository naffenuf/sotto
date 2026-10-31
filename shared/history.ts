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
  contributions: { kind: string; headline: string; detail: string }[];
  candidateLog: CandidateLogLine[];
}
