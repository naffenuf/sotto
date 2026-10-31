/**
 * Sotto's voice against the real ElevenLabs socket (PRD V2-003).
 *
 * One short sentence, which is the whole cost of this test, and the thing it
 * really measures is latency: how long after `start()` the first PCM frame
 * arrives, because that number is what decides whether Sotto can answer a
 * question in a room without an awkward gap. It is logged rather than
 * asserted on — a network is a network — but the shape of what comes back is
 * asserted hard, since that is what the unit tests' fake server is pretending
 * to be.
 */
import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import { AUDIO_SAMPLE_RATE } from "../../shared/audio.js";
import { Speaker } from "./Speaker.js";

// `globalSetup` loads `.env` in the main process; a test file runs in a worker
// and has to load it for itself.
loadDotenv({ quiet: true });

const apiKey = (process.env.ELEVENLABS_API_KEY ?? "").trim();
const voiceId = (process.env.ELEVENLABS_VOICE_ID ?? "").trim() || undefined;

const SENTENCE = "The budget came up twice.";
const SECOND = "I can summarize it.";

describe.skipIf(apiKey === "")("Speaker against the real ElevenLabs socket", () => {
  it("streams PCM for two sentences and reports what was spoken", async () => {
    const chunks: Buffer[] = [];
    const firstChunkAt: number[] = [];
    const speaker = new Speaker({
      apiKey,
      voiceId,
      onAudio: (chunk) => {
        if (chunks.length === 0) firstChunkAt.push(performance.now());
        chunks.push(chunk);
      },
    });

    const startedAt = performance.now();
    await speaker.start();
    speaker.append(SENTENCE);
    // Appended while the first sentence is already being synthesized, which is
    // the whole point of the streaming endpoint.
    speaker.append(SECOND);
    const result = await speaker.finish();

    const firstAudioMs = (firstChunkAt[0] ?? NaN) - startedAt;
    console.log(
      `[voice] ${chunks.length} chunks, ${result.audioBytes} bytes ` +
        `(${Math.round(result.audioMs)} ms of speech); first audio chunk at ` +
        `${Math.round(firstAudioMs)} ms, whole utterance in ` +
        `${Math.round(performance.now() - startedAt)} ms`,
    );

    expect(result.reason).toBe("complete");
    expect(chunks.length).toBeGreaterThan(0);
    expect(result.audioBytes).toBeGreaterThan(0);
    // `pcm_24000` is raw little-endian 16-bit mono: an odd byte count would
    // mean something reframed it.
    expect(result.audioBytes % 2).toBe(0);
    // Two short sentences are over a second of speech and well under a minute.
    expect(result.audioMs).toBeGreaterThan(1_000);
    expect(result.audioMs).toBeLessThan(60_000);
    expect(result.firstAudioMs).not.toBeNull();
    expect(result.text).toBe(`${SENTENCE} ${SECOND}`);

    // Alignment has to cover the text, or V2-007 could never resume from where
    // an interruption landed.
    const aligned = speaker.alignedText();
    console.log(`[voice] alignment covered ${aligned.length} characters`);
    expect(aligned.replace(/\s+/g, " ")).toBe(`${SENTENCE} ${SECOND}`);

    // Nothing is claimed as spoken until playback says so; once it does, the
    // text spoken so far grows with the position.
    expect(result.spokenSoFar).toBe("");
    speaker.notePlayedMs(result.audioMs / 2);
    const half = speaker.spokenSoFar();
    speaker.notePlayedAll();
    const all = speaker.spokenSoFar();
    console.log(`[voice] halfway through playback Sotto had said: ${JSON.stringify(half)}`);
    expect(half.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(half.length);
    expect(all.replace(/\s+/g, " ")).toBe(`${SENTENCE} ${SECOND}`);

    // 24 kHz is the one rate the rest of Sotto speaks, so no resampling.
    expect(AUDIO_SAMPLE_RATE).toBe(24_000);
  }, 60_000);

  it("stops immediately when cancelled, and keeps what was heard", async () => {
    const chunks: Buffer[] = [];
    const speaker = new Speaker({ apiKey, voiceId, onAudio: (chunk) => chunks.push(chunk) });
    await speaker.start();
    speaker.append(
      "Let me run through the whole plan from the top, because there are several " +
        "parts and they depend on each other in ways that are easy to miss.",
    );
    const finished = speaker.finish();

    // Wait for sound, pretend the room heard the first second of it, cut it off.
    const deadline = Date.now() + 30_000;
    while (chunks.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(chunks.length).toBeGreaterThan(0);
    speaker.notePlayedMs(1_000);
    const atCancel = chunks.length;
    speaker.cancel();

    const result = await finished;
    await new Promise((resolve) => setTimeout(resolve, 300));
    console.log(
      `[voice] cancelled after ${atCancel} chunks; spoken so far: ` +
        `${JSON.stringify(result.spokenSoFar)}`,
    );
    expect(result.reason).toBe("cancelled");
    // Nothing the server sent after the cancel was emitted.
    expect(chunks).toHaveLength(atCancel);
    expect(result.spokenSoFar.length).toBeGreaterThan(0);
    expect(result.text.startsWith(result.spokenSoFar)).toBe(true);
    expect(result.spokenSoFar.length).toBeLessThan(result.text.length);
  }, 60_000);
});
