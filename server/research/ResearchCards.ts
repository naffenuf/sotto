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
 *     {@link RESEARCH_CARD_COOLDOWN_MS} — but they come off the same
 *     frequency setting (V2-017), because a group that asked Sotto to
 *     contribute rarely meant everything it does unasked.
 *
 * Nothing here is ever dropped. An interjection that waits too long is about
 * a moment that has passed, but a sourced packet is about the world and is
 * still true ten minutes later, so a packet still waiting when the
 * conversation ends goes up anyway ({@link ResearchCards.flush}) — the group
 * reads the stage after Stop, which is exactly when the last search finishes.
 */
import type { StageCard } from "../../shared/cards.js";
import { DEFAULT_FREQUENCY, limitsFor, type FrequencyLimits } from "../../shared/policy.js";
import {
  RESEARCH_CARD_WINDOW_MS,
  RESEARCH_NO_ANSWER,
  researchCardHeadline,
  researchCardId,
  researchLookingHeadline,
  researchQuestionCardId,
  type ResearchCardRecord,
  type ResearchIdea,
  type ResearchPacket,
  type ResearchPendingRecord,
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
  /**
   * Puts one card on the stage.
   *
   * `packet` is `null` for the thinking card a question puts up before its
   * search has come back, and for the short no when it comes back with
   * nothing (V3-003): the card is the whole of what there is to show.
   */
  onDeliver: (card: StageCard, packet: ResearchPacket | null) => void;
  /** One `card` or `pending` line in `research.jsonl`. */
  onRecord: (record: ResearchCardRecord | ResearchPendingRecord) => void;
  /**
   * This card went up unasked, so the finding behind it may be *offered*
   * aloud (V3-005).
   *
   * Only from {@link ResearchCards.show} — a question's card is filled in
   * (V3-003) and an answer to it is spoken instead, a card the room asked for
   * is already being read out (V2-015), and a packet the session's end pushed
   * out has no room left to offer it to.
   */
  onOffer?: (packet: ResearchPacket, cardId: string) => void;
  logger?: Logger;
  /**
   * What the session's frequency setting allows (V2-017). Defaults to the
   * `normal` row, which is the pair V2-014 measured.
   */
  limits?: FrequencyLimits;
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
  private cooldownMs: number;
  private maxPerWindow: number;
  private readonly windowMs: number;

  /** Packets waiting for a pause and a budget slot, oldest first. */
  private waiting: Waiting[] = [];
  /**
   * The card already on the stage for one idea, by idea id (V3-003).
   *
   * A question the room wondered aloud puts a thinking card up at once, so
   * the packet that answers it fills in a card the group is already looking
   * at: same id, no pause to wait for, no budget to spend.
   */
  private readonly questionCards = new Map<string, { cardId: string; askedAtMs: number }>();
  /** Packets whose card is on the stage, so a second one is not a surprise. */
  private readonly delivered = new Set<string>();
  /**
   * The card each packet is on, by packet id (V3-004).
   *
   * Written down rather than derived, because a packet answering a question
   * the room wondered aloud fills in the *question's* card
   * ({@link researchQuestionCardId}) rather than taking one of its own, so
   * {@link annotate} cannot work the id out from the packet.
   */
  private readonly cardIds = new Map<string, { cardId: string; atMs: number }>();
  /** When each card went up, oldest first: the cooldown and the window. */
  private readonly shownAtMs: number[] = [];
  private cancelTimer: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly options: ResearchCardsOptions) {
    this.clock = options.clock;
    this.pauseState = options.pauseState;
    this.onDeliver = options.onDeliver;
    this.onRecord = options.onRecord;
    this.logger = options.logger ?? console;
    const limits = options.limits ?? limitsFor(DEFAULT_FREQUENCY);
    this.cooldownMs = limits.researchCardCooldownMs;
    this.maxPerWindow = limits.maxResearchCardsPerWindow;
    this.windowMs = options.windowMs ?? RESEARCH_CARD_WINDOW_MS;
  }

  /**
   * Takes a new frequency setting mid-conversation (V2-017), and looks again:
   * turning Sotto up should let a packet that was waiting on the cooldown
   * through now rather than at the next turn.
   */
  setLimits(limits: FrequencyLimits): void {
    if (
      limits.researchCardCooldownMs === this.cooldownMs &&
      limits.maxResearchCardsPerWindow === this.maxPerWindow
    ) {
      return;
    }
    this.cooldownMs = limits.researchCardCooldownMs;
    this.maxPerWindow = limits.maxResearchCardsPerWindow;
    this.review();
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
   *
   * Unless the room asked for it out loud: a packet answering a question the
   * group wondered aloud fills in the thinking card {@link pending} already
   * put on the stage (V3-003), which is neither a new card nor a surprise, so
   * it goes up now.
   */
  accept(packet: ResearchPacket): void {
    if (this.stopped) return;
    const asked = this.questionCards.get(packet.ideaId);
    if (asked !== undefined) {
      this.fillIn(packet, asked);
      return;
    }
    this.waiting.push({ packet, seenAtMs: this.clock.now() });
    this.review();
  }

  /**
   * The room wondered something aloud and Sotto is looking it up (V3-003).
   *
   * A card goes on the stage *now*, carrying the question and a thinking
   * indicator — the same `thinking` state an answer uses — so that the group,
   * and a demo audience, can see Sotto working through the twenty seconds the
   * search takes. Neither of the two rules above applies, for
   * {@link bringForward}'s reason: the room asked, so there is nothing
   * unsolicited to ration and nothing to interrupt.
   *
   * The card's id is the *idea's* (there is no packet yet), and
   * {@link accept} reuses it, so the packet fills this card in rather than
   * stacking a second one beside it.
   */
  pending(idea: ResearchIdea): string {
    const cardId = researchQuestionCardId(idea.id);
    if (this.stopped) return cardId;
    const nowMs = this.clock.now();
    this.questionCards.set(idea.id, { cardId, askedAtMs: nowMs });
    this.onRecord({ kind: "pending", atMs: nowMs, ideaId: idea.id, cardId, question: idea.question });
    this.logger.log(`[research] ${cardId} looking up: ${idea.question}`);
    this.onDeliver(
      {
        id: cardId,
        variant: "research",
        state: "thinking",
        createdAtMs: nowMs,
        headline: researchLookingHeadline(idea.question),
      },
      // There is no packet to hand over yet; the caller's only job here is to
      // put the card on the stage, which needs none.
      null,
    );
    return cardId;
  }

  /**
   * The room wondered something Sotto has already looked up (V3-003).
   *
   * No thinking card and no second search: the packet's own card comes
   * forward, open, which is what {@link bringForward} is for — they asked,
   * even if they asked by wondering rather than by name. The `pending` line
   * names the packet it was answered from, so the log says why no search
   * started.
   */
  reuse(idea: ResearchIdea, packet: ResearchPacket): void {
    if (this.stopped) return;
    this.onRecord({
      kind: "pending",
      atMs: this.clock.now(),
      ideaId: idea.id,
      cardId: researchCardId(packet.id),
      question: idea.question,
      reusedPacketId: packet.id,
    });
    this.logger.log(`[research] ${idea.id} answered from ${packet.id}: ${idea.question}`);
    this.bringForward([packet]);
  }

  /**
   * The search behind a thinking card came back with nothing showable
   * (V3-003).
   *
   * A spinner that never stops is worse than a short no: the card says so and
   * stays readable. V3-015 is what says it out loud, and only if the room
   * heard Sotto claim the question in the first place.
   */
  failed(ideaId: string, why = RESEARCH_NO_ANSWER): void {
    const asked = this.questionCards.get(ideaId);
    if (this.stopped || asked === undefined) return;
    this.questionCards.delete(ideaId);
    this.logger.log(`[research] ${asked.cardId} came back with nothing: ${why}`);
    this.onDeliver(
      {
        id: asked.cardId,
        variant: "research",
        state: "error",
        createdAtMs: this.clock.now(),
        headline: "",
        message: why,
      },
      null,
    );
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

  /**
   * Somebody asked for research, so its card comes to the top of the stage,
   * open, while Sotto briefs them on it (V2-015).
   *
   * The two rules above do not apply here, and that is the point of it: the
   * pause is irrelevant because the room is waiting for exactly this, and the
   * budget is about *unsolicited* cards — a card the group asked for is not
   * an interruption, so it neither spends a slot nor starts the cooldown.
   * What it does do is take the packet out of the queue, so the same finding
   * cannot appear again a minute later as though it were news.
   */
  bringForward(packets: readonly ResearchPacket[]): void {
    if (this.stopped || packets.length === 0) return;
    const nowMs = this.clock.now();
    const asked = new Set(packets.map((packet) => packet.id));
    const held = new Map(this.waiting.map((one) => [one.packet.id, one]));
    this.waiting = this.waiting.filter((one) => !asked.has(one.packet.id));
    for (const packet of packets) {
      const waited = held.get(packet.id);
      const already = this.delivered.has(packet.id);
      this.delivered.add(packet.id);
      this.onRecord({
        kind: "card",
        atMs: nowMs,
        packetId: packet.id,
        ideaId: packet.ideaId,
        cardId: researchCardId(packet.id),
        title: packet.title,
        heldForMs: waited === undefined ? 0 : nowMs - waited.seenAtMs,
        waiting: this.waiting.length,
        shownInWindow: this.inWindow(nowMs),
        broughtForward: true,
      });
      this.logger.log(
        `[research] ${researchCardId(packet.id)} ${
          already ? "brought forward" : "shown now, because they asked for it"
        }: ${packet.title}`,
      );
      this.cardIds.set(packet.id, { cardId: researchCardId(packet.id), atMs: nowMs });
      this.onDeliver({ ...cardForPacket(packet, nowMs), forward: true }, packet);
    }
    // The queue may have lost the packet a timer was armed for.
    this.review();
  }

  /**
   * Somebody in the room answered the question before Sotto could say what it
   * found (V3-004), so the card carries the verdict instead.
   *
   * The card is already on the stage and keeps its place and its collapsed
   * state — `forward` is deliberately not set, because nothing was asked for
   * and nothing is being read out. It spends no slot and starts no cooldown
   * for the same reason: this is the card it already was, with one more line.
   */
  annotate(packet: ResearchPacket, note: string): void {
    const shown = this.cardIds.get(packet.id);
    if (this.stopped || shown === undefined) return;
    this.logger.log(`[research] ${shown.cardId}: ${note}`);
    this.onDeliver(
      { ...cardForPacket(packet, shown.atMs), id: shown.cardId, note },
      packet,
    );
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

  /**
   * Fills in the thinking card a question put up (V3-003).
   *
   * `heldForMs` is measured from the question rather than from the packet
   * arriving, because that is the wait the room actually had, and nothing is
   * added to {@link shownAtMs}: this card was already on the stage, so it
   * spends no slot and starts no cooldown.
   */
  private fillIn(packet: ResearchPacket, asked: { cardId: string; askedAtMs: number }): void {
    const nowMs = this.clock.now();
    this.questionCards.delete(packet.ideaId);
    this.delivered.add(packet.id);
    this.onRecord({
      kind: "card",
      atMs: nowMs,
      packetId: packet.id,
      ideaId: packet.ideaId,
      cardId: asked.cardId,
      title: packet.title,
      heldForMs: nowMs - asked.askedAtMs,
      waiting: this.waiting.length,
      shownInWindow: this.inWindow(nowMs),
      filledIn: true,
    });
    this.logger.log(
      `[research] ${asked.cardId} filled in after ${nowMs - asked.askedAtMs} ms: ${packet.title}`,
    );
    this.cardIds.set(packet.id, { cardId: asked.cardId, atMs: nowMs });
    this.onDeliver({ ...cardForPacket(packet, nowMs), id: asked.cardId }, packet);
  }

  private show(held: Waiting, nowMs: number, atSessionEnd: boolean): void {
    const packet = held.packet;
    this.shownAtMs.push(nowMs);
    this.delivered.add(packet.id);
    const card = cardForPacket(packet, nowMs);
    this.cardIds.set(packet.id, { cardId: card.id, atMs: nowMs });
    this.onRecord({
      kind: "card",
      atMs: nowMs,
      packetId: packet.id,
      ideaId: packet.ideaId,
      cardId: card.id,
      title: packet.title,
      heldForMs: nowMs - held.seenAtMs,
      waiting: this.waiting.length,
      shownInWindow: this.inWindow(nowMs),
      ...(atSessionEnd ? { atSessionEnd: true } : {}),
    });
    this.logger.log(
      `[research] ${card.id} on the stage after ${nowMs - held.seenAtMs} ms` +
        `${atSessionEnd ? " (the conversation had ended)" : ""}: ${packet.title}`,
    );
    this.onDeliver(card, packet);
    // V3-005: and said, once, as a statement — at the same moment the card
    // appears, which is what makes the two one contribution. Not after the
    // conversation has ended: there is nobody left to want it.
    if (!atSessionEnd) this.options.onOffer?.(packet, card.id);
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

  /** Cards shown in the window ending now, unsolicited ones only. */
  private inWindow(nowMs: number): number {
    return this.shownAtMs.filter((at) => nowMs - at < this.windowMs).length;
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
 *
 * `raised` is always set, which is V3-017's hand: a finding Sotto has looked
 * up and not said is exactly the kind of thing the room should be able to
 * call on it for. The one that *was* said out loud (V3-004) has the flag
 * taken off it again when the sentence lands.
 */
export function cardForPacket(packet: ResearchPacket, atMs: number): StageCard {
  return {
    id: researchCardId(packet.id),
    variant: "research",
    state: "ready",
    createdAtMs: atMs,
    headline: researchCardHeadline(packet.title),
    teaser: packet.teaser,
    raised: true,
    ...(packet.keyPoints.length === 0
      ? {}
      : { detailMd: packet.keyPoints.map((point) => `- ${point}`).join("\n") }),
    ...(packet.sources.length === 0 ? {} : { citations: [...packet.sources] }),
    ...(packet.visual === undefined
      ? {}
      : { artifacts: [{ title: packet.visual.title, url: packet.visual.url }] }),
  };
}
