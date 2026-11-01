/**
 * V2-008 separates instant lexical listening from final-turn intent. Finals
 * stay ordered so a request arriving during a name-only classification still
 * sees that speaker's arm; deadlines use real time even in max-speed replay.
 *
 * V2-008b moves the Spark check off the critical path. The check is the
 * biggest piece of the four seconds the V2-008 retest measured between
 * somebody's name and "Mm-hm", and it used to start only when the turn went
 * final — which is the same instant `speechEnd` arrives, since `speechComplete`
 * lands with it. But the text was known earlier, so a named **partial** is
 * classified instead and the final reuses that answer rather than starting a
 * call of its own.
 *
 * Waiting for the partial's text to settle is not enough on its own: the last
 * partial of a turn lands a median 882 ms before `speechEnd` across the 273
 * captured turns, so a settle rule can never buy more than that and the check
 * takes two and a half seconds. So the usual trigger is the PRD's other one:
 * {@link ADDRESS_EARLY_WORDS} words after the name, which over the six
 * captured turns where somebody says it fires 1.8–4.9 s before `speechEnd`
 * arrives. Measured against real Spark on those four wake captures, the final
 * turn then waits **0.07–0.69 ms** for a verdict that took 1.9–3.0 s to
 * reach. {@link ADDRESS_SETTLE_MS} catches the short turns that never reach
 * four words.
 *
 * That means the early check usually reads a *fragment*, and the rules for
 * reusing its answer follow from which part of it survives the rest of the
 * sentence:
 *
 *   - The **verdict** does: "Sotto what do the main" is a request however it
 *     ends. The **question** does not, so an extended request takes its
 *     question from the final text ({@link questionAfterName}) — which is
 *     exactly what the core build answered from before any of this existed.
 *   - A `name_only` is the one verdict the rest of the sentence can overturn,
 *     because the request *is* the rest of the sentence. Any extension is
 *     checked again.
 *   - A `mention` that grew by more than {@link ADDRESS_EXTENSION_WORDS} is
 *     checked again too. Nobody is waiting on a mention, so there is nothing
 *     to be gained by deciding it from a fragment.
 *
 * Nothing about *when* Sotto speaks changes: the acknowledgment still waits
 * for the final turn, because answering while somebody is still talking is
 * the one thing worse than answering slowly.
 */
import type { SpeakerNames } from "../../shared/events.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { systemClock, type Clock } from "../clock.js";
import { detect, detectsAddress, questionAfterName } from "../wake.js";
import type { WakeTrigger } from "../wakeWatcher.js";
import { AddressSchema, type AddressClassifier } from "./address.js";

/** A pause after saying the name may split one request into two ASR turns. */
export const ADDRESS_ARM_MS = 8_000;
/** A slow classifier must not leave the room indefinitely waiting. */
export const ADDRESS_TIMEOUT_MS = 6_000;
/**
 * Words after the name that are enough to tell what the turn is doing.
 *
 * Measured on the six captured turns that say the name: four words after it
 * is reached 1,752–4,865 ms before `speechEnd` arrives, against 280 ms for
 * waiting until the speaker stops.
 */
export const ADDRESS_EARLY_WORDS = 4;

/**
 * How long a named partial's text must hold still before it is checked early,
 * for the turns that never reach {@link ADDRESS_EARLY_WORDS}.
 *
 * 600 ms because mid-speech partials arrive a median 310 ms apart (p75 482,
 * p90 641) across the captures: a 300 ms settle would fire half way through
 * most sentences.
 */
export const ADDRESS_SETTLE_MS = 600;

/** Words a final may add to a checked `mention` before it is read again. */
export const ADDRESS_EXTENSION_WORDS = 3;

/** What one classification came to, once it has been through the schema. */
type AddressResult = { kind: "request" | "name_only" | "mention"; question: string };

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

/** A partial being watched for its text to hold still. */
interface Settling {
  text: string;
  cancel: () => void;
}

/** A classification started on a partial, waiting for the turn to go final. */
interface EarlyCheck {
  /** The partial text the classifier was given. */
  text: string;
  /** Never rejects: `null` is a check that failed, timed out or was abandoned. */
  result: Promise<AddressResult | null>;
  controller: AbortController;
  /** Real time it started, for the log. */
  startedAtMs: number;
}

