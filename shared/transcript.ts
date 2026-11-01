/**
 * Runs of turns: what a transcript shows as one paragraph.
 *
 * The endpointer closes a turn at every breath, so one person's sentence
 * often arrives as two or three turns ("…see if the" / "audio was recording").
 * The pipeline keeps those apart — the classifier, the board cadence and a
 * candidate's `sourceTurnIds` all count the turns the API produced — but a
 * reader should see them as one. {@link mergeRuns} folds consecutive turns
 * from the same speaker, {@link MERGE_GAP_MS} or less apart, into a run, and
 * both the saved `transcript.md` and the live panel read off the same rule.
 *
 * Sotto's lines never merge: each is one utterance (a claim, an answer, a
 * read-back) and is written down as the thing it was.
 */
import { isSottoTurn, type TurnUpdate } from "./turns.js";

/** The longest silence between two turns that still reads as one person continuing. */
export const MERGE_GAP_MS = 2_000;

/** The parts of a turn the merge rule reads. */
export interface RunEdge {
  speaker: string | null;
  startMs: number;
  endMs: number | null;
  sotto?: boolean;
}

/** Whether `next` continues the run `prev` closed: same speaker, a short gap, nobody is Sotto. */
export function continuesRun(prev: RunEdge, next: RunEdge): boolean {
  if (prev.sotto === true || next.sotto === true) return false;
  if (prev.speaker === null || prev.speaker !== next.speaker) return false;
  if (prev.endMs === null) return false;
  return next.startMs - prev.endMs <= MERGE_GAP_MS;
}

/** One paragraph of the transcript: a speaker's consecutive turns. */
export interface TranscriptRun {
  /** The first turn's id, which is what keys the row. */
  id: string;
  speaker: string | null;
  startMs: number;
  /** The last turn's end, or `null` while it is still being spoken. */
  endMs: number | null;
  sotto: boolean;
  /** True if any turn in the run carries a guessed label (after a reconnect). */
  speakerMappingUncertain: boolean;
  /** The turns, in order. The last may still be a partial. */
  segments: TurnUpdate[];
}

/** Folds an ordered list of turns into runs. Pure; the input is not changed. */
export function mergeRuns(turns: readonly TurnUpdate[]): TranscriptRun[] {
  const runs: TranscriptRun[] = [];
  for (const turn of turns) {
    const last = runs[runs.length - 1];
    if (last !== undefined && continuesRun(last, turn)) {
      last.segments.push(turn);
      last.endMs = turn.endMs;
      last.speakerMappingUncertain ||= turn.speakerMappingUncertain;
      continue;
    }
    runs.push({
      id: turn.turnId,
      speaker: turn.speaker,
      startMs: turn.startMs,
      endMs: turn.endMs,
      sotto: isSottoTurn(turn),
      speakerMappingUncertain: turn.speakerMappingUncertain,
      segments: [turn],
    });
  }
  return runs;
}
