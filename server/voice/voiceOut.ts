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
 */
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
