/**
 * The seam between something that has words to say and the voice that says
 * them (V2-005).
 *
 * The answer agent must not know whether Sotto is being heard through a
 * browser's speakers, through a null sink in a headless check (V2-021), or not
 * at all because the voice is muted. All three are the same three moves —
 * open an utterance, feed it sentences, finish it — so that is the interface,
 * and {@link VoiceOut.begin} returning `null` is how "nothing would be heard"
 * arrives. Null is not an error: a muted Sotto answers on screen only, and the
 * caller carries on writing the card.
 *
 * {@link VoiceHub} is the real one. {@link nullSinkVoice} is the real
 * ElevenLabs socket with the audio thrown away, which is what an integration
 * test and the end-to-end check speak through — the timings and the
 * spoken-so-far tracking are real, only the speakers are missing.
 * {@link transcriptOnlyVoice} is one step further out, for the `max`-speed
 * eval (V3-010): nothing is synthesized at all, so the decisions are real and
 * there is no audio and no bill.
 */
import type { VoiceSpend } from "../../shared/e2e.js";
import type { SpeechEndReason, Speaker } from "./Speaker.js";
import type { SpeechPlayback } from "./selfEcho.js";

/** What one utterance came to, as whoever was talking sees it. */
export interface VoiceSpoken {
  reason: SpeechEndReason;
  /** Every character handed to the voice, in order. */
  text: string;
  /**
   * What the room actually heard. Short of {@link text} only when speech was
   * cut off; empty when nothing reported having played anything.
   */
  spokenSoFar: string;
  /**
   * `begin()` to the first audio chunk, in real milliseconds; `null` if none
   * arrived. Real time on purpose — see `Answer.ackMs`.
   */
  firstAudioMs: number | null;
}

/** One open utterance, fed a sentence at a time while it is being spoken. */
export interface VoiceUtterance {
  readonly id: string;
  /** The next piece of text. Ignored once the utterance has ended. */
  append(text: string): void;
  /** No more text; playback voices resolve when heard or flushed, null sinks when synthesized. */
  finish(): Promise<VoiceSpoken>;
  /**
   * `begin()` to the first audio chunk, in real milliseconds, or `null` while
   * none has arrived. Readable at any time, because the latency the room felt
   * is wanted long before the utterance is over.
   */
  firstAudioMs(): number | null;
  /**
   * Milliseconds of speech synthesized so far (V2-008c).
   *
   * Everything appended to one utterance is heard in the order it was handed
   * over, so this also says *where* the next piece will be heard: an answer
   * that opened with a holding line reaches its searched continuation at the
   * utterance's first audio plus this. Optional, because a voice that only
   * records the text has no audio to measure.
   */
  audioMs?(): number;
  /** Stops now and throws away what has not been heard. */
  cancel(): void;
}

/** Where Sotto's speech goes. */
export interface VoiceOut {
  /** V2-007: stop synchronously, then report flush delay; null means no browser confirmation. */
  interrupt?(): Promise<number | null>;
  /**
   * Actual sound and recently heard text for echo filtering (V2-006).
   * Optional because screen-only and null-sink voices cannot echo into a mic.
   */
  playback?(): SpeechPlayback;
  /**
   * Opens an utterance, stopping whatever was being said, or resolves `null`
   * when nothing would be heard — muted, or nowhere to play it.
   *
   * @throws whatever the voice threw if it was there and failed to open, so a
   * broken ElevenLabs key is a reported failure rather than a silent mute.
   */
  begin(): Promise<VoiceUtterance | null>;
}

/**
 * A voice that really synthesizes and discards the audio.
 *
 * For the checks that have to exercise the whole speech path without a
 * browser: the socket, the streaming, the alignment and the latencies are the
 * live ones, and nothing comes out of a speaker. A completed utterance is
 * treated as entirely heard, since nothing cut it off; a cancelled one keeps
 * whatever playback was reported, which for a sink nobody listens to is
 * nothing — the honest answer rather than a guess.
 */
