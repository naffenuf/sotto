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
 *
 * V3-017's `call_on` joins those three. It is routed to {@link
 * AddressWatcherOptions.onCallOn} rather than to the answer agent — there is
 * no question to answer, only a card to read out — and a bare name read as
 * one still arms the speaker, because the transcription cannot tell "Sotto?"
 * from "Sotto" and the request this was the opening of may be two seconds
 * away.
 */
import type { SpeakerNames } from "../../shared/events.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { systemClock, type Clock } from "../clock.js";
import { DEFAULT_WAKE_SPELLINGS, detect, detectsAddress, questionAfterName } from "../wake.js";
import type { WakeTrigger } from "../wakeWatcher.js";
import { AddressSchema, type AddressClassifier } from "./address.js";

/** A pause after saying the name may split one request into two ASR turns. */
export const ADDRESS_ARM_MS = 8_000;
/** A slow classifier must not leave the room indefinitely waiting. */
export const ADDRESS_TIMEOUT_MS = 6_000;

/**
 * What the room says to hear what Sotto is holding (V3-017), read off the
 * words after the name: "Sotto, go ahead", "go on, Sotto". "What have you got" is left to the
 * classifier: it is the start of many questions. Only consulted while something *is* raised; "go ahead" with the
 * hand down is whatever the classifier says it is.
 */
export const CALL_ON_PHRASE = /^(?:(?:ok(?:ay)?|yes|yeah|sure|right)[,.]?\s+)?(?:go ahead|go on|go for it)[\s.?!]*$/i;

/**
 * The turn with Sotto's name taken out of it, for {@link CALL_ON_PHRASE}:
 * "Go ahead, Sotto." and "Sotto, go ahead" are the same invitation, and
 * `questionAfterName` reads the first as empty.
 */
