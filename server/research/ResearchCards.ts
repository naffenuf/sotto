/**
 * How a finished packet reaches the room (PRD V2-014).
 *
 * The search is over and the finding is written down (V2-013); this is the
 * one quiet sentence that tells the group it exists. A research card is
 * deliberately the least demanding thing Sotto does: it is never spoken, it
 * never asks for the floor, and it is compact until somebody opens it.
 *
 * Two rules decide when one goes up.
 *
 *   - **Only in a pause**, the same rule interjections follow and read off
 *     the same getter, which is {@link SessionTranscription.pauseState} — so
 *     "somebody is talking" includes Sotto's own voice playing (V2-006). A
 *     card appearing while two people are mid-exchange is a small
 *     interruption, and a finding that waited fifteen seconds for a gap is
 *     worth exactly as much as one that did not.
 *   - **Its own budget**, separate from the interjection one: a cooldown so
 *     two searches finishing together do not land in the same pause, and a
 *     cap per quarter of an hour. The numbers are smaller than the policy's
 *     because the two cost the group different things — see
 *     {@link RESEARCH_CARD_COOLDOWN_MS}.
 *
 * Nothing here is ever dropped. An interjection that waits too long is about
 * a moment that has passed, but a sourced packet is about the world and is
 * still true ten minutes later, so a packet still waiting when the
 * conversation ends goes up anyway ({@link ResearchCards.flush}) — the group
 * reads the stage after Stop, which is exactly when the last search finishes.
 */
import type { StageCard } from "../../shared/cards.js";
import {
  MAX_RESEARCH_CARDS_PER_WINDOW,
  RESEARCH_CARD_COOLDOWN_MS,
  RESEARCH_CARD_WINDOW_MS,
  researchCardHeadline,
  researchCardId,
  type ResearchCardRecord,
  type ResearchPacket,
} from "../../shared/research.js";
import type { PauseState, TurnUpdate } from "../../shared/turns.js";
import type { Clock } from "../clock.js";
import { PAUSE_MS, inPause } from "../interject/policy.js";

type Logger = Pick<Console, "log" | "warn">;

export interface ResearchCardsOptions {
  /** The session's clock — simulated for a replay, real for a live session. */
  clock: Clock;
  /** Whether anybody is talking, including Sotto: the policy's own getter. */
  pauseState: () => PauseState;
  /** Puts one card on the stage. */
  onDeliver: (card: StageCard, packet: ResearchPacket) => void;
  /** One `card` line in `research.jsonl`. */
  onRecord: (record: ResearchCardRecord) => void;
  logger?: Logger;
  cooldownMs?: number;
  maxPerWindow?: number;
  windowMs?: number;
}

/** One packet waiting for a moment to be shown in. */
interface Waiting {
  packet: ResearchPacket;
  /** When it arrived here, which is what `heldForMs` is measured from. */
  seenAtMs: number;
}

export class ResearchCards {
  private readonly clock: Clock;
  private readonly pauseState: () => PauseState;
  private readonly onDeliver: ResearchCardsOptions["onDeliver"];
  private readonly onRecord: ResearchCardsOptions["onRecord"];
  private readonly logger: Logger;
  private readonly cooldownMs: number;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;

  /** Packets waiting for a pause and a budget slot, oldest first. */
  private waiting: Waiting[] = [];
  /** When each card went up, oldest first: the cooldown and the window. */
  private readonly shownAtMs: number[] = [];
  private cancelTimer: (() => void) | undefined;
  private stopped = false;

  constructor(options: ResearchCardsOptions) {
    this.clock = options.clock;
    this.pauseState = options.pauseState;
    this.onDeliver = options.onDeliver;
    this.onRecord = options.onRecord;
    this.logger = options.logger ?? console;
    this.cooldownMs = options.cooldownMs ?? RESEARCH_CARD_COOLDOWN_MS;
    this.maxPerWindow = options.maxPerWindow ?? MAX_RESEARCH_CARDS_PER_WINDOW;
    this.windowMs = options.windowMs ?? RESEARCH_CARD_WINDOW_MS;
  }

  /** How many packets are still waiting for a moment. */
  waitingCount(): number {
    return this.waiting.length;
  }

  /** When each card went up, oldest first. */
  shown(): readonly number[] {
    return this.shownAtMs;
  }

  /**
   * Takes one sourced packet from the runner (V2-013) and shows it as soon as
   * the room is quiet and the budget allows — which, mid-sentence, is later.
   */
  accept(packet: ResearchPacket): void {
    if (this.stopped) return;
    this.waiting.push({ packet, seenAtMs: this.clock.now() });
    this.review();
  }

  /**
   * Takes one turn snapshot. Every snapshot counts, partials included: a
   * `speechEnd` arrives as a partial and it is the one that opens a pause.
   */
  acceptTurn(_turn: TurnUpdate): void {
    this.review();
  }

