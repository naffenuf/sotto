/**
 * V3-005: the ten seconds after Sotto offers something, in which "go on"
 * needs no wake word.
 *
 * {@link Reservations.offer} says the sentence — a statement, so that nobody
 * owes a reply — and this owns everything that happens next. The *next* final
 * turn from anybody is read by {@link OfferReplyClassifier}: a `yes` becomes
 * V2-015's spoken briefing from that packet, and everything else lets the
 * offer lapse with the card still on the stage.
 *
 * Four rules, and three of them are about saying nothing:
 *
 *   - one turn only. The offer asked for a reply to *itself*, so the sentence
 *     after it either takes it up or does not; a yes two turns later is the
 *     room asking a fresh question, which the address path already answers.
 *   - {@link OFFER_WINDOW_MS} with nobody speaking closes it, which is the
 *     ordinary outcome: a group mid-thought ignores an offer, and that is the
 *     point of making it a statement.
 *   - a turn that says Sotto's name is left to the address path (V2-008),
 *     which owes it an answer whatever it is, and the window closes without
 *     a call — "Sotto, go ahead" reaches the raised hand (V3-017), where that
 *     packet's own card is waiting to be read out.
 *   - an unreadable verdict, a failed call and a timed-out call all close it.
 *
 * The clock is the session's, like the follow-up window's: ten seconds is a
 * length of *conversation*, and a `max`-speed replay must see the same ten
 * seconds a room would.
 */
import type { ResearchPacket } from "../../shared/research.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import type { SpeakerNames } from "../../shared/events.js";
import { systemClock, type Clock } from "../clock.js";
import { detectsAddress } from "../wake.js";
import {
  OfferReplySchema,
  type OfferReplyClassifier,
  type OfferReplyKind,
  type OfferReplyResult,
} from "./offerReply.js";

/** How long the room has to take an offer up without saying the name. */
export const OFFER_WINDOW_MS = 10_000;

/** A slow classifier must not hold the window open; the verdict is then none. */
export const OFFER_TIMEOUT_CALL_MS = 6_000;

/** What became of one offer, as `timing.jsonl` records it. */
export type OfferOutcome =
  | OfferReplyKind
  | "addressed"
  | "unsure"
  | "timeout"
  | "session_ended";

export interface OfferWindowOptions {
  clock: Clock;
  /** Real time, for the latency the room would have felt. */
  wallClock?: Clock;
  classify: OfferReplyClassifier;
  speakers: () => SpeakerNames;
  /** A yes: brief the room from this packet, exactly as V2-015 does. */
  onAccepted: (
    packet: ResearchPacket,
    asked: { turnId: string; speaker: string | null; topic: string },
  ) => void;
  onTiming: (record: Record<string, unknown>) => void;
}

/** One open offer. */
interface Open {
  packet: ResearchPacket;
  topic: string;
  /** The sentence the room heard, which is the classifier's context. */
  spokenText: string;
  /** Session clock when it was said, for the log. */
  saidAtMs: number;
  cancel: () => void;
}

/** One offer at a time, per session, closed on Stop. */
export class OfferWindow {
  private readonly wall: Clock;
  private readonly seen = new Set<string>();
  private readonly ignored = new Set<string>();
  private readonly history: TurnUpdate[] = [];
  private open: Open | undefined;
  private pending: Promise<void> = Promise.resolve();
  private controller: AbortController | undefined;
  private stopped = false;

  constructor(private readonly options: OfferWindowOptions) {
    this.wall = options.wallClock ?? systemClock;
  }

  /** Whether an offer is still open, which is what stops a second being made. */
  isOpen(): boolean {
    return this.open !== undefined;
  }

  /** Sotto has just said the offer out loud: the room has ten seconds. */
  offered(input: { packet: ResearchPacket; topic: string; spokenText: string }): void {
    if (this.stopped) return;
    this.open?.cancel();
    const saidAtMs = this.options.clock.now();
    this.open = {
      packet: input.packet,
      topic: input.topic,
      spokenText: input.spokenText,
      saidAtMs,
      cancel: this.options.clock.setTimeout(() => this.close("timeout"), OFFER_WINDOW_MS),
    };
    this.options.onTiming({
      stage: "offer_window",
      event: "opened",
      atMs: saidAtMs,
      packetId: input.packet.id,
      ideaId: input.packet.ideaId,
      topic: input.topic,
    });
  }

