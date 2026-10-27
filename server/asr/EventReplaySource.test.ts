import { describe, expect, it } from "vitest";
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock, systemClock, type Clock } from "../clock.js";
import {
  EventReplaySource,
  assemblerSink,
  fixtureEventsPath,
  type AsrFrameSink,
  type ReplayEndReason,
  type ReplaySpeed,
} from "./EventReplaySource.js";
import { TurnAssembler } from "./turns.js";

/** Silences the assembler's warnings; the captures are clean, so none are expected. */
const quiet = { warn: () => {} };

/** Resolves once the microtask queue has drained, so a blocked replay has stopped moving. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A wall clock that spends no real time but keeps honest books: every delay
 * asked of it is recorded and added to its own `now`. That is what "run 1x
 * with the real-time ratio check skipped" means — the same code path and the
 * same drift-corrected arithmetic, just nobody waiting.
 */
function instantWallClock(delays: number[]): Clock {
  let now = 0;
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      delays.push(ms);
      now += ms;
      fn();
      return () => {};
    },
    track: systemClock.track,
  };
}

function frame(atMs: number, body: Record<string, unknown>): AsrFrameRecord {
  return { atMs, session: 0, frame: body };
}

/** A one-turn conversation, for the tests that don't need a whole capture. */
function tinyCapture(): AsrFrameRecord[] {
  return [
    frame(100, { type: "speechStart", turnId: 0, audioProcessedMs: 0 }),
    frame(600, { type: "transcript", transcript: " Hello", final: false, audioProcessedMs: 480 }),
    frame(1_400, { type: "speaker", label: "A", audioProcessedMs: 1_040 }),
    frame(1_500, { type: "speechEnd", turnId: 0, audioProcessedMs: 1_040 }),
    frame(1_560, {
      type: "speechComplete",
      turnId: 0,
      transcript: " Hello there. ",
      audioProcessedMs: 1_040,
    }),
  ];
}

/** Replays a fixture into an assembler and reports what came out. */
async function replayFixture(
  fixture: string,
  speed: ReplaySpeed,
): Promise<{ turns: readonly TurnUpdate[]; endedWith: ReplayEndReason; wallDelays: number[] }> {
  const clock = new SimulatedClock();
  const assembler = new TurnAssembler({ clock, startedAtMs: 0, logger: quiet });
  const wallDelays: number[] = [];
  const source = EventReplaySource.forFixture(fixture, {
    clock,
    speed,
    wallClock: instantWallClock(wallDelays),
  });
  let endedWith: ReplayEndReason | undefined;
  await source.run(
    assemblerSink(assembler, (reason) => {
      endedWith = reason;
    }),
  );
  expect(source.sentFrames).toBe(source.frameCount);
  expect(assembler.openTurns()).toEqual([]);
  expect(assembler.malformedFrames()).toBe(0);
  return { turns: assembler.finalTurns(), endedWith: endedWith as ReplayEndReason, wallDelays };
}

