/**
 * V3-004's still-current check on a simulated clock: when it asks, when it
 * does not, and what it leaves behind when the model does not answer.
 */
import { describe, expect, it } from "vitest";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock, systemClock } from "../clock.js";
import { StillCurrentWatcher } from "./StillCurrentWatcher.js";
import type { StillCurrentInput } from "./stillCurrent.js";

const asked = {
  question: "How long is the drive from the city to the farmhouse?",
  answer: "About two hours fifteen.",
  askedAtMs: 10_000,
};

function turn(turnId: string, text: string, endMs: number): TurnUpdate {
  return {
    turnId,
    speaker: "A",
    speakerMappingUncertain: false,
    text,
    final: true,
    startMs: endMs - 1_000,
    endMs,
  };
}

interface Harness {
  clock: SimulatedClock;
  watcher: StillCurrentWatcher;
  calls: StillCurrentInput[];
  timing: Record<string, unknown>[];
  settle: () => Promise<void>;
}

function setup(
  reply: (input: StillCurrentInput) => unknown | Promise<unknown>,
): Harness {
  const clock = new SimulatedClock(0);
  const calls: StillCurrentInput[] = [];
  const timing: Record<string, unknown>[] = [];
  const watcher = new StillCurrentWatcher({
    clock,
    // Real time: a replay's clock stands still inside a model call, and the
    // timeout is wall-clock work.
    wallClock: systemClock,
    classify: async (input) => {
      calls.push(input);
      return reply(input);
    },
    speakers: () => ({ A: "Craig" }),
    onTiming: (record) => timing.push(record),
  });
  return {
    clock,
    watcher,
    calls,
    timing,
    settle: async () => {
      await watcher.flush();
      await Promise.resolve();
    },
  };
}

const CURRENT = { verdict: "current", agrees: false, why: "still on the venue" };

