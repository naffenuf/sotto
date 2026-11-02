/**
 * What happens when the group is going round in circles (PRD V3-007).
 *
 * The observer notices the loop and hands over a `stall` candidate; this
 * decides whether to write a few ideas for it, writes them, and hands them to
 * {@link Reservations} to be *offered* — "I've got a few ideas on the name if
 * they'd help" — in V3-005's statement form. Nothing is said about them and
 * nothing is shown unless somebody in the room takes the offer up.
 *
 * Three gates, in this order, and two of them exist to say no:
 *
 *   - **One at a time.** While a set of ideas is being written, or waiting to
 *     be offered, a second stall is written down and dropped. A group that is
 *     stuck stays stuck for several turns, so the observer will notice the
 *     same loop again on the next look.
 *   - **At most one offer per ten minutes** ({@link STALL_OFFER_COOLDOWN_MS}),
 *     the PRD's number. Counted from the offer being queued, which is the
 *     moment the ideas have cost a model call.
 *   - **Ideas, or nothing.** A reply with an empty list is the prompt's own
 *     "real answer" — everything it could think of was something they had
 *     already tried — and it is recorded as `no_ideas` rather than offered.
 *     A call that does not come back is recorded as `failed`, for the same
 *     reason the research gate never throws: an unmade offer must not be a
 *     crash.
 *
 * Every noticed stall produces a line of `timing.jsonl` whichever way it goes,
 * because "the group was stuck and Sotto said nothing" is what the limits are
 * *for* and a reader has to be able to tell it from "nothing was noticed".
 */
import type { Board } from "../../shared/board.js";
import type { Candidate } from "../../shared/candidates.js";
import type { StageCard } from "../../shared/cards.js";
import { NOTICE_CARD_IDS } from "../../shared/cards.js";
import {
  STALL_OFFER_COOLDOWN_MS,
  type StallIdeas,
  type StallLogRecord,
  type StallOutcome,
} from "../../shared/stall.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { systemClock, type Clock } from "../clock.js";
import { STALL_TRACK_LABEL, type StallIdeasWriter } from "./stallIdeas.js";
import { StallIdeasReplySchema } from "../../shared/stall.js";

type Logger = Pick<Console, "log" | "warn">;

export interface StallOffersOptions {
  /** The session's clock — simulated for a replay, real for a live session. */
  clock: Clock;
  /** Real time, for the latency the call really took. */
  wallClock?: Clock;
  /** Writes the ideas: one Spark call, injected so a test makes none. */
  write: StallIdeasWriter;
  /** The board, read the way the observer and the planner read it. */
  board: () => Board;
  /** The room's final turns, oldest first — Sotto's own are not among them. */
  turns: () => readonly TurnUpdate[];
  /**
   * Queues the offer. `false` means another offer is already waiting or still
   * open (V3-005's one-at-a-time rule), which is not this module's clock to
   * keep.
   */
  offer: (ideas: StallIdeas) => boolean;
  /** One `stall` line of `timing.jsonl`. */
  onRecord: (record: StallLogRecord) => void;
  logger?: Logger;
  cooldownMs?: number;
}