describe("EventReplaySource", () => {
  it("reads a capture by fixture name", () => {
    const source = EventReplaySource.forFixture("brainstorm", { clock: new SimulatedClock() });
    expect(fixtureEventsPath("brainstorm")).toMatch(/fixtures\/events\/brainstorm\.jsonl$/);
    expect(source.frameCount).toBeGreaterThan(100);
    expect(source.speed).toBe("max");
  });

  it("sets the clock to each frame's recorded arrival time", async () => {
    const clock = new SimulatedClock();
    const records = tinyCapture();
    const source = new EventReplaySource(records, { clock, speed: "max" });
    const seen: number[] = [];
    await source.run({
      onFrame: () => seen.push(clock.now()),
      onEnd: () => {},
    });

    expect(seen).toEqual(records.map((record) => record.atMs));
    expect(clock.now()).toBe(1_560);
  });

  it("feeds a capture into the turn assembler", async () => {
    const { turns, endedWith } = await replayFixture("brainstorm", "max");

    expect(endedWith).toBe("complete");
    expect(turns.length).toBeGreaterThan(10);
    expect(new Set(turns.map((turn) => turn.speaker)).size).toBeGreaterThanOrEqual(2);
    for (const turn of turns) expect(turn.text.trim()).not.toBe("");
  });

  it("produces the same final turns at max as at 1x, in a fraction of the time", async () => {
    const startedAt = systemClock.now();
    const fast = await replayFixture("brainstorm", "max");
    const maxElapsedMs = systemClock.now() - startedAt;
    const paced = await replayFixture("brainstorm", "1x");

    expect(fast.turns).toEqual(paced.turns);
    // The conversation is two minutes long; `max` spends none of it.
    expect(paced.wallDelays.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThan(100_000);
    expect(fast.wallDelays).toEqual([]);
    expect(maxElapsedMs).toBeLessThan(2_000);
  });

  it("asks the wall clock for the gap between frames at 1x, measured from the start", async () => {
    const delays: number[] = [];
    const source = new EventReplaySource(tinyCapture(), {
      clock: new SimulatedClock(),
      speed: "1x",
      wallClock: instantWallClock(delays),
    });
    await source.run({ onFrame: () => {}, onEnd: () => {} });

    expect(delays).toEqual([100, 500, 800, 100, 60]);
  });

  it("spends real time at 1x", async () => {
    const records = [
      frame(0, { type: "speechStart", turnId: 0, audioProcessedMs: 0 }),
      frame(60, { type: "speechEnd", turnId: 0, audioProcessedMs: 0 }),
    ];
    const source = new EventReplaySource(records, { clock: new SimulatedClock(), speed: "1x" });
    const startedAt = systemClock.now();
    await source.run({ onFrame: () => {}, onEnd: () => {} });

    expect(systemClock.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it("holds simulated time at an in-flight task until it finishes", async () => {
    const clock = new SimulatedClock();
    const records = tinyCapture();
    let release!: () => void;
    const modelCall = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: number[] = [];
    let calledAt = -1;
    let returnedAt = -1;

    const source = new EventReplaySource(records, { clock, speed: "max" });
    const sink: AsrFrameSink = {
      onFrame: () => {
        seen.push(clock.now());
        if (seen.length !== 2) return;
        calledAt = clock.now();
        void clock.track(
          "model",
          modelCall.then(() => {
            returnedAt = clock.now();
          }),
        );
      },
      onEnd: () => {},
    };
    const run = source.run(sink);

    await flush();
    // Replay stopped at the frame that started the call, rather than running
    // the rest of the conversation past it.
    expect(seen).toEqual([100, 600]);
    expect(clock.now()).toBe(600);

    release();
    await run;

    // The call came back at the moment it was made: no idle time was invented.
    expect(calledAt).toBe(600);
    expect(returnedAt).toBe(600);
    expect(seen).toEqual(records.map((record) => record.atMs));
  });

  it("waits for work started by the last frame before ending", async () => {
    const clock = new SimulatedClock();
    const source = new EventReplaySource(tinyCapture(), { clock, speed: "max" });
    const order: string[] = [];
    let release!: () => void;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = source.run({
      onFrame: (record) => {
        if (record.frame["type"] !== "speechComplete") return;
        void clock.track(
          "board",
          work.then(() => order.push("work")),
        );
      },
      onEnd: () => order.push("end"),
    });
    await flush();
    expect(order).toEqual([]);

    release();
    await run;
    expect(order).toEqual(["work", "end"]);
  });

  it("stops early from inside onFrame and ends with 'stopped'", async () => {
    const clock = new SimulatedClock();
    const records = tinyCapture();
    const source = new EventReplaySource(records, { clock, speed: "max" });
    const reasons: ReplayEndReason[] = [];
    const seen: AsrFrameRecord[] = [];
    await source.run({
      onFrame: (record) => {
        seen.push(record);
        if (seen.length === 2) source.stop();
      },
      onEnd: (reason) => reasons.push(reason),
    });

    expect(seen).toHaveLength(2);
    expect(reasons).toEqual(["stopped"]);
    expect(source.sentFrames).toBe(2);
    expect(clock.now()).toBe(600);
  });

  it("stops a paced replay without waiting out the rest of the conversation", async () => {
    const clock = new SimulatedClock();
    const source = EventReplaySource.forFixture("brainstorm", { clock, speed: "1x" });
    const reasons: ReplayEndReason[] = [];
    const run = source.run({
      onFrame: () => {},
      onEnd: (reason) => reasons.push(reason),
    });
    source.stop();
    await run;

    expect(reasons).toEqual(["stopped"]);
    expect(source.sentFrames).toBeLessThan(source.frameCount);
  });

  it("stops a paced replay that is already waiting out the next frame", async () => {
    const clock = new SimulatedClock();
    const source = EventReplaySource.forFixture("brainstorm", { clock, speed: "1x" });
    const reasons: ReplayEndReason[] = [];
    const run = source.run({
      onFrame: () => {},
      onEnd: (reason) => reasons.push(reason),
    });
    // Far enough in that the wait for the first frame is armed: cancelling
    // that timer has to free the run as well, or `run()` never resolves.
    await flush();
    source.stop();
    await run;

    expect(reasons).toEqual(["stopped"]);
    expect(source.sentFrames).toBeLessThan(source.frameCount);
  });

  it("refuses to run twice at once", async () => {
    const source = new EventReplaySource(tinyCapture(), { clock: new SimulatedClock() });
    const sink: AsrFrameSink = { onFrame: () => {}, onEnd: () => {} };
    const run = source.run(sink);
    await expect(source.run(sink)).rejects.toThrow(/already running/);
    await run;
  });
});
