/**
 * "Sotto, wrap us up" (V2-018).
 *
 *     wake/address watcher -> asksForWrapUp -> SessionDigest.spokenSummary()
 *                                           -> VoiceOut -> a Sotto line in the transcript
 *                                           \-> notice card (muted, or nowhere to play it)
 *
 * The one answer Sotto can give immediately. Everything a wrap-up says is
 * already in hand — the board's decisions and open questions, the research the
 * session produced — so it is written locally ({@link spokenSummary}) rather
 * than by a model, exactly as a briefing's opening line is (V2-015). A group
 * asks for this while they are standing up; a fifteen-second search would be
 * the only thing left to wait for.
 *
 * It follows {@link Greeting}'s two rules for a line of Sotto's that no model
 * wrote. **Spoken or shown, never both**: a voice that resolves `null` —
 * muted, or no page attached — is the screen-only case, and a notice card
 * carries the same words. And **what the room heard is what is written down**:
 * the transcript gets Sotto's own text, or only `spokenSoFar` when somebody
 * cut it off, which they can, because this is an ordinary utterance on the
 * same hub a barge-in cancels (V2-007).
 */
import { NOTICE_CARD_IDS, type StageCard } from "../../shared/cards.js";
import { sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import type { Clock } from "../clock.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "../voice/voiceOut.js";
import type { DigestSpoken } from "./digest.js";

type Logger = Pick<Console, "log" | "warn">;

/** The label a wrap-up is tracked under on the clock, and in `timing.jsonl`. */
export const WRAP_UP_TRACK_LABEL = "wrap_up";

/** What the digest calls whoever asked when diarization had not labelled them. */
export const UNKNOWN_ASKER = "someone";

/** The headline a shown wrap-up carries, above the summary itself. */
export const WRAP_UP_HEADLINE = "Where we got to";

export interface WrapUpOptions {
  /** The session clock, so a `max`-speed replay waits for the speech. */
  clock: Clock;
  /** Where Sotto's voice goes, or `null` for a session that only shows things. */
  voice: VoiceOut | null;
  /** Now, on the transcription stream's timeline (V2-008a). */
  streamNow: () => number;
  /** The summary itself, read when it is asked for and not before. */
  summary: () => string;
  /** Puts a card on the stage. */
  onCard: (card: StageCard) => void;
  /** Writes Sotto's own line into the conversation (V2-008a). */
  onSpoken: (turn: TurnUpdate) => void;
  /** Records it as something Sotto said, for the digest's own account of it. */
  onSaid?: (said: DigestSpoken) => void;
  onTiming?: (record: Record<string, unknown>) => void;
  logger?: Logger;
}

/** One request, as the watcher that heard it describes it. */
export interface WrapUpRequest {
  /** The request in the asker's words, without the name. */
  question: string;
  /** Whoever asked, by display name or diarization label; `null` if unknown. */
  askedBy: string | null;
  /** The turn it was asked in, for the timing log. */
  turnId: string | null;
}

export class WrapUp {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private utterance: VoiceUtterance | undefined;
  private stopped = false;
  /** How many have been asked for, so each card has an id of its own. */
  private asked = 0;
  /** The one being said, so a drain and a second request can wait for it. */
  private saying: Promise<void> = Promise.resolve();

  constructor(private readonly options: WrapUpOptions) {
    this.clock = options.clock;
    this.logger = options.logger ?? console;
  }

  /**
   * Wraps the conversation up out loud, and returns at once: the sound, and
   * the transcript line that records it, follow.
   */
  ask(request: WrapUpRequest): void {
    if (this.stopped) return;
    this.asked += 1;
    const text = this.options.summary();
    this.logger.log(
      `[wrapup] ${request.askedBy ?? UNKNOWN_ASKER} asked to wrap up: ${request.question}`,
    );
    this.options.onTiming?.({
      stage: "wrap_up", atMs: this.clock.now(), turnId: request.turnId,
      characters: text.length,
    });
    // Asked for twice is the second one answered: whatever was being said is
    // already out of date, and `begin()` would stop it anyway.
    const previous = this.saying;
    this.saying = previous.then(() => this.say(request, text));
    void this.clock.track(WRAP_UP_TRACK_LABEL, this.saying);
    this.utterance?.cancel();
  }

  /** Resolves once the wrap-up being said has been said and written down. */
  async flush(): Promise<void> {
    await this.saying;
  }

  /** The end of the session: stop talking. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.utterance?.cancel();
  }

  /** Says it out loud, or shows it, and records what the room heard. */
  private async say(request: WrapUpRequest, text: string): Promise<void> {
    let utterance: VoiceUtterance | null = null;
    try {
      utterance = (await this.options.voice?.begin()) ?? null;
    } catch (error) {
      // A voice that was there and broke: the summary still has to arrive.
      this.logger.warn(`[wrapup] could not be said out loud: ${message(error)}`);
    }
    if (utterance === null) {
      this.show(text);
      this.said(request, text, false);
      this.options.onTiming?.({ stage: "wrap_up_shown", atMs: this.clock.now() });
      return;
    }
    if (this.stopped) {
      utterance.cancel();
      return;
    }
    this.utterance = utterance;
    // Playback starts within ElevenLabs' first chunk of the text going over
    // (measured at 299 ms), so this is where the line belongs on the stream.
    const startMs = this.options.streamNow();
    utterance.append(text);
    this.options.onTiming?.({
      stage: "wrap_up_spoken", atMs: this.clock.now(),
      utteranceId: utterance.id, startMs, characters: text.length,
    });
    let spoken: VoiceSpoken | undefined;
    try {
      spoken = await utterance.finish();
    } catch (error) {
      this.logger.warn(`[wrapup] was cut short: ${message(error)}`);
    }
    if (this.utterance === utterance) this.utterance = undefined;
    if (spoken === undefined) return;
    const interrupted = spoken.reason === "cancelled";
    const said = interrupted ? spoken.spokenSoFar : spoken.text;
    // Cut off before the page reported anything: nobody can say what was
    // heard, so the transcript stays short rather than claiming a line.
    if (said.trim() === "") return;
    this.said(request, said, interrupted);
    this.options.onSpoken(
      sottoTurn({ utteranceId: utterance.id, text: said, startMs, interrupted }),
    );
  }

  private said(request: WrapUpRequest, text: string, interrupted: boolean): void {
    this.options.onSaid?.({
      question: request.question,
      askedBy: request.askedBy ?? UNKNOWN_ASKER,
      headline: WRAP_UP_HEADLINE,
      spoken: text,
      interrupted,
      packetIds: [],
    });
  }

  /** The screen-only case: one plain card with the summary under it. */
  private show(text: string): void {
    const card: StageCard = {
      id: `${NOTICE_CARD_IDS.wrapUp}-${this.asked}`,
      variant: "notice",
      state: "ready",
      createdAtMs: this.clock.now(),
      headline: WRAP_UP_HEADLINE,
      detailMd: text,
    };
    this.logger.log(`[wrapup] shown on the stage as ${card.id}`);
    this.options.onCard(card);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