export class StallOffers {
  private readonly clock: Clock;
  private readonly wall: Clock;
  private readonly logger: Logger;
  private readonly cooldownMs: number;
  /** Sets of ideas handed over so far, which is what numbers their ids. */
  private made = 0;
  /** Every set of ideas, by id, so the offer's record can find its own. */
  private readonly sets = new Map<string, StallIdeas>();
  /** True while one set of ideas is being written or waiting to be offered. */
  private busy = false;
  /** When the last offer was queued, which the ten minutes count from. */
  private lastOfferAtMs: number | null = null;
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: StallOffersOptions) {
    this.clock = options.clock;
    this.wall = options.wallClock ?? systemClock;
    this.logger = options.logger ?? console;
    this.cooldownMs = options.cooldownMs ?? STALL_OFFER_COOLDOWN_MS;
  }

  /**
   * One `stall` the observer noticed.
   *
   * Returns at once, like the observer and the verifier, but registers the
   * call with {@link Clock.track} first so a `max`-speed replay still waits
   * for it.
   */
  accept(candidate: Candidate): void {
    if (this.stopped) return;
    const nowMs = this.clock.now();
    if (this.busy) {
      this.record(candidate, "offer_open", nowMs);
      return;
    }
    const since = this.lastOfferAtMs === null ? null : nowMs - this.lastOfferAtMs;
    if (since !== null && since < this.cooldownMs) {
      this.record(candidate, "cooldown", nowMs);
      return;
    }
    this.busy = true;
    this.pending = this.pending.then(() => this.run(candidate));
    void this.clock.track(STALL_TRACK_LABEL, this.pending);
  }

  /** How many sets of ideas have been handed over. */
  offered(): number {
    return this.made;
  }

  /**
   * One set of ideas by id, or `undefined`.
   *
   * What the offer's `spoken_contribution` record is resolved through: the
   * record carries the ideas' id as its `ideaId` and nothing else, so this is
   * how the ten-second window learns what was offered (V3-005's window takes
   * either).
   */
  ideasFor(stallId: string): StallIdeas | undefined {
    return this.sets.get(stallId);
  }

  /** Resolves once the ideas in flight have been written and offered. */
  async flush(): Promise<void> {
    await this.pending;
  }

  /** No more ideas. Idempotent. */
  stop(): void {
    this.stopped = true;
  }

  /** One set of ideas: written, then offered or written off. */
  private async run(candidate: Candidate): Promise<void> {
    const startedAt = this.wall.now();
    try {
      const reply = StallIdeasReplySchema.parse(
        await this.options.write({
          candidate,
          board: this.options.board(),
          turns: this.options.turns(),
        }),
      );
      const latencyMs = this.wall.now() - startedAt;
      if (this.stopped) {
        this.record(candidate, "session_ended", this.clock.now(), { latencyMs });
        return;
      }
      if (reply.ideas.length === 0) {
        this.logger.log(`[stall] ${candidate.id}: nothing they have not already tried`);
        this.record(candidate, "no_ideas", this.clock.now(), { latencyMs, topic: reply.topic });
        return;
      }
      const nowMs = this.clock.now();
      this.made += 1;
      const ideas: StallIdeas = {
        id: `stall-${this.made}`,
        candidateId: candidate.id,
        topic: reply.topic.trim() === "" ? candidate.headline : reply.topic,
        stuckOn: candidate.headline,
        ideas: reply.ideas,
        turnId: candidate.evidence.at(-1)?.turnId ?? candidate.evidenceTurnIds.at(-1) ?? "",
        createdAtMs: nowMs,
      };
      this.sets.set(ideas.id, ideas);
      const queued = this.options.offer(ideas);
      if (queued) this.lastOfferAtMs = nowMs;
      this.logger.log(
        `[stall] ${ideas.id} ${queued ? "offering" : "not offered (another offer is open):"} ` +
          `${ideas.ideas.length} idea(s) on ${ideas.topic}`,
      );
      this.record(candidate, queued ? "offered" : "offer_open", nowMs, {
        latencyMs,
        stallId: ideas.id,
        topic: ideas.topic,
        ideas: ideas.ideas,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[stall] ${candidate.id} produced no ideas: ${detail}`);
      this.record(candidate, "failed", this.clock.now(), {
        latencyMs: this.wall.now() - startedAt,
        error: detail,
      });
    } finally {
      this.busy = false;
    }
  }

  private record(
    candidate: Candidate,
    outcome: StallOutcome,
    atMs: number,
    extra: Partial<StallLogRecord> = {},
  ): void {
    this.options.onRecord({
      stage: "stall",
      atMs,
      candidateId: candidate.id,
      headline: candidate.headline,
      outcome,
      ...extra,
    });
  }
}

/**
 * The card that goes up when somebody takes the offer up (PRD V3-007).
 *
 * A `notice`: Sotto's own suggestion rather than a reading of the
 * conversation, so it carries no "Sotto noticed…" label and no feedback
 * buttons — there is no decision to speak here for the group to have an
 * opinion about, which is also what keeps it out of the eval's delivery
 * filters. It appears only on a yes, because ideas nobody asked for are
 * exactly what the offer exists to not do.
 */
export function stallIdeasCard(ideas: StallIdeas, atMs: number): StageCard {
  return {
    id: stallIdeasCardId(ideas.id),
    variant: "notice",
    state: "ready",
    createdAtMs: atMs,
    headline: `A few ideas on ${ideas.topic}`,
    detailMd: ideas.ideas.map((idea) => `- ${idea}`).join("\n"),
  };
}

/** `notice-ideas-stall-1`: derived, so pushing it twice replaces it. */
export function stallIdeasCardId(stallId: string): string {
  return `${NOTICE_CARD_IDS.ideas}-${stallId}`;
}
