/**
 * One answer, said out loud while it is still being written (V2-005).
 *
 *     chooseAcknowledgment -> "Let me check."  ---\
 *     model stream -> splitSpokenAnswer -> sentences --> VoiceOut
 *
 * Two utterances, in that order. The acknowledgment is its own, because it has
 * to be said before a word of the answer exists; the answer is its own,
 * because opening it is what cuts the acknowledgment off — which is exactly
 * the PRD's "unless the answer's first sentence is ready first". Nothing here
 * decides *what* to say: it takes pieces of text in the order they were
 * written and keeps the voice one step behind the model.
 *
 * Everything runs through one promise chain. Opening an utterance is
 * asynchronous (a socket to ElevenLabs) while the model's text arrives
 * synchronously, so without a chain the second sentence could reach the voice
 * before the first one's socket had opened. Nothing is ever awaited by the
 * caller except {@link SpokenAnswer.done}.
 *
 * V2-008c put a third piece of text in the same two utterances: a **holding
 * line** written while the searched answer is still being searched for. It
 * goes into the *answer's* utterance, not a third one, so a barge-in cancels
 * one thing and `spokenSoFar` reads back across both halves — and so opening
 * it is still what cuts the acknowledgment off. {@link SpokenAnswer.sayFirstLine}
 * is therefore {@link SpokenAnswer.say} with one extra rule: it loses the race
 * if the answer has already started.
 *
 * The timings are read off a **real** clock, not the session's: `ackMs` and
 * `firstAudioMs` are latencies a person in the room felt, and a `max`-speed
 * replay's session clock does not move while a model call is in flight.
 */
import type { Clock } from "../clock.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "../voice/voiceOut.js";

type Logger = Pick<Console, "log" | "warn">;

export interface SpokenAnswerOptions {
  voice: VoiceOut;
  /** Real time. The latencies here are the ones the room felt. */
  wallClock: Clock;
  /** When the question arrived, on {@link wallClock}. */
  askedAtMs: number;
  logger?: Logger;
}

/** What one spoken answer came to. */
export interface SpokenResult {
  /** Whether anything was said out loud at all. */
  spoke: boolean;
  /** The question arriving to the acknowledgment's first audio, in real ms. */
  ackMs: number | null;
  /** The question arriving to the answer's own first audio, in real ms. */
  firstAudioMs: number | null;
  /**
   * The question arriving to the holding line's first audio, in real ms, or
   * `null` when none was said (V2-008c). Set to the same moment as
   * {@link firstAudioMs}, which the holding line is the start of.
   */
  firstLineMs: number | null;
  /**
   * The question arriving to the first audio of whatever followed the holding
   * line, in real ms — the whole answer when there was no holding line, and
   * `null` when nothing was said.
   */
  continuationMs: number | null;
  /** What the room heard before it was cut off; empty unless it was. */
  spokenSoFar: string;
  /** Whether speech stopped before the end of the words it was given. */
  interrupted: boolean;
}

/** One utterance and the moment it was asked for. */
interface Open {
  utterance: VoiceUtterance;
  beganAtMs: number;
}

export class SpokenAnswer {
  private readonly options: SpokenAnswerOptions;
  private readonly logger: Logger;

  /** Serializes opening, appending and finishing; see the header. */
  private chain: Promise<void> = Promise.resolve();
  private ack: Open | undefined;
  private answer: Open | undefined;
  private result: VoiceSpoken | undefined;
  /** Text written but not yet handed over, because nothing is open yet. */
  private queued = "";
  /** Text already handed over, so a re-parse can never say it twice. */
  private given = "";
  /** True once the answer's own utterance has been asked for. */
  private opened = false;
  /** V2-008c: the holding line, once it has been taken. */
  private firstLine = "";
  /**
   * Set the instant {@link say} is called, before the chain has run a step.
   * A holding line arriving in the same tick as the answer's own first
   * sentence has to lose, and `opened` is only true once the step runs.
   */
  private answering = false;
  /** Where the continuation went over: real time, and audio already queued. */
  private continuation: { atMs: number; audioMs: number | null } | undefined;
  /** True once the voice said there was nowhere to be heard, or failed. */
  private silent = false;
  private stopped = false;

  constructor(options: SpokenAnswerOptions) {
    this.options = options;
    this.logger = options.logger ?? console;
  }

  /**
   * Says the acknowledgment, if the answer has not already started. Returns
   * at once; the sound follows.
   */
  acknowledge(phrase: string): void {
    this.step(async () => {
      if (this.stopped || this.silent || this.opened) return;
      const beganAtMs = this.options.wallClock.now();
      const utterance = await this.open();
      if (utterance === null) return;
      this.ack = { utterance, beganAtMs };
      utterance.append(phrase);
      // Not awaited: the acknowledgment is a whole utterance on its own, and
      // the answer must not wait for it to finish being spoken. A failure
      // here is a second of silence, not a lost answer.
      void utterance.finish().catch(() => {});
    });
  }

