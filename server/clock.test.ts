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

describe("tracked tasks", () => {
  /** Resolves after the microtask queue has drained, so a pending `settle` can block. */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("hands the work straight back on the system clock", async () => {
    await expect(systemClock.track("noop", Promise.resolve(7))).resolves.toBe(7);
  });

  it("holds settle until in-flight work finishes, without moving time", async () => {
    const clock = new SimulatedClock(1_000);
    let release!: () => void;
    const work = new Promise<string>((resolve) => {
      release = () => resolve("done");
    });

    const tracked = clock.track("model", work);
    expect(clock.inFlight()).toEqual(["model"]);

    let settled = false;
    const waiting = clock.settle().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(clock.now()).toBe(1_000);

    release();
    await waiting;
    expect(settled).toBe(true);
    expect(clock.inFlight()).toEqual([]);
    await expect(tracked).resolves.toBe("done");
  });

  it("waits for work that a tracked task starts", async () => {
    const clock = new SimulatedClock();
    const order: string[] = [];
    clock.track(
      "first",
      Promise.resolve().then(() => {
        order.push("first");
        clock.track(
          "second",
          Promise.resolve().then(() => {
            order.push("second");
          }),
        );
      }),
    );

    await clock.settle();

    expect(order).toEqual(["first", "second"]);
    expect(clock.inFlight()).toEqual([]);
  });

  it("stops waiting for work that failed, and still reports the failure to its caller", async () => {
    const clock = new SimulatedClock();
    const tracked = clock.track("model", Promise.reject(new Error("API said no")));

    await clock.settle();

    expect(clock.inFlight()).toEqual([]);
    await expect(tracked).rejects.toThrow("API said no");
  });
});
