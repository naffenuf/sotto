/**
 * Saying hello, and asking who is here (V2-009).
 *
 *     session start -> hello.md -> VoiceOut ---------> a Sotto line in the transcript
 *                              \-> notice card (muted, or nowhere to play it)
 *
 *     2 minutes later, if a label is still unnamed -> next pause -> one notice card
 *
 * Two small things, kept together because they are the same idea: Sotto is a
 * participant rather than a hidden recorder, so it introduces itself and it
 * wants to know who it is listening to.
 *
 * Three decisions worth knowing about.
 *
 * **The hello is read, not written.** `server/prompts/hello.md` holds the exact
 * words, so the one thing every session opens with is the same every time and
 * is edited where the rest of Sotto's words live. No model call, so a session
 * with no `MODEL_API_KEY` still says hello.
 *
 * **Spoken or shown, never both.** A voice that resolves `null` — muted, or no
 * page attached to play it — is the screen-only case the PRD asks for, and the
 * same card covers a voice that was there and failed: a hello nobody can hear
 * and nobody can read is the only outcome worth avoiding.
 *
 * **The nudge waits for a gap.** "I'd love to know who's here" is interrupting
 * if it lands mid-sentence, so the two-minute deadline only *arms* it; it goes
 * up at the next pause, measured with {@link inPause} — the policy's own rule,
 * on the same corrected silence. Once, whatever happens: if everybody has been
 * named by the time a pause arrives it stands down for good.
 */
import { NOTICE_CARD_IDS, type StageCard } from "../../shared/cards.js";
import type { SpeakerNames } from "../../shared/events.js";
import { isSottoTurn, sottoTurn, type PauseState, type TurnUpdate } from "../../shared/turns.js";
import type { Clock } from "../clock.js";
import { PAUSE_MS, inPause } from "../interject/policy.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "../voice/voiceOut.js";

type Logger = Pick<Console, "log" | "warn">;

/**
 * How long a session runs before an unnamed speaker is worth asking about.
 *
 * The PRD's two minutes: long enough that a group which opened with
 * introductions is never asked twice, and short enough that the names arrive
 * while the conversation they label is still going on.
 */
export const NAME_NUDGE_AFTER_MS = 120_000;

/** The nudge, as the PRD words it. */
export const NAME_NUDGE_TEXT = "I'd love to know who's here";

/** How somebody fixes it, under "details ▾". */
const NAME_NUDGE_DETAIL =
  "Say “Hi, I'm …” and I'll pick the name up, or click a speaker label in the transcript to set it.";

/** The utterance id the hello's transcript line is derived from (V2-008a). */
export const HELLO_UTTERANCE_ID = "hello";

export interface GreetingOptions {
  /** The session clock: the two-minute deadline is on the conversation. */
  clock: Clock;
  /** Where Sotto's voice goes, or `null` for a session that only shows things. */
  voice: VoiceOut | null;
  /**
   * Now, on the transcription stream's timeline (V2-008a) — not the clock,
   * which in a live session counts from the start of the process.
   */
  streamNow: () => number;
  /** Whether anybody is talking, and for how long nobody has been. */
  pauseState: () => PauseState;
  /** The names the group has given the diarization labels so far (US-007). */
  names: () => SpeakerNames;
  /** Puts a card on the stage. */
  onCard: (card: StageCard) => void;
  /** Writes Sotto's own line into the conversation (V2-008a). */
  onSpoken: (turn: TurnUpdate) => void;
  onTiming?: (record: Record<string, unknown>) => void;
  logger?: Logger;
}

export class Greeting {
  private readonly clock: Clock;
  private readonly logger: Logger;
  /** Labels that have produced a final turn, so they are somebody in the room. */
  private readonly active = new Set<string>();
  private started = false;
  private stopped = false;
  /** True once the two-minute deadline has passed. */
  private due = false;
  /** True once the nudge has been shown, or stood down for good. */
  private settled = false;
  /** The armed re-check, so only one is ever waiting. */
  private pending: (() => void) | undefined;
  private cancelDeadline: (() => void) | undefined;
  private utterance: VoiceUtterance | undefined;
  /** Resolves when the hello has finished being said; for tests and drains. */
  private hello: Promise<void> = Promise.resolve();

  constructor(private readonly options: GreetingOptions) {
    this.clock = options.clock;
    this.logger = options.logger ?? console;
  }

  /**
   * Says hello and arms the name nudge. Returns at once: the sound, and the
   * transcript line that records it, follow.
   *
   * Called after the session's `session` event has gone out, because that
   * event is what clears the stage — a card published before it would be
   * swept away by the session it belongs to.
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.cancelDeadline = this.clock.setTimeout(() => {
      this.cancelDeadline = undefined;
      this.due = true;
      this.consider();
    }, NAME_NUDGE_AFTER_MS);
    this.hello = this.sayHello();
  }

  /** Every turn the room produced: who is here, and when the room went quiet. */
  acceptTurn(turn: TurnUpdate): void {
    // Sotto is not one of the people whose name is missing (V2-008a).
    if (isSottoTurn(turn)) return;
    if (turn.final && turn.speaker !== null) this.active.add(turn.speaker);
    this.consider();
  }