  /** Side talk is context for the reply without being one. */
  remember(turn: TurnUpdate): void {
    if (!turn.final || isSottoTurn(turn)) return;
    if (this.history.some((previous) => previous.turnId === turn.turnId)) return;
    this.history.push(turn);
    if (this.history.length > 4) this.history.shift();
  }

  /** Echoes and anything the barge-in owns are context, never a reply. */
  ignoreTurn(turnId: string): void {
    this.ignored.add(turnId);
    if (this.ignored.size > 64) this.ignored.delete([...this.ignored][0] as string);
  }

  /**
   * Reads one final turn.
   *
   * Partials are not read: an offer is in no hurry — the card is already up —
   * and half a sentence is exactly where "yeah, but the deposit" looks like a
   * yes.
   */
  acceptTurn(turn: TurnUpdate): void {
    // Sotto's own line (V2-008a) is in the transcript, never in its ears.
    if (isSottoTurn(turn) || !turn.final) return;
    if (this.stopped || this.seen.has(turn.turnId) || this.ignored.has(turn.turnId)) return;
    this.seen.add(turn.turnId);
    const previous = [...this.history];
    this.remember(turn);
    const open = this.open;
    if (open === undefined) return;
    // The room said the name: V2-008 owes it an answer whatever it is, and
    // "Sotto, go ahead" reaches the raised hand rather than this.
    if (detectsAddress(turn.text)) {
      this.options.onTiming({
        stage: "offer_reply",
        atMs: this.options.clock.now(),
        packetId: open.packet.id,
        turnId: turn.turnId,
        kind: "addressed",
        latencyMs: 0,
      });
      this.close("addressed");
      return;
    }
    this.pending = this.pending.then(() => this.decide(turn, previous, open));
    void this.options.clock.track("offer", this.pending);
  }

  /** Session drain waits for the verdict, so a last yes still gets briefed. */
  async flush(): Promise<void> {
    await this.pending;
  }

  /** Closes the window and abandons what is in flight. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.controller = undefined;
    this.close("session_ended");
  }

  /** One turn's verdict, logged whichever way it comes out. */
  private async decide(
    turn: TurnUpdate,
    previous: readonly TurnUpdate[],
    open: Open,
  ): Promise<void> {
    if (this.stopped || this.open !== open || this.ignored.has(turn.turnId)) return;
    const started = this.wall.now();
    const result = await this.run(turn, previous, open);
    if (this.stopped || this.open !== open || this.ignored.has(turn.turnId)) return;
    const kind = result?.kind ?? "unsure";
    this.options.onTiming({
      stage: "offer_reply",
      atMs: this.options.clock.now(),
      packetId: open.packet.id,
      turnId: turn.turnId,
      kind,
      latencyMs: this.wall.now() - started,
      ...(result === null ? { fallback: true } : {}),
    });
    // One turn, whichever way it went: the offer was about the sentence that
    // followed it, and the card carries on saying what Sotto has.
    this.close(kind);
    if (kind !== "yes") return;
    this.options.onAccepted(open.packet, {
      turnId: turn.turnId,
      speaker: turn.speaker,
      topic: open.topic,
    });
  }

  /** One classification, bounded by real time. Never rejects. */
  private async run(
    turn: TurnUpdate,
    previous: readonly TurnUpdate[],
    open: Open,
  ): Promise<OfferReplyResult | null> {
    const controller = new AbortController();
    this.controller = controller;
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("offer reply classification cancelled or timed out")),
        { once: true },
      );
    });
    const cancelTimeout = this.wall.setTimeout(() => controller.abort(), OFFER_TIMEOUT_CALL_MS);
    try {
      return OfferReplySchema.parse(
        await Promise.race([
          this.options.classify(
            {
              turn,
              previous,
              speakers: this.options.speakers(),
              offer: {
                topic: open.topic,
                title: open.packet.title,
                spokenText: open.spokenText,
              },
            },
            controller.signal,
          ),
          cancelled,
        ]),
      );
    } catch {
      return null;
    } finally {
      cancelTimeout();
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private close(outcome: OfferOutcome): void {
    const open = this.open;
    if (open === undefined) return;
    this.open = undefined;
    open.cancel();
    this.options.onTiming({
      stage: "offer_window",
      event: "closed",
      atMs: this.options.clock.now(),
      packetId: open.packet.id,
      ideaId: open.packet.ideaId,
      outcome,
      openMs: Math.max(0, this.options.clock.now() - open.saidAtMs),
    });
  }
}