  /**
   * The next piece of the answer. The first call opens the answer's utterance,
   * which stops the acknowledgment mid-word if it is still going.
   */
  say(text: string): void {
    const piece = text.trim();
    if (piece === "" || this.stopped) return;
    // The first sentence of the searched answer, after a holding line, is the
    // continuation the log measures.
    const continues = !this.answering && this.firstLine !== "";
    this.answering = true;
    this.enqueue(piece, continues);
  }

  /**
   * The holding line, said while the searched answer is still being written
   * (V2-008c). Returns whether it was taken: it is dropped if the answer has
   * already started saying itself, if speech has been cancelled, or if nothing
   * would be heard at all.
   */
  sayFirstLine(text: string): boolean {
    const line = text.trim();
    if (line === "") return false;
    if (this.stopped || this.silent || this.answering || this.firstLine !== "") return false;
    this.firstLine = line;
    this.enqueue(line, false);
    return true;
  }

  /** Queues text, opening the answer's utterance if it is not open yet. */
  private enqueue(text: string, continues: boolean): void {
    this.queued = this.queued === "" ? text : `${this.queued} ${text}`;
    this.step(async () => {
      if (this.stopped || this.silent) return;
      if (this.answer === undefined) {
        this.opened = true;
        const beganAtMs = this.options.wallClock.now();
        const utterance = await this.open();
        if (utterance === null) return;
        this.answer = { utterance, beganAtMs };
      }
      // Measured where the text really goes over, not where it was written.
      if (continues && this.continuation === undefined) {
        this.continuation = {
          atMs: this.options.wallClock.now(),
          audioMs: this.answer.utterance.audioMs?.() ?? null,
        };
      }
      this.drain(this.answer.utterance);
    });
  }

  /** What has been handed to the voice so far — everything {@link say} took. */
  saidSoFar(): string {
    return this.given;
  }

  /** No more text. Resolves once the voice has finished with what it has. */
  async done(): Promise<SpokenResult> {
    this.step(async () => {
      const open = this.answer;
      if (open === undefined) return;
      this.drain(open.utterance);
      try {
        this.result = await open.utterance.finish();
      } catch (error) {
        this.logger.warn(`[voice] the answer was cut short: ${message(error)}`);
      }
    });
    await this.chain;
    return this.report();
  }

  /** Stops speaking now — the Stop button, muting, the end of a session. */
  cancel(): void {
    this.stopped = true;
    this.queued = "";
    this.ack?.utterance.cancel();
    this.answer?.utterance.cancel();
  }

  /** The latencies and what was heard, as they now stand. */
  private report(): SpokenResult {
    return {
      spoke: this.answer !== undefined,
      ackMs: this.latency(this.ack),
      firstAudioMs: this.latency(this.answer),
      firstLineMs: this.firstLine === "" ? null : this.latency(this.answer),
      continuationMs: this.continuationLatency(),
      spokenSoFar: this.result?.reason === "cancelled" ? this.result.spokenSoFar : "",
      interrupted: this.stopped || this.result?.reason === "cancelled",
    };
  }

  /** The question arriving to one utterance's first audio, in real ms. */
  private latency(open: Open | undefined): number | null {
    if (open === undefined) return null;
    const toFirstAudio = open.utterance.firstAudioMs();
    if (toFirstAudio === null) return null;
    return Math.max(0, open.beganAtMs - this.options.askedAtMs) + toFirstAudio;
  }

  /**
   * When the searched half of the answer became audible (V2-008c).
   *
   * With no holding line it is the utterance's own first audio. With one, the
   * two are in one utterance and heard in order, so the continuation starts
   * where the holding line's speech ends — the audio synthesized before it
   * went over — and in any case not before the moment it went over.
   */
  private continuationLatency(): number | null {
    const open = this.answer;
    if (open === undefined) return null;
    const start = this.latency(open);
    if (this.firstLine === "") return start;
    const handed = this.continuation;
    if (handed === undefined) return null;
    const wentOver = Math.max(0, handed.atMs - this.options.askedAtMs);
    if (start === null || handed.audioMs === null) return Math.round(wentOver);
    return Math.round(Math.max(wentOver, start + handed.audioMs));
  }

  /** Hands over everything written since the last time. */
  private drain(utterance: VoiceUtterance): void {
    const text = this.queued;
    this.queued = "";
    if (text === "") return;
    this.given = this.given === "" ? text : `${this.given} ${text}`;
    utterance.append(text);
  }

  /** Opens an utterance, or gives up on speech for this answer. */
  private async open(): Promise<VoiceUtterance | null> {
    try {
      const utterance = await this.options.voice.begin();
      // A barge-in can arrive while the socket is opening, before we own its handle.
      if (this.stopped && utterance !== null) {
        utterance.cancel();
        return null;
      }
      // Muted, or no page attached: the answer is a screen answer, which is
      // the core build's behaviour and not an error.
      if (utterance === null) this.silent = true;
      return utterance;
    } catch (error) {
      this.silent = true;
      this.logger.warn(`[voice] could not speak this answer: ${message(error)}`);
      return null;
    }
  }

  /** Adds one step to the chain. A step that throws never breaks the chain. */
  private step(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((error: unknown) => {
      this.logger.warn(`[voice] ${message(error)}`);
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