export function nullSinkVoice(create: () => Speaker): VoiceOut {
  let open: Speaker | undefined;
  let nextId = 0;
  return {
    async begin(): Promise<VoiceUtterance | null> {
      open?.cancel();
      const speaker = create();
      open = speaker;
      await speaker.start();
      const id = `null-${++nextId}`;
      return {
        id,
        append: (text) => speaker.append(text),
        cancel: () => speaker.cancel(),
        firstAudioMs: () => speaker.firstAudioMs,
        audioMs: () => speaker.audioMs,
        finish: () =>
          speaker.finish().then((result) => {
            if (result.reason === "complete") speaker.notePlayedAll();
            return {
              reason: result.reason,
              text: result.text,
              spokenSoFar: speaker.spokenSoFar(),
              firstAudioMs: result.firstAudioMs,
            };
          }),
      };
    },
  };
}

/**
 * A voice that says nothing and reports the words as entirely heard (V3-010).
 *
 * The instrument the `max`-speed eval speaks through. It exists because a
 * replay with *no* voice is not a quiet Sotto, it is a Sotto that cannot
 * speak: `begin()` resolving `null` means "nobody would hear this", so every
 * unprompted line would be written off as `unheard` and the whole of V3's main
 * form would be unmeasurable. With this one the decisions are real — the gap
 * was found, the frequency's allowance was spent, Sotto's line went into the
 * transcript and onto the board — and nothing is synthesized.
 *
 * What it deliberately cannot measure is anything about sound: there is no
 * first audio, no alignment and no playback to report, which is honest rather
 * than lossy, because simulated time does not move inside a tracked call and
 * a replay's synthesis latencies would be fiction. `npm run e2e` is the clock
 * that charges for those, through {@link nullSinkVoice} against real
 * ElevenLabs.
 *
 * A cancelled utterance reports nothing heard, as the null sink does: audio
 * having been generated is not the same as anybody having heard it, and here
 * none was.
 */
export function transcriptOnlyVoice(): VoiceOut {
  let nextId = 0;
  return {
    async begin(): Promise<VoiceUtterance | null> {
      let said = "";
      let cancelled = false;
      return {
        id: `silent-${++nextId}`,
        append: (text) => {
          if (!cancelled) said += text;
        },
        cancel: () => {
          cancelled = true;
        },
        firstAudioMs: () => null,
        finish: async () => ({
          reason: cancelled ? "cancelled" : "complete",
          text: said,
          spokenSoFar: cancelled ? "" : said,
          firstAudioMs: null,
        }),
      };
    },
  };
}

/** A voice that also says what it was asked to say, in characters. */
export interface MeteredVoice extends VoiceOut {
  /** Utterances opened and characters handed over so far. */
  spent(): VoiceSpend;
}

/**
 * `voice`, counting what went through it (V2-021).
 *
 * ElevenLabs bills by characters, so the end-to-end check has to know how
 * many were sent before it can price a run. Counted here rather than inside
 * {@link Speaker} because the text is handed over at this seam — one tally
 * covers the hello, the acknowledgment, the holding line and the answer, and
 * it survives the several `Speaker`s one session gets through.
 *
 * Characters *appended*, not characters heard: a barge-in stops the sound and
 * not the invoice. Every move is delegated explicitly rather than spread, so
 * a voice whose utterance is a class instance keeps its `this`.
 */
export function meteredVoice(voice: VoiceOut): MeteredVoice {
  const spend: VoiceSpend = { utterances: 0, characters: 0 };
  const metered: MeteredVoice = {
    spent: () => ({ ...spend }),
    async begin(): Promise<VoiceUtterance | null> {
      const utterance = await voice.begin();
      // A muted or unattached voice is not billed for anything.
      if (utterance === null) return null;
      spend.utterances += 1;
      const wrapped: VoiceUtterance = {
        id: utterance.id,
        append: (text) => {
          spend.characters += text.length;
          utterance.append(text);
        },
        finish: () => utterance.finish(),
        firstAudioMs: () => utterance.firstAudioMs(),
        cancel: () => utterance.cancel(),
      };
      // Optional on the interface, so it is only offered when the inner
      // utterance really has it — V2-008c's continuation checks for it.
      const { audioMs } = utterance;
      if (audioMs !== undefined) wrapped.audioMs = () => audioMs.call(utterance);
      return wrapped;
    },
  };
  const { interrupt, playback } = voice;
  if (interrupt !== undefined) metered.interrupt = () => interrupt.call(voice);
  if (playback !== undefined) metered.playback = () => playback.call(voice);
  return metered;
}