  /** Playback can end without an ASR frame arriving to say so (V2-006). */
  playbackChanged(): void {
    this.review();
  }

  /**
   * Closes the session out: everything still waiting goes up now.
   *
   * Deliberately not the policy's rule, which writes a held candidate off as
   * `session_ended`. A candidate is about a moment and the moment is gone; a
   * packet is about the world, cost a search, and is the thing somebody reads
   * once the talking has stopped. Nothing is being interrupted either — the
   * conversation is over.
   */
  flush(): void {
    if (this.stopped || this.waiting.length === 0) return;
    this.disarm();
    const nowMs = this.clock.now();
    const stranded = this.waiting;
    this.waiting = [];
    for (const held of stranded) this.show(held, nowMs, true);
  }

  /** No more cards. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  /** Shows what it can, and arms the next look. */
  private review(): void {
    if (this.stopped || this.waiting.length === 0) return;
    const nowMs = this.clock.now();
    const pause = this.pauseState();
    while (this.waiting.length > 0) {
      if (!inPause(pause) || this.budgetWaitMs(nowMs) > 0) break;
      const held = this.waiting.shift();
      if (held === undefined) break;
      this.show(held, nowMs, false);
    }
    this.schedule(nowMs, pause);
  }

  /** How long until the budget has room for another card; 0 when it has. */
  private budgetWaitMs(nowMs: number): number {
    let wait = 0;
    const last = this.shownAtMs.at(-1);
    if (last !== undefined && nowMs - last < this.cooldownMs) {
      wait = this.cooldownMs - (nowMs - last);
    }
    const recent = this.shownAtMs.filter((at) => nowMs - at < this.windowMs);
    const oldest = recent[0];
    if (recent.length >= this.maxPerWindow && oldest !== undefined) {
      wait = Math.max(wait, oldest + this.windowMs - nowMs + 1);
    }
    return wait;
  }

  private show(held: Waiting, nowMs: number, atSessionEnd: boolean): void {
    const packet = held.packet;
    this.shownAtMs.push(nowMs);
    const card = cardForPacket(packet, nowMs);
    this.onRecord({
      kind: "card",
      atMs: nowMs,
      packetId: packet.id,
      ideaId: packet.ideaId,
      title: packet.title,
      heldForMs: nowMs - held.seenAtMs,
      waiting: this.waiting.length,
      shownInWindow: this.shownAtMs.filter((at) => nowMs - at < this.windowMs).length,
      ...(atSessionEnd ? { atSessionEnd: true } : {}),
    });
    this.logger.log(
      `[research] ${card.id} on the stage after ${nowMs - held.seenAtMs} ms` +
        `${atSessionEnd ? " (the conversation had ended)" : ""}: ${packet.title}`,
    );
    this.onDeliver(card, packet);
  }

  /**
   * One timer for the soonest thing that could let a waiting packet through.
   *
   * The same shape the policy's re-check has, and for the same reason: both
   * of the things that change the answer — silence reaching {@link PAUSE_MS}
   * and the budget's cooldown running out — happen with nothing arriving to
   * say so. While somebody is talking there is nothing to arm: the turn
   * closing is what comes next.
   */
  private schedule(nowMs: number, pause: PauseState): void {
    this.disarm();
    if (this.waiting.length === 0 || pause.speaking) return;
    const due: number[] = [];
    if (pause.silentForMs < PAUSE_MS) due.push(PAUSE_MS - pause.silentForMs);
    const budget = this.budgetWaitMs(nowMs);
    if (budget > 0) due.push(budget);
    if (due.length === 0) return;
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = undefined;
      this.review();
    }, Math.min(...due));
  }

  private disarm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
}

/**
 * The card for one packet.
 *
 * Pure, and as dull as the interjection's: the packet already holds exactly
 * what a reader needs, so this only lays it out. The key points become the
 * markdown the card opens into, the sources become its numbered citations and
 * the visual — if the search drew one — becomes the sandboxed frame an
 * answer's artifact uses (US-020).
 *
 * `state` is always `ready`: a packet exists only once its search has come
 * back and its sources have been resolved, so nothing about it is still
 * arriving.
 */
export function cardForPacket(packet: ResearchPacket, atMs: number): StageCard {
  return {
    id: researchCardId(packet.id),
    variant: "research",
    state: "ready",
    createdAtMs: atMs,
    headline: researchCardHeadline(packet.title),
    teaser: packet.teaser,
    ...(packet.keyPoints.length === 0
      ? {}
      : { detailMd: packet.keyPoints.map((point) => `- ${point}`).join("\n") }),
    ...(packet.sources.length === 0 ? {} : { citations: [...packet.sources] }),
    ...(packet.visual === undefined
      ? {}
      : { artifacts: [{ title: packet.visual.title, url: packet.visual.url }] }),
  };
}