export function withoutName(text: string): string {
  return text
    .replace(/[\p{L}\p{N}']+/gu, (word) => (DEFAULT_WAKE_SPELLINGS.includes(word.toLowerCase()) ? "" : word))
    .replace(/\s+([,.:;!?])/gu, "$1")
    .replace(/^[\s,.:;!?-]+|[\s,.:;!?-]+$/gu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

/** Whether this turn is the room calling on the hand, read off the words. */
export function isCallOnPhrase(text: string): boolean {
  return CALL_ON_PHRASE.test(withoutName(text));
}
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

/**
 * How long a named turn's words may hold still, with no final, before the
 * watcher treats it as final itself.
 *
 * The transcription API does not always close a turn: after a short line
 * followed by quiet ("Sotto, go ahead", "Um, so, go ahead" in
 * `sessions/2026-11-03_2109-mic`, 55 s) it has been seen to wait for the
 * *next* speech and merge the two, so the call-on sat unanswered until
 * somebody said something else. The pause side already counts silence from
 * the last word; this is the same rule for intent. 2.5 s is well past the
 * ~0.65 s the endpointer normally takes and past the p90 gap between
 * mid-speech partials (641 ms), so a turn still open and unchanged this long
 * is one the API is not going to close on its own.
 */
export const ADDRESS_STALL_FINAL_MS = 2_500;

/** What one classification came to, once it has been through the schema. */
type AddressResult = {
  kind: "request" | "name_only" | "mention" | "call_on";
  question: string;
};

/** Effects are shared with the old wake watcher; only the intent decision changes. */
export interface AddressWatcherOptions {
  clock: Clock;
  wallClock?: Clock;
  classify: AddressClassifier;
  speakers: () => SpeakerNames;
  onListening: (listening: boolean) => void;
  onQuestion: (trigger: WakeTrigger) => void;
  onTiming: (record: Record<string, unknown>) => void;
  /**
   * How many cards Sotto is holding and has not said (V3-017). The
   * classifier is told, because it is what separates a bare name said as an
   * invitation to speak from one said on the way to a question.
   */
  raised?: () => number;
  /**
   * The room called on Sotto to say what it is holding (V3-017). Absent on a
   * session that has nothing to say it with, in which case the verdict is
   * simply logged.
   */
  onCallOn?: (trigger: WakeTrigger) => void;
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
  /** Stall timers for named partials, by turn: fires {@link finalizeStalled}. */
  private readonly stalling = new Map<string, Settling>();
  /** Turns this watcher finalized itself, with the text it acted on. */
  private readonly selfFinal = new Map<string, string>();
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
    if (this.stopped || this.ignored.has(turn.turnId)) return;
    // The API's final for a turn this watcher already finalized on a stall:
    // the same words are done with, and words it appended afterwards — the
    // next thing the room said, merged in — are read as a turn of their own.
    const acted = this.selfFinal.get(turn.turnId);
    if (acted !== undefined && turn.final) {
      this.selfFinal.delete(turn.turnId);
      const text = turn.text.trim();
      const remainder = text.startsWith(acted) ? text.slice(acted.length).trim() : text === acted ? "" : text;
      if (remainder === "") return;
      this.acceptTurn({ ...turn, turnId: `${turn.turnId}+`, text: remainder });
      return;
    }
    if (this.seen.has(turn.turnId)) return;
    const named = detectsAddress(turn.text);
    if (named) this.listeningTurns.add(turn.turnId);
    else this.listeningTurns.delete(turn.turnId);
    this.publishListening();
    if (!turn.final) {
      // A closed partial is `speechEnd`: the room has stopped talking, which
      // is where the acknowledgment latency is measured from.
      if (turn.endMs !== null) this.noteSpeechEnd(turn.turnId);
      if (named) {
        this.watchPartial(turn);
        this.watchStall(turn);
      } else {
        this.unwatch(turn.turnId);
      }
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
    for (const turnId of [...this.settling.keys(), ...this.stalling.keys(), ...this.early.keys()]) {
      this.abandon(turnId);
    }
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
    // "Sotto, go ahead" with something raised is read off the words at the
    // final; an early check would be a model call for nothing.
    if ((this.options.raised?.() ?? 0) > 0 && isCallOnPhrase(text)) return;
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

  /** The room called on the hand by another route (a `continue` over a card being read). */
  callOn(turnId: string | null): void {
    if (this.stopped) return;
    this.options.onCallOn?.({ turnId: turnId ?? "", speaker: null, question: "" });
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
    this.stalling.get(turnId)?.cancel();
    this.stalling.delete(turnId);
  }

  /**
   * Arms the stall timer for a named partial, reset by every change of text:
   * when it fires the turn is treated as final ({@link ADDRESS_STALL_FINAL_MS}).
   */
  private watchStall(turn: TurnUpdate): void {
    const text = turn.text.trim();
    if (text === "") return;
    const stalling = this.stalling.get(turn.turnId);
    if (stalling?.text === text) return;
    stalling?.cancel();
    const cancel = this.options.clock.setTimeout(() => {
      this.stalling.delete(turn.turnId);
      this.finalizeStalled(turn);
    }, ADDRESS_STALL_FINAL_MS);
    this.stalling.set(turn.turnId, { text, cancel });
  }

  /** The API has not closed this turn and its words have stopped: act on them now. */
  private finalizeStalled(turn: TurnUpdate): void {
    if (this.stopped || this.seen.has(turn.turnId) || this.ignored.has(turn.turnId)) return;
    const text = turn.text.trim();
    this.options.onTiming({
      stage: "address_stall_final", atMs: this.options.clock.now(), turnId: turn.turnId,
      characters: text.length,
    });
    this.acceptTurn({ ...turn, final: true, endMs: turn.endMs ?? turn.lastWordsMs ?? turn.startMs });
    // Remembered *after* the dispatch, so the final just handed over is not
    // itself read as the API's late one.
    this.selfFinal.set(turn.turnId, text);
  }

  /** Verdicts still on their way after the deadline handed a turn to the fallback. */
  private readonly lateVerdicts = new Map<string, Promise<AddressResult>>();

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
    // V3-017: "Sotto, go ahead" while something is raised needs no model —
    // the phrase is fixed and the five seconds a classification can take
    // (measured 5.5 s on `2026-11-03_0945-mic`) is long enough for the room
    // to say it again, which then arrives as a barge-in on the card.
    let result: AddressResult | null =
      (this.options.raised?.() ?? 0) > 0 && isCallOnPhrase(turn.text)
        ? { kind: "call_on", question: "" }
        : null;
    const lexical = result !== null;
    if (lexical) {
      this.abandon(turn.turnId);
      this.options.onTiming({
        stage: "address_lexical", atMs: this.options.clock.now(), turnId: turn.turnId, kind: "call_on",
      });
    }
    result ??= await this.decide(turn, previous, started);
    this.listeningTurns.delete(turn.turnId);
    if (this.stopped || this.ignored.has(turn.turnId)) return;
    let fallback = false;
    if (result === null) {
      fallback = true;
      // Looser than the wake watcher's rule: a yes/no question of Sotto with
      // the comma lost ("Sotto did you look up…") is still a request here.
      const match = detect(turn.text, { looseQuestions: true });
      result = { kind: match.triggered ? "request" : "mention", question: match.question ?? "" };
      this.options.onTiming({
        stage: "address_fallback", atMs: this.options.clock.now(), turnId: turn.turnId,
      });
      this.keepLateVerdict(turn, result, started);
    } else {
      this.lateVerdicts.delete(turn.turnId);
    }
    this.options.onTiming({
      stage: "address", atMs: this.options.clock.now(), turnId: turn.turnId,
      kind: result.kind, latencyMs: this.wall.now() - started, fallback, ...(lexical ? { lexical } : {}),
    });
    // A bare name read as a call on Sotto (V3-017) arms the speaker too: the
    // transcription cannot tell "Sotto?" from "Sotto" and the next few
    // seconds may still carry the request this was the start of.
    if (
      turn.speaker !== null &&
      (result.kind === "name_only" ||
        (result.kind === "call_on" && questionAfterName(turn.text) === ""))
    ) {
      this.arm(turn, turn.speaker, arrivedAt);
    }
    this.publishListening();
    if (result.kind === "call_on") {
      const heardAtMs = this.heard.get(turn.turnId);
      this.heard.delete(turn.turnId);
      this.options.onCallOn?.({
        turnId: turn.turnId, speaker: turn.speaker, question: "",
        ...(heardAtMs === undefined ? {} : { heardAtMs }),
      });
      return;
    }
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

  /**
   * One classification, bounded by real time. Never rejects.
   *
   * The deadline does not cancel the call: it hands the turn to the lexical
   * fallback *now* and keeps the model's verdict for when it comes. A slow
   * API answered "request" at second eight on `2026-11-03_0915-mic`, after
   * the word rule had already read the turn as a mention, and the verdict was
   * thrown away — the room asked and nothing happened. {@link lateVerdicts}
   * holds it for {@link classify} to pick up.
   */
  private async run(
    turn: TurnUpdate,
    previous: readonly TurnUpdate[],
    controller: AbortController,
  ): Promise<AddressResult | null> {
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("address cancelled")),
        { once: true });
    });
    let cancelTimeout = (): void => {};
    const timedOut = new Promise<null>((resolve) => {
      cancelTimeout = this.wall.setTimeout(() => resolve(null), ADDRESS_TIMEOUT_MS);
    });
    const verdict = this.options
      .classify(
        {
          turn,
          previous,
          speakers: this.options.speakers(),
          raised: this.options.raised?.() ?? 0,
        },
        controller.signal,
      )
      .then((value) => AddressSchema.parse(value));
    try {
      const result = await Promise.race([verdict, cancelled, timedOut]);
      if (result === null) this.lateVerdicts.set(turn.turnId, verdict);
      return result;
    } catch {
      return null;
    } finally {
      cancelTimeout();
    }
  }

  /**
   * Acts on a verdict that arrived after the deadline (see {@link run}): a
   * request the fallback did not see becomes the question it was. Anything
   * else — the fallback already asked it, the model agrees it was a mention,
   * the call failed — changes nothing.
   */
  private keepLateVerdict(turn: TurnUpdate, fallback: AddressResult, startedAtMs: number): void {
    const verdict = this.lateVerdicts.get(turn.turnId);
    this.lateVerdicts.delete(turn.turnId);
    if (verdict === undefined || fallback.kind === "request") return;
    const late = verdict.then(
      (result) => {
        if (this.stopped || this.ignored.has(turn.turnId)) return;
        if (result.kind !== "request") return;
        this.options.onTiming({
          stage: "address_late", atMs: this.options.clock.now(), turnId: turn.turnId,
          kind: result.kind, latencyMs: this.wall.now() - startedAtMs,
        });
        const heardAtMs = this.heard.get(turn.turnId);
        this.heard.delete(turn.turnId);
        this.options.onQuestion({
          turnId: turn.turnId, speaker: turn.speaker, question: result.question,
          ...(heardAtMs === undefined ? {} : { heardAtMs }),
        });
      },
      () => {},
    );
    void this.options.clock.track("address", late);
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
  // V3-017: a `call_on` is an invitation with no subject, so words the early
  // check never read may well have turned it into a request.
  if (
    (result.kind === "mention" || result.kind === "call_on") &&
    extra > ADDRESS_EXTENSION_WORDS
  ) {
    return "extended";
  }
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
