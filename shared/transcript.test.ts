import { describe, expect, it } from "vitest";
import { MERGE_GAP_MS, continuesRun, mergeRuns } from "./transcript.js";
import { sottoTurn, type TurnUpdate } from "./turns.js";

function turn(partial: Partial<TurnUpdate> & Pick<TurnUpdate, "turnId">): TurnUpdate {
  return {
    speaker: "A",
    text: "words",
    final: true,
    startMs: 0,
    endMs: 1_000,
    speakerMappingUncertain: false,
    ...partial,
  };
}

describe("mergeRuns", () => {
  it("folds a sentence the endpointer split at a breath into one run", () => {
    // The gap measured on a real mic session: 514 ms between endMs and the next startMs.
    const runs = mergeRuns([
      turn({ turnId: "0:0", text: "see if the", startMs: 20_604, endMs: 31_293 }),
      turn({ turnId: "0:1", text: "audio was recording.", startMs: 31_807, endMs: 35_478 }),
    ]);
    expect(runs.map((run) => run.segments.map((segment) => segment.turnId))).toEqual([["0:0", "0:1"]]);
    expect(runs[0]).toMatchObject({ id: "0:0", speaker: "A", startMs: 20_604, endMs: 35_478 });
  });

  it("starts a new run when the speaker changes, and again when they come back", () => {
    const runs = mergeRuns([
      turn({ turnId: "0:0", startMs: 0, endMs: 1_000 }),
      turn({ turnId: "0:1", speaker: "B", startMs: 1_200, endMs: 2_000 }),
      turn({ turnId: "0:2", startMs: 2_100, endMs: 3_000 }),
    ]);
    expect(runs.map((run) => [run.speaker, run.segments.length])).toEqual([["A", 1], ["B", 1], ["A", 1]]);
  });

  it("does not bridge a gap longer than MERGE_GAP_MS", () => {
    const runs = mergeRuns([
      turn({ turnId: "0:0", startMs: 0, endMs: 1_000 }),
      turn({ turnId: "0:1", startMs: 1_000 + MERGE_GAP_MS + 1, endMs: 5_000 }),
    ]);
    expect(runs).toHaveLength(2);
  });

  it("merges exactly at the limit", () => {
    expect(continuesRun({ speaker: "A", startMs: 0, endMs: 1_000 }, { speaker: "A", startMs: 1_000 + MERGE_GAP_MS, endMs: null })).toBe(true);
  });

  it("never merges a turn whose speaker is still unknown, or one that has not ended", () => {
    expect(continuesRun({ speaker: "A", startMs: 0, endMs: 1_000 }, { speaker: null, startMs: 1_100, endMs: null })).toBe(false);
    expect(continuesRun({ speaker: "A", startMs: 0, endMs: null }, { speaker: "A", startMs: 1_100, endMs: null })).toBe(false);
  });

  it("keeps every line of Sotto's on its own", () => {
    const first = sottoTurn({ utteranceId: "claim-1", text: "I'll check the drive time.", startMs: 1_000, interrupted: false });
    const second = sottoTurn({ utteranceId: "ans-1", text: "About three hours.", startMs: 1_200, interrupted: false });
    const runs = mergeRuns([turn({ turnId: "0:0", startMs: 0, endMs: 900 }), first, second, turn({ turnId: "0:1", startMs: 1_300, endMs: 2_000 })]);
    expect(runs.map((run) => [run.sotto, run.segments.length])).toEqual([[false, 1], [true, 1], [true, 1], [false, 1]]);
  });

  it("lets a labelled partial join the run, and remembers a guessed label", () => {
    const runs = mergeRuns([
      turn({ turnId: "0:0", startMs: 0, endMs: 1_000 }),
      turn({ turnId: "0:1", final: false, startMs: 1_100, endMs: null, speakerMappingUncertain: true }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ endMs: null, speakerMappingUncertain: true });
  });
});
