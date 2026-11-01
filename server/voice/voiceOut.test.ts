/**
 * The voice seam's two wrappers (V2-005, V2-021).
 *
 * {@link meteredVoice} is what lets `npm run e2e` price the speech it bought:
 * ElevenLabs bills by characters, so the characters have to be counted where
 * the text is handed over. Pure plumbing, tested against a fake voice —
 * {@link nullSinkVoice} needs a real `Speaker` and is covered by
 * `Speaker.integration.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { meteredVoice, type VoiceOut, type VoiceSpoken, type VoiceUtterance } from "./voiceOut.js";

/** A voice that records what it was told, with every optional move present. */
function fakeVoice(options: { begin?: boolean } = {}): VoiceOut & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    async begin(): Promise<VoiceUtterance | null> {
      if (options.begin === false) return null;
      const utterance: VoiceUtterance = {
        id: "fake-1",
        append: (text) => void said.push(text),
        finish: async (): Promise<VoiceSpoken> => ({
          reason: "complete",
          text: said.join(""),
          spokenSoFar: said.join(""),
          firstAudioMs: 299,
        }),
        firstAudioMs: () => 299,
        audioMs: () => 2_650,
        cancel: () => void said.push("<cancelled>"),
      };
      return utterance;
    },
    interrupt: async () => 120,
    playback: () => ({ playing: false, recent: [] }),
  };
}

describe("meteredVoice", () => {
  it("counts the utterances and the characters, and passes the text through", async () => {
    const inner = fakeVoice();
    const voice = meteredVoice(inner);
    expect(voice.spent()).toEqual({ utterances: 0, characters: 0 });

    const first = await voice.begin();
    first?.append("Mm-hm.");
    first?.append(" Rivals charge about twenty dollars.");
    await first?.finish();
    const second = await voice.begin();
    second?.append("Let me check.");

    expect(inner.said).toEqual([
      "Mm-hm.",
      " Rivals charge about twenty dollars.",
      "Let me check.",
    ]);
    expect(voice.spent()).toEqual({ utterances: 2, characters: 6 + 36 + 13 });
  });

  it("bills a cancelled utterance for what it was given", async () => {
    // A barge-in stops the sound, not the invoice.
    const voice = meteredVoice(fakeVoice());
    const utterance = await voice.begin();
    utterance?.append("The market is about two billion a year, though");
    utterance?.cancel();
    expect(voice.spent()).toEqual({ utterances: 1, characters: 46 });
  });

  it("charges nothing for a voice with nowhere to play", async () => {
    const voice = meteredVoice(fakeVoice({ begin: false }));
    expect(await voice.begin()).toBeNull();
    expect(voice.spent()).toEqual({ utterances: 0, characters: 0 });
  });

  it("keeps every other move the voice had, bound to it", async () => {
    const inner = fakeVoice();
    const voice = meteredVoice(inner);
    expect(await voice.interrupt?.()).toBe(120);
    expect(voice.playback?.()).toEqual({ playing: false, recent: [] });
    const utterance = await voice.begin();
    expect(utterance?.id).toBe("fake-1");
    expect(utterance?.firstAudioMs()).toBe(299);
    expect(utterance?.audioMs?.()).toBe(2_650);
    expect((await utterance?.finish())?.reason).toBe("complete");
  });

  it("offers audioMs only when the voice underneath has it", async () => {
    const bare: VoiceOut = {
      begin: async () => ({
        id: "bare-1",
        append: vi.fn(),
        finish: async () => ({
          reason: "complete" as const,
          text: "",
          spokenSoFar: "",
          firstAudioMs: null,
        }),
        firstAudioMs: () => null,
        cancel: vi.fn(),
      }),
    };
    const utterance = await meteredVoice(bare).begin();
    expect(utterance?.audioMs).toBeUndefined();
    expect(utterance?.firstAudioMs()).toBeNull();
  });
});
