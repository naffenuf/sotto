/**
 * The room turning Sotto down, or up (PRD V3-006).
 *
 *     Sotto says something unasked ----> 15 s window ----> "Sotto, not now"
 *                                                            |
 *                                   frequency one step down  v  notice card
 *
 *     a human voice cuts an unprompted line off, twice in 10 minutes
 *                                   frequency one step down, silently
 *
 * Two ways to steer the one setting V2-017 made of the old chattiness, and
 * neither of them is the header: a group should be able to say "that's too
 * much" out loud and have it stick, and a group that keeps talking over Sotto
 * has said the same thing without using any words at all.
 *
 * Four decisions worth knowing about.
 *
 * **Only the frequency moves.** A group telling Sotto to be quiet is asking
 * for *less*, not for a higher bar — boldness is about what is worth saying,
 * which is not what "not now" is about. So this steps {@link Frequency} and
 * leaves {@link Boldness} where the header put it.
 *
 * **"Stop" means quieter only inside the window.** The same word means two
 * different things depending on what Sotto was doing: during an answer to a
 * direct question it is "that's enough of this answer", and during something
 * Sotto said unasked it is "stop doing that". The only thing that separates
 * them is whether an unprompted contribution is in flight or was in the last
 * {@link STEER_WINDOW_MS}, which is what {@link Steering.noteContribution}
 * records. `quieter` and `louder` are explicit, so they apply either way.
 *
 * **A yield is a hint, not a verdict.** One yield is an accident of timing —
 * somebody was mid-thought — so it takes {@link YIELDS_FOR_QUIETER} inside
 * {@link YIELD_WINDOW_MS} to move the setting, and the counter resets when it
 * does, so ten minutes of being talked over costs one step rather than five.
 * Yields during an answer to a direct question never arrive here: only
 * `Reservations` reports them, and everything it says is unprompted.
 *
 * **It never speaks.** Every change is a `notice` card and a line in
 * `timing.jsonl`. Sotto answering "all right, I'll keep quiet" out loud would
 * be one more unprompted contribution in the one moment the room has just
 * said it does not want them.
 */
import { NOTICE_CARD_IDS, type StageCard } from "../../shared/cards.js";
import {
  steppedFrequency,
  type Frequency,
  type SteerDirection,
} from "../../shared/policy.js";
import type { Clock } from "../clock.js";

type Logger = Pick<Console, "log" | "warn">;

/**
 * How long after an unprompted contribution an addressed "stop" is still
 * about it.
 *
 * The PRD's fifteen seconds: long enough for somebody to finish the sentence
 * they were in and then turn to Sotto, short enough that a "stop" about
 * something else entirely does not land on the frequency setting.
 */
export const STEER_WINDOW_MS = 15_000;

/** How long two yields have to fall inside to count as the room's hint. */
export const YIELD_WINDOW_MS = 600_000;

/** How many yields inside that window step the frequency down. */
export const YIELDS_FOR_QUIETER = 2;

/** What asked for a change, which is the only thing the two paths differ by. */
export type SteerSource = "quieter" | "louder" | "stop" | "yields";

/** The note the room reads, per direction. */
const NOTES: Readonly<Record<SteerDirection, string>> = {
  quieter: "Sotto will speak up less",
  louder: "Sotto will speak up more",
};

export interface SteeringOptions {
  clock: Clock;
  /** The frequency as it now stands, which the manager owns. */
  frequency: () => Frequency;
  /** Applies the step: the header, `session.json` and the running loops. */
  setFrequency: (frequency: Frequency) => void;
  /** Puts the note on the stage. */
  onCard: (card: StageCard) => void;
  onTiming?: (record: Record<string, unknown>) => void;
  logger?: Logger;
}

export class Steering {
  private readonly clock: Clock;
  private readonly logger: Logger;
  /** When the last unprompted contribution was made, or `null` for none yet. */
  private contributedAtMs: number | null = null;
  /** When unprompted lines were talked over, inside {@link YIELD_WINDOW_MS}. */
  private yieldsAtMs: number[] = [];
  /** Notes shown so far, so each change is its own card rather than a replacement. */
  private notes = 0;
  private stopped = false;

  constructor(private readonly options: SteeringOptions) {
    this.clock = options.clock;
    this.logger = options.logger ?? console;
  }

