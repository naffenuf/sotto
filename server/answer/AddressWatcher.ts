/**
 * V2-008 separates instant lexical listening from final-turn intent. Finals
 * stay ordered so a request arriving during a name-only classification still
 * sees that speaker's arm; deadlines use real time even in max-speed replay.
 */
import type { SpeakerNames } from "../../shared/events.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { systemClock, type Clock } from "../clock.js";
import { detect, detectsAddress } from "../wake.js";
import type { WakeTrigger } from "../wakeWatcher.js";
import { AddressSchema, type AddressClassifier } from "./address.js";

/** A pause after saying the name may split one request into two ASR turns. */
export const ADDRESS_ARM_MS = 8_000;
/** A slow classifier must not leave the room indefinitely waiting. */
export const ADDRESS_TIMEOUT_MS = 6_000;

/** Effects are shared with the old wake watcher; only the intent decision changes. */
export interface AddressWatcherOptions {
  clock: Clock;
  wallClock?: Clock;
  classify: AddressClassifier;
  speakers: () => SpeakerNames;
  onListening: (listening: boolean) => void;
  onQuestion: (trigger: WakeTrigger) => void;
  onTiming: (record: Record<string, unknown>) => void;
}

interface ArmedSpeaker {
  turn: TurnUpdate;
  expiresAt: number;
  cancel: () => void;
}

/** One watcher per session, retired on Stop so a late classification cannot answer. */
export class AddressWatcher {
  private readonly wall: Clock;
  private readonly seen = new Set<string>();
  private readonly ignored = new Set<string>();
  private readonly history: TurnUpdate[] = [];
  private readonly listeningTurns = new Set<string>();
  private readonly armed = new Map<string, ArmedSpeaker>();
  private pending: Promise<void> = Promise.resolve();
  private active: AbortController | undefined;
  private stopped = false;
  private isListening = false;

  constructor(private readonly options: AddressWatcherOptions) {
    this.wall = options.wallClock ?? systemClock;
  }

  /** Human side talk can provide context without being eligible to trigger an answer. */
  remember(turn: TurnUpdate): void {
    if (!turn.final || this.history.some((previous) => previous.turnId === turn.turnId)) return;
    this.history.push(turn);
    if (this.history.length > 4) this.history.shift();
  }

  /** Echoes and playback commands are owned elsewhere, including their pending partials. */
  ignoreTurn(turnId: string): void {
    this.ignored.add(turnId);
    this.listeningTurns.delete(turnId);
    for (const speaker of this.armed.keys()) this.disarm(speaker);
    this.publishListening();
  }

  /** Listens on partials; classifies eligible final turns exactly once and in arrival order. */
  acceptTurn(turn: TurnUpdate): void {
    if (this.stopped || this.seen.has(turn.turnId) || this.ignored.has(turn.turnId)) return;
    const named = detectsAddress(turn.text);
    if (named) this.listeningTurns.add(turn.turnId);
    else this.listeningTurns.delete(turn.turnId);
    this.publishListening();
    if (!turn.final) return;
    this.seen.add(turn.turnId);
    const previous = [...this.history];
    this.remember(turn);
    const arrivedAt = this.options.clock.now();
    this.pending = this.pending.then(() => this.classify(turn, previous, arrivedAt, named));
    void this.options.clock.track("address", this.pending);
  }

  /** Session drain waits for final intent before draining the answers it may enqueue. */
  async flush(): Promise<void> {
    await this.pending;
  }

  /** Clears arms and aborts work without letting late results restore the listening indicator. */
  stop(): void {
    this.stopped = true;
    this.active?.abort();
    for (const speaker of this.armed.keys()) this.disarm(speaker);
    this.listeningTurns.clear();
    this.publishListening();
  }

  private async classify(
    turn: TurnUpdate,
    previous: TurnUpdate[],
    arrivedAt: number,
    named: boolean,
  ): Promise<void> {
    if (this.stopped || this.ignored.has(turn.turnId)) return;
    const arm = turn.speaker === null ? undefined : this.armed.get(turn.speaker);
    const followsName = arm !== undefined && arrivedAt < arm.expiresAt;
    if (!named && !followsName) return;
    if (turn.speaker !== null) this.disarm(turn.speaker);
    // Keep the name-only turn even when several other people spoke between the two halves.
    if (followsName && !previous.some((item) => item.turnId === arm.turn.turnId)) {
      previous = [arm.turn, ...previous.slice(-3)];
    }
    this.listeningTurns.add(turn.turnId);
    this.publishListening();
    const started = this.wall.now();
    const controller = new AbortController();
    this.active = controller;
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("address cancelled or timed out")),
        { once: true });
    });
    const cancelTimeout = this.wall.setTimeout(() => controller.abort(), ADDRESS_TIMEOUT_MS);
    let fallback = false;
    let result;
    try {
      result = AddressSchema.parse(await Promise.race([
        this.options.classify({ turn, previous, speakers: this.options.speakers() }, controller.signal),
        cancelled,
      ]));
    } catch {
      if (this.stopped || this.ignored.has(turn.turnId)) return;
      fallback = true;
      const match = detect(turn.text);
      result = { kind: match.triggered ? "request" : "mention", question: match.question ?? "" };
      this.options.onTiming({
        stage: "address_fallback", atMs: this.options.clock.now(), turnId: turn.turnId,
      });
    } finally {
      cancelTimeout();
      this.active = undefined;
      this.listeningTurns.delete(turn.turnId);
    }
    if (this.stopped || this.ignored.has(turn.turnId)) return;
    this.options.onTiming({
      stage: "address", atMs: this.options.clock.now(), turnId: turn.turnId,
      kind: result.kind, latencyMs: this.wall.now() - started, fallback,
    });
    if (result.kind === "name_only" && turn.speaker !== null) {
      this.arm(turn, turn.speaker, arrivedAt);
    }
    this.publishListening();
    if (result.kind === "request") {
      this.options.onQuestion({ turnId: turn.turnId, speaker: turn.speaker, question: result.question });
    }
  }

  private arm(turn: TurnUpdate, speaker: string, arrivedAt: number): void {
    const expiresAt = arrivedAt + ADDRESS_ARM_MS;
    const remaining = expiresAt - this.options.clock.now();
    // Retain the expiry timestamp for finals already queued before the deadline.
    // The timer only lowers the indicator; eligibility uses each final's arrival.
    const cancel = remaining <= 0 ? () => {} : this.options.clock.setTimeout(() => {
      this.publishListening();
    }, remaining);
    this.armed.set(speaker, { turn, expiresAt, cancel });
  }

  private disarm(speaker: string): void {
    this.armed.get(speaker)?.cancel();
    this.armed.delete(speaker);
  }

  private publishListening(): void {
    const armed = [...this.armed.values()].some((arm) => arm.expiresAt > this.options.clock.now());
    const listening = !this.stopped && (this.listeningTurns.size > 0 || armed);
    if (listening === this.isListening) return;
    this.isListening = listening;
    this.options.onListening(listening);
  }
}
