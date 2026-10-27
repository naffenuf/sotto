import { describe, expect, it } from "vitest";
import { SimulatedClock, systemClock } from "./clock.js";

describe("systemClock", () => {
  it("moves forward and cancels timers", async () => {
    const before = systemClock.now();
    const fired: string[] = [];
    const cancel = systemClock.setTimeout(() => fired.push("cancelled"), 1);
    cancel();
    await new Promise<void>((resolve) => {
      systemClock.setTimeout(() => {
        fired.push("kept");
        resolve();
      }, 5);
    });
    expect(fired).toEqual(["kept"]);
    expect(systemClock.now()).toBeGreaterThan(before);
  });
});

describe("SimulatedClock", () => {
  it("does not move on its own", () => {
    const clock = new SimulatedClock(1_000);
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 10);
    expect(clock.now()).toBe(1_000);
    expect(fired).toBe(false);
  });

  it("fires timers in due order and lands now() on each due time", () => {
    const clock = new SimulatedClock();
    const seen: Array<[string, number]> = [];
    clock.setTimeout(() => seen.push(["late", clock.now()]), 300);
    clock.setTimeout(() => seen.push(["early", clock.now()]), 100);
    clock.setTimeout(() => seen.push(["middle", clock.now()]), 200);

    clock.advanceBy(250);

    expect(seen).toEqual([
      ["early", 100],
      ["middle", 200],
    ]);
    expect(clock.now()).toBe(250);
    expect(clock.pending).toBe(1);
  });

  it("fires timers scheduled from inside a callback when they also come due", () => {
    const clock = new SimulatedClock();
    const seen: number[] = [];
    clock.setTimeout(() => {
      seen.push(clock.now());
      clock.setTimeout(() => seen.push(clock.now()), 10);
    }, 10);

    clock.advanceTo(20);

    expect(seen).toEqual([10, 20]);
  });

  it("does not fire a cancelled timer", () => {
    const clock = new SimulatedClock();
    let fired = false;
    const cancel = clock.setTimeout(() => {
      fired = true;
    }, 5);
    cancel();
    clock.advanceBy(100);
    expect(fired).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("runAll drains the queue however far ahead it reaches", () => {
    const clock = new SimulatedClock();
    const seen: number[] = [];
    const tick = (remaining: number) => {
      seen.push(clock.now());
      if (remaining > 0) clock.setTimeout(() => tick(remaining - 1), 1_000);
    };
    clock.setTimeout(() => tick(3), 1_000);

    clock.runAll();

    expect(seen).toEqual([1_000, 2_000, 3_000, 4_000]);
    expect(clock.now()).toBe(4_000);
  });

  it("reports when the next timer is due", () => {
    const clock = new SimulatedClock();
    expect(clock.nextDueAt()).toBeUndefined();
    clock.setTimeout(() => {}, 40);
    clock.setTimeout(() => {}, 15);
    expect(clock.nextDueAt()).toBe(15);
  });

  it("refuses to run backwards", () => {
    const clock = new SimulatedClock(500);
    expect(() => clock.advanceTo(499)).toThrow(/backwards/);
  });
});