  /**
   * Sotto just contributed something nobody asked for: a spoken reservation
   * or answer (V3-015, V3-004), an interjection card or a research card.
   *
   * Called at the start *and* the end of a spoken line, so "during" is
   * covered by the window as surely as "within 15 s after" is.
   */
  noteContribution(): void {
    if (this.stopped) return;
    this.contributedAtMs = this.clock.now();
  }

  /**
   * One `spoken_contribution` line (V3-015, V3-004), which is the only record
   * of everything Sotto says unasked.
   *
   * Two things it can mean: the room heard something nobody asked for, which
   * opens the window; and a voice in the room cut it off, which is the hint.
   * Both read off the record rather than out of the caller, so the rule lives
   * in one place.
   */
  observe(record: { spoken: boolean; yielded?: boolean; turnId?: string }): void {
    if (record.spoken) this.noteContribution();
    if (record.yielded === true) this.noteYield(record.turnId);
  }

  /** Whether an addressed "stop" right now would be about something unasked. */
  inWindow(): boolean {
    if (this.contributedAtMs === null) return false;
    return this.clock.now() - this.contributedAtMs <= STEER_WINDOW_MS;
  }

  /**
   * A command the room addressed to Sotto (V2-007's classifier, V3-006's two
   * new kinds). `stop` only steers inside the window; the other two always do.
   */
  commanded(command: SteerSource, turnId?: string | null): void {
    if (this.stopped) return;
    if (command === "yields") return;
    if (command === "stop") {
      if (!this.inWindow()) {
        this.record({ source: "stop", applied: false, reason: "not_unprompted", turnId });
        return;
      }
      this.steer("quieter", "stop", turnId);
      return;
    }
    this.steer(command, command, turnId);
  }

  /**
   * A voice in the room cut an unprompted line off (V3-004's yield).
   *
   * Counts silently: the frequency drops on the second one inside ten
   * minutes, and the note on the stage is the only sign.
   */
  noteYield(turnId?: string | null): void {
    if (this.stopped) return;
    const nowMs = this.clock.now();
    this.yieldsAtMs = [...this.yieldsAtMs, nowMs].filter(
      (atMs) => nowMs - atMs < YIELD_WINDOW_MS,
    );
    if (this.yieldsAtMs.length < YIELDS_FOR_QUIETER) {
      this.record({
        source: "yields",
        applied: false,
        reason: "below_hint",
        yields: this.yieldsAtMs.length,
        turnId,
      });
      return;
    }
    // One step per run of yields: being talked over five times in ten minutes
    // is the same message as being talked over twice.
    this.yieldsAtMs = [];
    this.steer("quieter", "yields", turnId, YIELDS_FOR_QUIETER);
  }

  /** The end of the session: a late command must not change the next one. */
  stop(): void {
    this.stopped = true;
  }

  /** How many yields are counting towards the next step, for tests and logs. */
  yields(): number {
    const nowMs = this.clock.now();
    return this.yieldsAtMs.filter((atMs) => nowMs - atMs < YIELD_WINDOW_MS).length;
  }

  private steer(
    direction: SteerDirection,
    source: SteerSource,
    turnId?: string | null,
    yields?: number,
  ): void {
    const from = this.options.frequency();
    const to = steppedFrequency(from, direction);
    if (to === from) {
      // Nowhere further to go, so there is nothing to tell the room: a note
      // saying nothing changed is noise in the one moment it asked for less.
      this.logger.log(`[steer] already ${from}; ${direction} changes nothing`);
      this.record({ source, direction, from, to, applied: false, reason: "at_limit", turnId, yields });
      return;
    }
    this.options.setFrequency(to);
    this.notes += 1;
    this.options.onCard({
      id: `${NOTICE_CARD_IDS.steering}-${this.notes}`,
      variant: "notice",
      state: "ready",
      createdAtMs: this.clock.now(),
      headline: NOTES[direction],
      detailMd: `How often Sotto contributes unasked is now **${to}**. Change it in the header any time.`,
    });
    this.logger.log(`[steer] ${direction} (${source}): ${from} -> ${to}`);
    this.record({ source, direction, from, to, applied: true, turnId, yields });
  }

  private record(fields: {
    source: SteerSource;
    applied: boolean;
    direction?: SteerDirection;
    from?: Frequency;
    to?: Frequency;
    reason?: string;
    turnId?: string | null | undefined;
    yields?: number | undefined;
  }): void {
    this.options.onTiming?.({
      stage: "steering",
      atMs: this.clock.now(),
      ...fields,
      ...(fields.turnId === undefined ? {} : { turnId: fields.turnId }),
    });
  }
}
