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
    this.queued = this.queued === "" ? piece : `${this.queued} ${piece}`;
    this.step(async () => {
      if (this.stopped || this.silent) return;
      if (this.answer === undefined) {
        this.opened = true;
        const beganAtMs = this.options.wallClock.now();
        const utterance = await this.open();
        if (utterance === null) return;
        this.answer = { utterance, beganAtMs };
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
