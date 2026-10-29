import { describe, expect, it } from "vitest";
import type { TurnUpdate } from "../../shared/turns.js";
import { ENDPOINTER_HANGOVER_MS, TurnAssembler } from "../asr/turns.js";
import { SimulatedClock } from "../clock.js";
import { pauseAt, turnIntervals } from "./pause.js";

function turn(partial: Partial<TurnUpdate> & { turnId: string; startMs: number }): TurnUpdate {
  return {
    speaker: "A",
    text: "words",
    final: false,
    endMs: null,
    speakerMappingUncertain: false,
    ...partial,
  };
}

describe("turnIntervals", () => {
  it("keeps one interval per turn, however many snapshots arrive", () => {
    const intervals = turnIntervals([
      turn({ turnId: "0:0", startMs: 100 }),
      turn({ turnId: "0:0", startMs: 100 }),
      turn({ turnId: "0:0", startMs: 100, endMs: 900 }),
      turn({ turnId: "0:0", startMs: 100, endMs: 900, final: true }),
      turn({ turnId: "0:1", startMs: 1_200, endMs: 2_000, final: true }),
    ]);
    expect(intervals).toEqual([
      { turnId: "0:0", startMs: 100, endMs: 900 },
      { turnId: "0:1", startMs: 1_200, endMs: 2_000 },
    ]);
  });

  it("leaves a turn that never ended open", () => {
    expect(turnIntervals([turn({ turnId: "0:0", startMs: 5 })])[0]?.endMs).toBeNull();
  });
});

describe("pauseAt", () => {
  const intervals = turnIntervals([
    turn({ turnId: "0:0", startMs: 1_000, endMs: 4_000, final: true }),
    turn({ turnId: "0:1", startMs: 6_000, endMs: 8_000, final: true }),
  ]);

  it("counts silence from the start of the session before anybody speaks", () => {
    expect(pauseAt(intervals, 500)).toEqual({ speaking: false, silentForMs: 500 });
  });

  it("is speaking inside a turn", () => {
    expect(pauseAt(intervals, 2_000)).toEqual({ speaking: true, silentForMs: 0 });
  });

  it("counts silence from the end of the last turn to close", () => {
    // Less the endpointer's hangover: the talking stopped that much earlier.
    expect(pauseAt(intervals, 5_500)).toEqual({
      speaking: false,
      silentForMs: 1_500 + ENDPOINTER_HANGOVER_MS,
    });
    expect(pauseAt(intervals, 10_000)).toEqual({
      speaking: false,
      silentForMs: 2_000 + ENDPOINTER_HANGOVER_MS,
    });
  });

  it("is speaking for the rest of the session once a turn never closes", () => {
    const open = turnIntervals([turn({ turnId: "0:0", startMs: 1_000 })]);
    expect(pauseAt(open, 60_000)).toEqual({ speaking: true, silentForMs: 0 });
  });

  it("stays quiet while an overlapping turn is still going", () => {
    // B starts before A finishes and runs on: the silence starts when the
    // *last* of them ends, which is what the assembler does.
    const overlapping = turnIntervals([
      turn({ turnId: "0:0", startMs: 1_000, endMs: 4_000, final: true }),
      turn({ turnId: "0:1", startMs: 3_500, endMs: 7_000, final: true }),
    ]);
    expect(pauseAt(overlapping, 4_500)).toEqual({ speaking: true, silentForMs: 0 });
    expect(pauseAt(overlapping, 8_000)).toEqual({
      speaking: false,
      silentForMs: 1_000 + ENDPOINTER_HANGOVER_MS,
    });
  });
});

describe("pauseAt against the assembler it reconstructs", () => {
  /** The frames of one turn, as `fixtures/events/NOTES.md` records their order. */
  function speak(turnId: number, startMs: number, endMs: number) {
    return [
      { atMs: startMs, session: 1, frame: { type: "speechStart", turnId } },
      { atMs: endMs, session: 1, frame: { type: "speechEnd", turnId } },
      {
        atMs: endMs + 10,
        session: 1,
        frame: { type: "speechComplete", turnId, transcript: "words" },
      },
    ];
  }

  it("agrees with TurnAssembler.pauseState at every moment it is asked about", () => {
    const clock = new SimulatedClock(0);
    const turns: TurnUpdate[] = [];
    const assembler = new TurnAssembler({
      clock,
      startedAtMs: 0,
      onUpdate: (update) => turns.push(update),
    });
    const frames = [...speak(0, 1_000, 4_000), ...speak(1, 6_000, 8_000)];
    for (const record of frames) {
      clock.advanceTo(record.atMs);
      assembler.accept(record);
    }

    const intervals = turnIntervals(turns);
    for (const atMs of [0, 500, 1_000, 2_000, 4_000, 5_000, 6_500, 8_000, 9_500, 20_000]) {
      expect(pauseAt(intervals, atMs), `at ${atMs} ms`).toEqual(assembler.pauseState(atMs));
    }
  });
});
