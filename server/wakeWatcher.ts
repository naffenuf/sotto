/**
 * The stateful half of wake-phrase detection (PRD US-017): watching the turns
 * go by and deciding when Sotto has been addressed.
 *
 * {@link detect} reads one string; this reads the stream. A turn arrives many
 * times — once per partial, once more as `final` — and the two halves of a
 * trigger land at different moments:
 *
 * - The **partial** that first matches turns on the "Sotto is listening…"
 *   indicator and tells the policy somebody is talking to Sotto, so that it
 *   holds its own interjections for the courtesy window (US-014). That is the
 *   whole point of acting on a partial: the question is still being asked.
 * - The **final** turn carries the question, because only then is the text
 *   the speaker's last word on it.
 *
 * A turn triggers at most once, and a partial that matched and then stopped
 * matching — the speaker said "Sotto vo…" and went on to "voce" — takes the
 * indicator back down.
 */
import { isSottoTurn, type TurnUpdate } from "../shared/turns.js";
import { detect, type WakeOptions } from "./wake.js";

/** A question somebody asked Sotto out loud. */
export interface WakeTrigger {
  /** The turn it was asked in. */
  turnId: string;
  /** The diarization label of whoever asked, if the turn has one. */
  speaker: string | null;
  /** Everything after the wake word. */
  question: string;
}

export interface WakeWatcherOptions extends WakeOptions {
  /**
   * Called whenever the indicator should go up or down. Only ever called on
   * a change, so a listener can push it straight to the bus.
   */
  onListening: (listening: boolean) => void;
  /** Called once per turn that finishes as a question for Sotto. */
  onQuestion: (trigger: WakeTrigger) => void;
}

export class WakeWatcher {
  private readonly options: WakeWatcherOptions;
  /** Just the spellings, so `exactOptionalPropertyTypes` stays happy. */
  private readonly wake: WakeOptions;
  /** Turns that have already produced a question; they cannot produce another. */
  private readonly answered = new Set<string>();
  /** The turn the indicator is up for, or `null` when it is down. */
  private listeningFor: string | null = null;

  constructor(options: WakeWatcherOptions) {
    this.options = options;
    this.wake = options.spellings === undefined ? {} : { spellings: options.spellings };
  }

  /** Whether the "Sotto is listening…" indicator is up. */
  get listening(): boolean {
    return this.listeningFor !== null;
  }

  /** A turn held by playback must also clear any earlier partial wake (V2-006). */
  ignoreTurn(turnId: string): void {
    this.setListening(null, turnId);
  }

  /**
   * Reads one snapshot of a turn, partial or final, and emits whatever it
   * implies. Safe to call with every update the assembler produces.
   */
  acceptTurn(turn: TurnUpdate): void {
    // Sotto's own line is in the transcript (V2-008a), never in its ears.
    if (isSottoTurn(turn) || this.answered.has(turn.turnId)) return;
    const match = detect(turn.text, this.wake);

    if (!turn.final) {
      this.setListening(match.triggered ? turn.turnId : null, turn.turnId);
      return;
    }

    // The turn is over either way, so the indicator comes down: what happens
    // next is the answer (US-018), which has a card of its own.
    this.setListening(null, turn.turnId);
    if (!match.triggered || match.question === null) return;
    this.answered.add(turn.turnId);
    this.options.onQuestion({
      turnId: turn.turnId,
      speaker: turn.speaker,
      question: match.question,
    });
  }

  /**
   * Puts the indicator up for `turnId`, or takes it down.
   *
   * `about` is the turn being read: a turn that never triggered must not pull
   * the indicator down for the one that did, which is what happens whenever
   * two people talk over each other.
   */
  private setListening(turnId: string | null, about: string): void {
    if (turnId === null && this.listeningFor !== about) return;
    if (turnId === this.listeningFor) return;
    this.listeningFor = turnId;
    this.options.onListening(turnId !== null);
  }
}