/** One watcher per session, retired on Stop so a late classification cannot answer. */
export class AddressWatcher {
  private readonly wall: Clock;
  private readonly seen = new Set<string>();
  private readonly ignored = new Set<string>();
  private readonly history: TurnUpdate[] = [];
  private readonly listeningTurns = new Set<string>();
  private readonly armed = new Map<string, ArmedSpeaker>();
  private readonly settling = new Map<string, Settling>();
  private readonly early = new Map<string, EarlyCheck>();
  /** Real time each turn's `speechEnd` reached the server, for `speechEndToAckMs`. */
  private readonly heard = new Map<string, number>();
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
    this.abandon(turnId);
    for (const speaker of this.armed.keys()) this.disarm(speaker);
    this.publishListening();
  }

  /** Listens on partials; classifies eligible final turns exactly once and in arrival order. */
  acceptTurn(turn: TurnUpdate): void {
    // Sotto's own line is in the transcript (V2-008a), never in its ears.
    if (isSottoTurn(turn)) return;
    if (this.stopped || this.seen.has(turn.turnId) || this.ignored.has(turn.turnId)) return;
    const named = detectsAddress(turn.text);
    if (named) this.listeningTurns.add(turn.turnId);
    else this.listeningTurns.delete(turn.turnId);
    this.publishListening();
    if (!turn.final) {
      // A closed partial is `speechEnd`: the room has stopped talking, which
      // is where the acknowledgment latency is measured from.
      if (turn.endMs !== null) this.noteSpeechEnd(turn.turnId);
      if (named) this.watchPartial(turn);
      else this.unwatch(turn.turnId);
      return;
    }
    this.unwatch(turn.turnId);
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
    for (const turnId of [...this.settling.keys(), ...this.early.keys()]) this.abandon(turnId);
    for (const speaker of this.armed.keys()) this.disarm(speaker);
    this.listeningTurns.clear();
    this.publishListening();
  }

  /**
   * Decides whether a named partial is worth checking yet.
   *
   * Four words after the name and the check goes out now; anything shorter
   * waits for the text to hold still, on a timer reset by every change. One
   * early check per turn either way: a second would be racing the first with
   * no way to tell which answer the final belongs to.
   */
  private watchPartial(turn: TurnUpdate): void {
    if (this.early.has(turn.turnId)) return;
    const text = turn.text.trim();
    if (text === "") return;
    if (wordsOf(questionAfterName(text)).length >= ADDRESS_EARLY_WORDS) {
      this.unwatch(turn.turnId);
      this.startEarly(turn);
      return;
    }
    const settling = this.settling.get(turn.turnId);
    if (settling?.text === text) return;
    settling?.cancel();
    const cancel = this.options.clock.setTimeout(() => {
      this.settling.delete(turn.turnId);
      this.startEarly(turn);
    }, ADDRESS_SETTLE_MS);
    this.settling.set(turn.turnId, { text, cancel });
  }

  /** Classifies a settled partial, off the chain the finals are serialized on. */
  private startEarly(turn: TurnUpdate): void {
    if (this.stopped || this.seen.has(turn.turnId) || this.ignored.has(turn.turnId)) return;
    if (this.early.has(turn.turnId)) return;
    const controller = new AbortController();
    const result = this.run(turn, [...this.history], controller);
    this.early.set(turn.turnId, {
      text: turn.text,
      result,
      controller,
      startedAtMs: this.wall.now(),
    });
    this.options.onTiming({
      stage: "address_early", event: "started", atMs: this.options.clock.now(),
      turnId: turn.turnId, characters: turn.text.trim().length,
    });
    // Tracked like the finals, so a max-speed replay waits for it rather than
    // running the conversation past a question it has only just heard.
    void this.options.clock.track("address", result);
  }

  /** Forgets whatever is in flight for one turn: an echo, a command, or Stop. */
  private abandon(turnId: string): void {
    this.unwatch(turnId);
    const early = this.early.get(turnId);
    if (early === undefined) return;
    this.early.delete(turnId);
    early.controller.abort();
  }

  /** Cancels a settle timer that will never be worth firing. */
  private unwatch(turnId: string): void {
    this.settling.get(turnId)?.cancel();
    this.settling.delete(turnId);
  }

  /** The real time `speechEnd` arrived, kept for the few turns still open. */
  private noteSpeechEnd(turnId: string): void {
    if (this.heard.has(turnId)) return;
    this.heard.set(turnId, this.wall.now());
    // A turn whose final never came must not keep the map growing.
    for (const old of [...this.heard.keys()].slice(0, this.heard.size - 8)) {
      this.heard.delete(old);
    }
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
    if (!named && !followsName) {
      this.abandon(turn.turnId);
      return;
    }
    if (turn.speaker !== null) this.disarm(turn.speaker);
    // Keep the name-only turn even when several other people spoke between the two halves.
    if (followsName && !previous.some((item) => item.turnId === arm.turn.turnId)) {
      previous = [arm.turn, ...previous.slice(-3)];
    }
    this.listeningTurns.add(turn.turnId);
    this.publishListening();
    const started = this.wall.now();
    let result = await this.decide(turn, previous, started);
    this.listeningTurns.delete(turn.turnId);
    if (this.stopped || this.ignored.has(turn.turnId)) return;
    let fallback = false;
    if (result === null) {
      fallback = true;
      const match = detect(turn.text);
      result = { kind: match.triggered ? "request" : "mention", question: match.question ?? "" };
      this.options.onTiming({
        stage: "address_fallback", atMs: this.options.clock.now(), turnId: turn.turnId,
      });
    }
    this.options.onTiming({
      stage: "address", atMs: this.options.clock.now(), turnId: turn.turnId,
      kind: result.kind, latencyMs: this.wall.now() - started, fallback,
    });
    if (result.kind === "name_only" && turn.speaker !== null) {
      this.arm(turn, turn.speaker, arrivedAt);
    }
    this.publishListening();
    if (result.kind === "request") {
      const heardAtMs = this.heard.get(turn.turnId);
      this.heard.delete(turn.turnId);
      this.options.onQuestion({
        turnId: turn.turnId, speaker: turn.speaker, question: result.question,
        ...(heardAtMs === undefined ? {} : { heardAtMs }),
      });
    }
  }

  /**
   * One final turn's intent: the early answer when it still fits, else a check
   * of its own. `null` is "no usable answer", which takes the old detector.
   */
  private async decide(
    turn: TurnUpdate,
    previous: readonly TurnUpdate[],
    startedAtMs: number,
  ): Promise<AddressResult | null> {
    const early = this.early.get(turn.turnId);
    this.early.delete(turn.turnId);
    if (early !== undefined) {
      const extra = extraWords(early.text, turn.text);
      if (extra === null) {
        // Not an extension at all: the transcription changed its mind about
        // words it had already sent, so the check read a different sentence.
        early.controller.abort();
        this.recheck(turn, extra, "changed");
      } else {
        const result = await early.result;
        if (this.stopped || this.ignored.has(turn.turnId)) return null;
        const why = stale(result, extra);
        if (why === null && result !== null) {
          const reused = extra === 0
            ? result
            : { ...result, ...requestedAgain(result, turn.text) };
          this.options.onTiming({
            stage: "address_early", event: "reused", atMs: this.options.clock.now(),
            turnId: turn.turnId, kind: reused.kind, extraWords: extra,
            earlyMs: this.wall.now() - early.startedAtMs,
            waitedMs: this.wall.now() - startedAtMs,
          });
          return reused;
        }
        this.recheck(turn, extra, why ?? "failed");
      }
    }
    const controller = new AbortController();
    this.active = controller;
    try {
      return await this.run(turn, previous, controller);
    } finally {
      this.active = undefined;
    }
  }

  private recheck(turn: TurnUpdate, extra: number | null, reason: string): void {
    this.options.onTiming({
      stage: "address_early", event: "rechecked", atMs: this.options.clock.now(),
      turnId: turn.turnId, reason, ...(extra === null ? {} : { extraWords: extra }),
    });
  }

  /** One classification, bounded by real time. Never rejects. */
  private async run(
    turn: TurnUpdate,
    previous: readonly TurnUpdate[],
    controller: AbortController,
  ): Promise<AddressResult | null> {
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("address cancelled or timed out")),
        { once: true });
    });
    const cancelTimeout = this.wall.setTimeout(() => controller.abort(), ADDRESS_TIMEOUT_MS);
    try {
      return AddressSchema.parse(await Promise.race([
        this.options.classify({ turn, previous, speakers: this.options.speakers() }, controller.signal),
        cancelled,
      ]));
    } catch {
      return null;
    } finally {
      cancelTimeout();
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

/**
 * How many words `final` adds to `checked`, or `null` when it is not an
 * extension of it at all.
 *
 * Words only: the final turn routinely puts back the punctuation and the
 * capitals a partial never had (`" Sotto what do the main competitors charge
 * per month. "`), and none of that is a change of mind.
 */
function extraWords(checked: string, final: string): number | null {
  const before = wordsOf(checked);
  const after = wordsOf(final);
  if (after.length < before.length) return null;
  return before.every((word, index) => after[index] === word) ? after.length - before.length : null;
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Why an early answer no longer stands for a final turn that said `extra`
 * more words, or `null` when it does.
 */
function stale(result: AddressResult | null, extra: number): string | null {
  if (result === null) return "failed";
  if (extra === 0) return null;
  // The request is in the words the early check never read.
  if (result.kind === "name_only") return "name_only";
  if (result.kind === "mention" && extra > ADDRESS_EXTENSION_WORDS) return "extended";
  return null;
}

/**
 * The question for a request whose final turn said more than the early check
 * read, taken from the final text so the last words are not lost. The early
 * wording stands when there is no name to read it off.
 */
function requestedAgain(result: AddressResult, text: string): Partial<AddressResult> {
  if (result.kind !== "request") return {};
  const question = questionAfterName(text);
  return question === "" ? {} : { question };
}
