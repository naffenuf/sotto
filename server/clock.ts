/**
 * The one source of time for server code. Nothing below this module calls
 * `Date.now()` or `setTimeout` directly, so tests and fast event replay
 * (US-006) can run the pipeline on simulated time.
 */

/** A clock plus its timer. `now()` is monotonic: only differences are meaningful. */
export interface Clock {
  /** Milliseconds on a monotonic timeline, starting from an arbitrary origin. */
  now(): number;
  /** Runs `fn` once, after at least `ms` on this clock. Returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
}

/** Real time, paced by Node's timers. */
export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** Safety valve for {@link SimulatedClock.runAll} against a self-rescheduling timer. */
const RUN_ALL_LIMIT = 1_000_000;

/**
 * Time under test: nothing happens until you move it. Timers fire in due
 * order, and `now()` lands exactly on each one's due time, so a two-minute
 * fixture replays in a millisecond and the timestamps still read as if it
 * had taken two minutes.
 */
export class SimulatedClock implements Clock {
  private current: number;
  private nextId = 0;
  private readonly timers = new Map<number, { dueAt: number; fn: () => void }>();

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.set(id, { dueAt: this.current + Math.max(0, ms), fn });
    return () => {
      this.timers.delete(id);
    };
  }

  /** How many timers are still waiting. */
  get pending(): number {
    return this.timers.size;
  }

  /** When the next timer is due, or `undefined` if none is. */
  nextDueAt(): number | undefined {
    let earliest: number | undefined;
    for (const timer of this.timers.values()) {
      if (earliest === undefined || timer.dueAt < earliest) earliest = timer.dueAt;
    }
    return earliest;
  }

  /** Moves time forward by `ms`, firing every timer that comes due on the way. */
  advanceBy(ms: number): void {
    this.advanceTo(this.current + ms);
  }

  /**
   * Moves time forward to `targetMs`, firing every timer due at or before it
   * in due order. Timers scheduled by those callbacks fire too if they also
   * come due by `targetMs`. Going backwards is a programming error.
   */
  advanceTo(targetMs: number): void {
    if (targetMs < this.current) {
      throw new Error(`simulated time cannot go backwards (${this.current} -> ${targetMs})`);
    }
    for (;;) {
      const dueAt = this.nextDueAt();
      if (dueAt === undefined || dueAt > targetMs) break;
      this.current = dueAt;
      this.fireDueAt(dueAt);
    }
    this.current = targetMs;
  }

  /**
   * Runs every timer there is, and everything they schedule, however far into
   * the future that reaches. `now()` ends up at the last timer's due time.
   */
  runAll(): void {
    // A timer that always reschedules itself would spin here, so the loop is
    // bounded rather than trusting callers.
    for (let guard = 0; this.timers.size > 0; guard += 1) {
      if (guard >= RUN_ALL_LIMIT) {
        throw new Error(`runAll fired ${RUN_ALL_LIMIT} timers without draining the queue`);
      }
      const dueAt = this.nextDueAt() as number;
      this.current = dueAt;
      this.fireDueAt(dueAt);
    }
  }

  /** Fires the timers due at exactly `dueAt`, oldest first. */
  private fireDueAt(dueAt: number): void {
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueAt <= dueAt)
      .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0]);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.fn();
    }
  }
}