describe("StillCurrentWatcher", () => {
  it("is current with no call at all when nobody has spoken since", async () => {
    const harness = setup(() => CURRENT);
    harness.watcher.watch("idea-1", asked);
    await harness.settle();
    expect(harness.calls).toEqual([]);
    expect(harness.watcher.verdict("idea-1")).toMatchObject({
      verdict: "current",
      latencyMs: 0,
      turns: 0,
    });
  });

  it("asks once per later final turn, over the turns since the question", async () => {
    const harness = setup(() => CURRENT);
    // Before the question: context, but not something that moved on.
    harness.watcher.acceptTurn(turn("0:1", "Where is this place?", 5_000));
    harness.watcher.watch("idea-1", asked);
    harness.watcher.acceptTurn(turn("0:2", "An hour and a half, I thought.", 12_000));
    await harness.settle();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.since.map((one) => one.turnId)).toEqual(["0:2"]);
    expect(harness.calls[0]?.question).toBe(asked.question);
    expect(harness.calls[0]?.answer).toBe(asked.answer);

    harness.watcher.acceptTurn(turn("0:3", "Still the farmhouse, then.", 16_000));
    await harness.settle();
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]?.since.map((one) => one.turnId)).toEqual(["0:2", "0:3"]);
  });

  it("keeps one check in flight and re-asks once it comes back", async () => {
    const waiting: (() => void)[] = [];
    const harness = setup(async () => {
      await new Promise<void>((resolve) => waiting.push(resolve));
      return CURRENT;
    });
    harness.watcher.watch("idea-1", asked);
    harness.watcher.acceptTurn(turn("0:2", "An hour and a half.", 12_000));
    await Promise.resolve();
    // Two more turns while the first check is out: still one call.
    harness.watcher.acceptTurn(turn("0:3", "Maybe two.", 14_000));
    harness.watcher.acceptTurn(turn("0:4", "Let's check.", 16_000));
    expect(harness.calls).toHaveLength(1);
    // Let every check that starts come back, including the one the turns
    // that arrived during the first one are the reason for.
    const microtasks = async (): Promise<void> => {
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
    };
    for (let round = 0; round < 4; round += 1) {
      waiting.shift()?.();
      await microtasks();
    }
    await harness.settle();
    // The turns that arrived meanwhile are what the next one is about.
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]?.since.map((one) => one.turnId)).toEqual(["0:2", "0:3", "0:4"]);
  });

  it("caches the verdict and logs it with its latency", async () => {
    const harness = setup(() => ({
      verdict: "moved_on",
      agrees: false,
      why: "they are on the projector now",
    }));
    harness.watcher.watch("idea-1", asked);
    harness.watcher.acceptTurn(turn("0:2", "Did we sort out the projector?", 12_000));
    await harness.settle();
    expect(harness.watcher.verdict("idea-1")).toMatchObject({
      verdict: "moved_on",
      fallback: false,
      turns: 1,
    });
    expect(harness.timing[0]).toMatchObject({
      stage: "still_current",
      ideaId: "idea-1",
      verdict: "moved_on",
      why: "they are on the projector now",
    });
  });

  it("keeps an answered verdict's agreement, which is what the card says", async () => {
    const harness = setup(() => ({
      verdict: "answered",
      agrees: true,
      why: "Craig said two and a quarter hours",
    }));
    harness.watcher.watch("idea-1", asked);
    harness.watcher.acceptTurn(turn("0:2", "I checked — it's two and a quarter.", 12_000));
    await harness.settle();
    expect(harness.watcher.verdict("idea-1")).toMatchObject({
      verdict: "answered",
      agrees: true,
    });
  });

  it("leaves the last verdict standing when a check fails", async () => {
    let fail = false;
    const harness = setup(() => {
      if (fail) throw new Error("the model did not come back");
      return CURRENT;
    });
    harness.watcher.watch("idea-1", asked);
    harness.watcher.acceptTurn(turn("0:2", "An hour and a half.", 12_000));
    await harness.settle();
    expect(harness.watcher.verdict("idea-1")?.verdict).toBe("current");

    fail = true;
    harness.watcher.acceptTurn(turn("0:3", "Something else entirely.", 14_000));
    await harness.settle();
    // Losing the check costs judgment, not speech.
    expect(harness.watcher.verdict("idea-1")).toMatchObject({
      verdict: "current",
      fallback: true,
    });
    expect(harness.timing.at(-1)).toMatchObject({ fallback: true });
  });

  it("falls back to current for a reply that does not fit the schema", async () => {
    const harness = setup(() => ({ verdict: "whatever" }));
    harness.watcher.watch("idea-1", asked);
    harness.watcher.acceptTurn(turn("0:2", "An hour and a half.", 12_000));
    await harness.settle();
    expect(harness.watcher.verdict("idea-1")).toMatchObject({
      verdict: "current",
      fallback: true,
    });
  });

  it("reads no partials and none of Sotto's own lines", async () => {
    const harness = setup(() => CURRENT);
    harness.watcher.watch("idea-1", asked);
    harness.watcher.acceptTurn({ ...turn("0:2", "An hour", 12_000), final: false });
    harness.watcher.acceptTurn({
      ...turn("sotto:answer-idea-1", "On the drive time: two hours.", 12_500),
      speaker: "Sotto",
      sotto: true,
    });
    await harness.settle();
    expect(harness.calls).toEqual([]);
  });

  it("knows nothing about a question nobody is watching, and forgets on request", async () => {
    const harness = setup(() => CURRENT);
    expect(harness.watcher.verdict("idea-9")).toBeUndefined();
    harness.watcher.watch("idea-1", asked);
    harness.watcher.forget("idea-1");
    expect(harness.watcher.verdict("idea-1")).toBeUndefined();
  });

  it("stops asking once the session has, and a late verdict changes nothing", async () => {
    let release: (() => void) | undefined;
    const harness = setup(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { verdict: "moved_on", agrees: false, why: "gone" };
    });
    harness.watcher.watch("idea-1", asked);
    harness.watcher.acceptTurn(turn("0:2", "An hour and a half.", 12_000));
    await Promise.resolve();
    harness.watcher.stop();
    release?.();
    await harness.settle();
    await harness.settle();
    expect(harness.watcher.verdict("idea-1")?.verdict).toBe("current");
    expect(harness.timing).toEqual([]);
    harness.watcher.acceptTurn(turn("0:3", "Anything", 14_000));
    expect(harness.calls).toHaveLength(1);
  });
});