  /** Resolves once the hello has been said and written down. */
  async flush(): Promise<void> {
    await this.hello;
  }

  /** The end of the session: stop talking, stop waiting for a pause. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelDeadline?.();
    this.cancelDeadline = undefined;
    this.pending?.();
    this.pending = undefined;
    this.utterance?.cancel();
  }

  /** Says the hello out loud, or shows it, and records what the room heard. */
  private async sayHello(): Promise<void> {
    const text = loadPrompt(PROMPTS.hello);
    let utterance: VoiceUtterance | null = null;
    try {
      utterance = (await this.options.voice?.begin()) ?? null;
    } catch (error) {
      // A voice that was there and broke: the hello still has to arrive.
      this.logger.warn(`[hello] could not be said out loud: ${message(error)}`);
    }
    if (utterance === null) {
      this.show(NOTICE_CARD_IDS.hello, text);
      this.options.onTiming?.({ stage: "hello_shown", atMs: this.clock.now() });
      return;
    }
    if (this.stopped) {
      utterance.cancel();
      return;
    }
    this.utterance = utterance;
    // Playback starts within ElevenLabs' first chunk of handing the text over
    // (measured at 299 ms), so this is where the line belongs on the stream.
    const startMs = this.options.streamNow();
    utterance.append(text);
    this.logger.log(`[hello] said out loud as ${utterance.id}`);
    this.options.onTiming?.({
      stage: "hello_spoken", atMs: this.clock.now(),
      utteranceId: utterance.id, startMs, characters: text.length,
    });
    let spoken: VoiceSpoken | undefined;
    try {
      spoken = await utterance.finish();
    } catch (error) {
      this.logger.warn(`[hello] was cut short: ${message(error)}`);
    }
    if (spoken === undefined) return;
    const interrupted = spoken.reason === "cancelled";
    const said = interrupted ? spoken.spokenSoFar : spoken.text;
    // Cut off before the page reported anything: nobody can say what was
    // heard, so the transcript stays short rather than claiming a line.
    if (said.trim() === "") return;
    this.options.onSpoken(
      sottoTurn({ utteranceId: HELLO_UTTERANCE_ID, text: said, startMs, interrupted }),
    );
  }

  /**
   * Decides about the nudge, now and whenever something changed: the deadline
   * passing, a turn arriving, or a pause reaching {@link PAUSE_MS}.
   */
  private consider(): void {
    if (this.stopped || this.settled || !this.due) return;
    const unnamed = this.unnamed();
    if (unnamed.length === 0) {
      // Everybody who has spoken has a name. Not worth asking, and not worth
      // asking later either: the PRD's check is at two minutes, once.
      this.settled = true;
      this.clearPending();
      return;
    }
    const pause = this.options.pauseState();
    if (!inPause(pause)) {
      this.arm(pause);
      return;
    }
    this.settled = true;
    this.clearPending();
    this.logger.log(`[hello] asking who is here (${unnamed.join(", ")} unnamed)`);
    this.options.onCard(
      notice(NOTICE_CARD_IDS.names, NAME_NUDGE_TEXT, this.clock.now(), NAME_NUDGE_DETAIL),
    );
    this.options.onTiming?.({ stage: "name_nudge", atMs: this.clock.now(), unnamed });
  }

  /**
   * Asks again when the pause could have become one. While somebody is
   * talking there is nothing to wait for — the turn closing is what arrives
   * next — so no timer is armed at all.
   */
  private arm(pause: PauseState): void {
    this.clearPending();
    if (pause.speaking) return;
    const delay = Math.max(1, PAUSE_MS - pause.silentForMs);
    const cancel = this.clock.setTimeout(() => {
      this.pending = undefined;
      this.consider();
    }, delay);
    this.pending = cancel;
  }

  private clearPending(): void {
    this.pending?.();
    this.pending = undefined;
  }

  /** Labels that have spoken and still have no name. */
  private unnamed(): string[] {
    const names = this.options.names();
    return [...this.active].filter((label) => {
      const name = names[label];
      return name === undefined || name.trim() === "";
    });
  }

  private show(id: string, headline: string): void {
    this.logger.log(`[hello] shown on the stage as ${id}`);
    this.options.onCard(notice(id, headline, this.clock.now()));
  }
}

/** One `notice` card: plain, no feedback buttons, nothing to open. */
function notice(id: string, headline: string, createdAtMs: number, detailMd?: string): StageCard {
  return {
    id,
    variant: "notice",
    state: "ready",
    createdAtMs,
    headline,
    ...(detailMd === undefined ? {} : { detailMd }),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
