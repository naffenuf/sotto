import { describe, expect, it } from "vitest";
import type { MomentRecord } from "../../shared/eval.js";
import type { TurnUpdate } from "../../shared/turns.js";
import {
  CEILING_THRESHOLDS_MS,
  ceilingTable,
  isReachable,
  longestSilence,
  lookTimes,
  momentReach,
  type MomentReach,
} from "./ceiling.js";
import { ENDPOINTER_HANGOVER_MS } from "../asr/turns.js";
import { turnIntervals } from "./pause.js";

function turn(turnId: string, startMs: number, endMs: number | null): TurnUpdate {
  return {
    turnId,
    speaker: "A",
    text: "words",
    final: true,
    startMs,
    endMs,
    speakerMappingUncertain: false,
  };
}

/** Five turns, one every two seconds, each a second and a half long. */
const conversation = [
  turn("0:0", 0, 1_500),
  turn("0:1", 2_000, 3_500),
  turn("0:2", 4_000, 5_500),
  turn("0:3", 6_000, 7_500),
  turn("0:4", 8_000, 9_500),
];

function moment(partial: Partial<MomentRecord> = {}): MomentRecord {
  return {
    id: "m1",
    type: "contradiction",
    expectedLevel: "interject",
    description: "planted",
    triggerLine: 1,
    deadlineLine: 5,
    triggerEndMs: 3_500,
    deadlineEndMs: 9_500,
    setupTurnIds: [],
    triggerTurnIds: ["0:1"],
    triggerTurnEndMs: 3_500,
    deadlineTurnEndMs: 9_500,
    ...partial,
  };
}

describe("lookTimes", () => {
  it("looks once every n final turns, at the turn that completes the batch", () => {
    expect(lookTimes(conversation, 2)).toEqual([3_500, 7_500]);
  });

  it("drops a batch that never fills up", () => {
    expect(lookTimes(conversation, 4)).toEqual([7_500]);
  });

  it("looks on the idle timer when the turns are too far apart", () => {
    const sparse = [turn("0:0", 0, 1_000), turn("0:1", 50_000, 51_000)];
    expect(lookTimes(sparse, 4, 45_000)).toEqual([51_000]);
  });

  it("treats a turn that never ended as arriving when it started", () => {
    expect(lookTimes([turn("0:0", 0, null)], 1)).toEqual([0]);
  });
});

describe("longestSilence", () => {
  const intervals = turnIntervals(conversation);

  it("finds the longest gap between turns in the range", () => {
    // 3,500 -> 4,000 is the only gap that both starts and ends inside here,
    // and the last instant nobody is talking in it is 3,999 — by which point
    // the room has been quiet since 3,500 less the endpointer's hangover.
    expect(longestSilence(intervals, 3_500, 4_000)).toBe(499 + ENDPOINTER_HANGOVER_MS);
  });

  it("is zero while somebody is talking throughout", () => {
    expect(longestSilence(intervals, 4_200, 5_000)).toBe(0);
  });

  it("keeps counting after the last turn closes", () => {
    expect(longestSilence(intervals, 9_500, 12_000)).toBe(2_500 + ENDPOINTER_HANGOVER_MS);
  });
});

describe("momentReach", () => {
  it("places the window, the look and the silence that is left", () => {
    const reach = momentReach("fx", moment(), conversation, 2);
    expect(reach).toEqual({
      fixture: "fx",
      momentId: "m1",
      windowMs: { fromMs: 3_500, untilMs: 9_500 },
      // The 2-turn cadence looks at 3,500 and 7,500; the first at or after
      // the trigger turn's end is the one that carries it.
      lookAtMs: 3_500,
      lookDelayMs: 0,
      bestSilenceMs: 499 + ENDPOINTER_HANGOVER_MS,
    });
  });

  it("reports a later look as a delay, and loses the silence before it", () => {
    const reach = momentReach("fx", moment({ triggerTurnEndMs: 3_600 }), conversation, 2);
    expect(reach.lookAtMs).toBe(7_500);
    expect(reach.lookDelayMs).toBe(3_900);
    expect(reach.bestSilenceMs).toBe(499 + ENDPOINTER_HANGOVER_MS);
  });

  it("has no window when a moment's lines never resolved to turns", () => {
    const reach = momentReach("fx", moment({ triggerTurnEndMs: null }), conversation, 2);
    expect(reach.windowMs).toBeNull();
    expect(reach.lookAtMs).toBeNull();
    expect(reach.bestSilenceMs).toBe(0);
  });

  it("has no look when the conversation ends before the batch fills", () => {
    const reach = momentReach("fx", moment({ triggerTurnEndMs: 7_600 }), conversation, 4);
    expect(reach.lookAtMs).toBeNull();
    expect(reach.bestSilenceMs).toBe(0);
  });

  it("ignores partial snapshots when counting the cadence", () => {
    const withPartials = [
      { ...conversation[0]!, final: false, endMs: null },
      conversation[0]!,
      { ...conversation[1]!, final: false, endMs: null },
      conversation[1]!,
    ];
    expect(momentReach("fx", moment(), withPartials, 2).lookAtMs).toBe(3_500);
  });
});

describe("isReachable", () => {
  const reach: MomentReach = {
    fixture: "fx",
    momentId: "m1",
    windowMs: { fromMs: 0, untilMs: 10_000 },
    lookAtMs: 0,
    lookDelayMs: 0,
    bestSilenceMs: 400,
  };

  it("is reachable exactly at the threshold", () => {
    expect(isReachable(reach, 400)).toBe(true);
    expect(isReachable(reach, 401)).toBe(false);
  });

  it("is never reachable without a look, however long the silence", () => {
    expect(isReachable({ ...reach, lookAtMs: null, bestSilenceMs: 9_000 }, 400)).toBe(false);
  });
});

describe("ceilingTable", () => {
  const reaches: MomentReach[] = [100, 300, 1_600].map((bestSilenceMs, index) => ({
    fixture: "fx",
    momentId: `m${index}`,
    windowMs: { fromMs: 0, untilMs: 10_000 },
    lookAtMs: 0,
    lookDelayMs: 0,
    bestSilenceMs,
  }));

  it("counts the moments each threshold still leaves reachable", () => {
    expect(ceilingTable(reaches, [100, 400, 1_500])).toEqual([
      { pauseMs: 100, reachable: 3, total: 3, recallCeiling: 1 },
      { pauseMs: 400, reachable: 1, total: 3, recallCeiling: 1 / 3 },
      { pauseMs: 1_500, reachable: 1, total: 3, recallCeiling: 1 / 3 },
    ]);
  });

  it("reports a ceiling of zero rather than NaN with nothing planted", () => {
    expect(ceilingTable([], [400])).toEqual([
      { pauseMs: 400, reachable: 0, total: 0, recallCeiling: 0 },
    ]);
  });

  it("reports every default threshold, lowest first", () => {
    const rows = ceilingTable(reaches);
    expect(rows.map((row) => row.pauseMs)).toEqual([...CEILING_THRESHOLDS_MS]);
  });
});
