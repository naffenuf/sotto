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
