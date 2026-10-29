/**
 * The three latencies `npm run e2e` prints (PRD US-021).
 *
 * All three cross between two timelines, which is the whole difficulty. A
 * turn's `startMs`/`endMs` are positions in the *audio stream*; a card's
 * `createdAtMs` is read off the live `Clock`, whose origin is the process. So
 * nothing can be subtracted until both ends are on the wall clock, which is
 * what {@link E2eObserved} stamps everything with.
 *
 * Turns come with their own stamps, so a card's is a direct subtraction. A
 * *scripted* instant — where the trigger or deadline line ended — is only
 * known on the audio timeline, so it is mapped onto the wall by the lag
 * between the two, measured as the median of `arrival − end` over every final
 * turn the run produced. In a real-time session that lag is near-constant
 * (the API reports a position in the audio and the frame arrives 600–760 ms
 * later, `fixtures/events/NOTES.md`), and a median shrugs off the turn or two
 * where it is not.
 *
 * Pure.
 */
import type { StageCard } from "../../shared/cards.js";
import type { E2eLatency, E2eObserved, MomentLatency, Stamped } from "../../shared/e2e.js";
import type { MomentRecord } from "../../shared/eval.js";
import { deliveredForMoment, type E2eCheckInput } from "./checks.js";

/**
 * How far ahead of the audio timeline the wall clock ran, in ms.
 *
 * `null` when the run produced no final turn with an end — there is nothing
 * to measure the offset against, so nothing scripted can be placed.
 */
export function wallOffsetMs(observed: E2eObserved): number | null {
  const lags = observed.turns
    .filter((stamped) => stamped.value.endMs !== null)
    .map((stamped) => stamped.atMs - (stamped.value.endMs as number))
    .sort((a, b) => a - b);
  if (lags.length === 0) return null;
  return lags[Math.floor(lags.length / 2)] as number;
}

/** An instant on the audio timeline, placed on the wall clock. */
export function onWall(observed: E2eObserved, audioMs: number | null): number | null {
  const offset = wallOffsetMs(observed);
  if (offset === null || audioMs === null) return null;
  return audioMs + offset;
}

/** The first push of an answer card that satisfies `ready`, or `null`. */
function firstAnswerAt(
  cards: readonly Stamped<StageCard>[],
  ready: (card: StageCard) => boolean,
): number | null {
  const found = cards.find((stamped) => stamped.value.variant === "answer" && ready(stamped.value));
  return found?.atMs ?? null;
}

/** `b - a`, or `null` if either end is missing or the order is impossible. */
function gap(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b < a) return null;
  return b - a;
}

/**
 * Wake phrase heard → headline, and → the finished answer.
 *
 * Measured from the moment the indicator went up, which is the first partial
 * that matched (US-017) — i.e. from when the group could see Sotto had heard
 * its name, not from when the question finished being asked.
 */
export function answerLatency(observed: E2eObserved): Pick<
  E2eLatency,
  "wakeToHeadlineMs" | "wakeToDoneMs"
> {
  const wake = observed.wakeAtMs[0] ?? null;
  return {
    wakeToHeadlineMs: gap(
      wake,
      firstAnswerAt(observed.cards, (card) => card.headline.trim() !== ""),
    ),
    wakeToDoneMs: gap(
      wake,
      firstAnswerAt(observed.cards, (card) => card.state === "ready"),
    ),
  };
}

/** One planted moment: trigger line transcribed → its card on the stage. */
export function momentLatency(input: E2eCheckInput, moment: MomentRecord): MomentLatency {
  const card = deliveredForMoment(input, moment);
  if (card === null) {
    return { momentId: moment.id, deliveredAfterMs: null, beforeDeadline: null };
  }
  const delivered = input.observed.cards.find((stamped) => stamped.value.id === card.id)?.atMs;
  const trigger = onWall(input.observed, moment.triggerTurnEndMs);
  const deadline = onWall(input.observed, moment.deadlineTurnEndMs);
  return {
    momentId: moment.id,
    deliveredAfterMs: gap(trigger, delivered ?? null),
    beforeDeadline: delivered === undefined || deadline === null ? null : delivered <= deadline,
  };
}

/** Every latency one fixture's run can be asked for. */
export function fixtureLatency(input: E2eCheckInput): E2eLatency {
  return {
    ...answerLatency(input.observed),
    moments: input.moments.map((moment) => momentLatency(input, moment)),
  };
}
