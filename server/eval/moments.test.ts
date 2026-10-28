import { describe, expect, it } from "vitest";
import type { FixtureTiming } from "../../shared/fixtures.js";
import type { TurnUpdate } from "../../shared/turns.js";
import {
  TURN_SLACK_MS,
  loadScript,
  loadTiming,
  momentLines,
  resolveMoments,
  turnsForLine,
} from "./moments.js";

function turn(turnId: string, startMs: number, endMs: number): TurnUpdate {
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

const timing: FixtureTiming = {
  name: "test",
  sampleRate: 24_000,
  durationMs: 30_000,
  lines: [
    { index: 0, speaker: "A", startMs: 0, endMs: 4_000 },
    { index: 1, speaker: "B", startMs: 6_000, endMs: 10_000 },
  ],
};

describe("turnsForLine", () => {
  it("takes the turns that overlap the line, with slack for the endpointer", () => {
    const turns = [
      turn("0:0", 200, 3_800),
      turn("0:1", 6_200, 9_500),
      turn("0:2", 20_000, 22_000),
    ];
    expect(turnsForLine(0, timing, turns).map((one) => one.turnId)).toEqual(["0:0"]);
    expect(turnsForLine(1, timing, turns).map((one) => one.turnId)).toEqual(["0:1"]);
  });

  it("still claims a turn that drifted by less than the slack", () => {
    const drifted = [turn("0:0", 4_000 + TURN_SLACK_MS - 1, 12_000)];
    expect(turnsForLine(0, timing, drifted)).toHaveLength(1);
    const late = [turn("0:0", 4_000 + TURN_SLACK_MS + 1, 12_000)];
    expect(turnsForLine(0, timing, late)).toHaveLength(0);
  });

  it("has nothing to say about a line with no timing", () => {
    expect(turnsForLine(9, timing, [turn("0:0", 0, 1_000)])).toHaveLength(0);
  });
});

describe("resolveMoments", () => {
  it("places a real fixture's planted moment on both timelines", () => {
    const script = loadScript("moment-contradiction");
    const scriptTiming = loadTiming("moment-contradiction");
    const planted = script.moments[0];
    expect(planted, "moment-contradiction has no planted moment").toBeDefined();
    const triggerLine = scriptTiming.lines.find(
      (line) => line.index === (planted?.triggerLine ?? -1),
    );
    expect(triggerLine).toBeDefined();

    // A turn covering exactly the trigger line, as a replay would produce.
    const turns = [turn("0:9", triggerLine?.startMs ?? 0, triggerLine?.endMs ?? 0)];
    const [resolved] = resolveMoments("moment-contradiction", turns);
    expect(resolved?.id).toBe(planted?.id);
    expect(resolved?.type).toBe("contradiction");
    expect(resolved?.expectedLevel).toBe("interject");
    expect(resolved?.triggerEndMs).toBe(triggerLine?.endMs);
    expect(resolved?.triggerTurnIds).toEqual(["0:9"]);
    expect(resolved?.triggerTurnEndMs).toBe(triggerLine?.endMs);
    // The setup lines are elsewhere in the conversation, so this turn is not
    // theirs; the field exists and is empty rather than guessed at.
    expect(resolved?.setupTurnIds).toEqual([]);
  });

  it("is empty for a conversation with nothing planted in it", () => {
    expect(resolveMoments("brainstorm", [])).toEqual([]);
    expect(resolveMoments("no-wake", [])).toEqual([]);
  });
});

describe("momentLines", () => {
  it("quotes the setup and trigger lines in the speakers' own words", () => {
    const script = loadScript("moment-contradiction");
    const planted = script.moments[0];
    expect(planted).toBeDefined();
    if (planted === undefined) return;
    const lines = momentLines(planted, script);
    expect(lines.setup).toHaveLength(planted.setupLines.length);
    expect(lines.trigger).toContain(script.lines[planted.triggerLine]?.text ?? "");
    for (const line of lines.setup) expect(line).toMatch(/^[AB]: /);
  });
});
