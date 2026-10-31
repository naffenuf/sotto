/**
 * Turns a fixture script into audio: one synthesized line after another,
 * joined by the pauses the script asks for.
 *
 * The rule the whole downstream pipeline leans on is that **the scripted
 * pauses have to be honest**. Pause detection, the eval harness's windows and
 * `fixtures/events/NOTES.md`'s endpointer measurements all read a gap in the
 * WAV as the gap the script wrote, so the near-silence a text-to-speech engine
 * pads each utterance with (measured 54–91 ms at the head and 268–371 ms at the
 * tail) is trimmed off before the pause is inserted. The old Chatterbox
 * renderer did the same thing for the same reason.
 *
 * Synthesis itself is a parameter ({@link SynthesizeLine}), so the assembly —
 * trimming, concatenation, timings — is unit-tested without a network call.
 */
import { AUDIO_SAMPLE_RATE } from "../../shared/audio.js";
import {
  FIXTURE_SAMPLE_RATE,
  type FixtureScript,
  type FixtureSpeaker,
  type FixtureTiming,
} from "../../shared/fixtures.js";
import { encodeWav } from "./wav.js";

/**
 * Where a line's audio is considered to begin and end, as a fraction of its
 * own peak. The same 2% Chatterbox's renderer used.
 */
const TRIM_THRESHOLD = 0.02;
/** Natural-sounding padding kept either side of the trimmed speech. */
const TRIM_PADDING_MS = 60;

/** Synthesizes one line and returns raw PCM16 mono samples at 24 kHz. */
export type SynthesizeLine = (line: {
  index: number;
  speaker: FixtureSpeaker;
  text: string;
}) => Promise<Buffer>;

/** Told about each line once it has been rendered, for CLI progress. */
export type RenderProgress = (progress: {
  index: number;
  total: number;
  speaker: FixtureSpeaker;
  text: string;
  durationMs: number;
}) => void;

export interface RenderedScript {
  /** A complete WAV file: mono, 16-bit PCM, 24 kHz. */
  wav: Buffer;
  /** Where every line landed, in `<name>.timing.json`'s shape. */
  timing: FixtureTiming;
}

/** Index of the first and last sample above the trim threshold, inclusive. */
function speechBounds(samples: Buffer): { start: number; end: number } {
  const count = Math.floor(samples.length / 2);
  let peak = 0;
  for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(samples.readInt16LE(i * 2)));
  if (peak === 0) return { start: 0, end: count };

  const threshold = TRIM_THRESHOLD * peak;
  let first = 0;
  while (first < count && Math.abs(samples.readInt16LE(first * 2)) <= threshold) first++;
  let last = count - 1;
  while (last > first && Math.abs(samples.readInt16LE(last * 2)) <= threshold) last--;
  return { start: first, end: last + 1 };
}

/** Drops the near-silent head and tail, keeping {@link TRIM_PADDING_MS} of each. */
function trimSilence(samples: Buffer): Buffer {
  const count = Math.floor(samples.length / 2);
  if (count === 0) return samples;
  const { start, end } = speechBounds(samples);
  const padding = Math.round((AUDIO_SAMPLE_RATE * TRIM_PADDING_MS) / 1000);
  const from = Math.max(0, start - padding);
  const to = Math.min(count, end + padding);
  return samples.subarray(from * 2, to * 2);
}

/** Milliseconds of 24 kHz PCM16 in `bytes` bytes. */
function samplesForMs(ms: number): number {
  return Math.round((AUDIO_SAMPLE_RATE * ms) / 1000);
}

function msAtSample(sample: number): number {
  return Math.round((sample * 1000) / AUDIO_SAMPLE_RATE);
}

/**
 * Renders `script` with `synthesize`, returning the WAV and its timings.
 * Lines are rendered one at a time, in order, so a long script can report
 * progress and so the API is never hit with a burst.
 */
export async function renderScript(
  name: string,
  script: FixtureScript,
  synthesize: SynthesizeLine,
  onProgress?: RenderProgress,
): Promise<RenderedScript> {
  const parts: Buffer[] = [];
  const lines: FixtureTiming["lines"] = [];
  let cursor = 0; // samples written so far

  for (const [index, line] of script.lines.entries()) {
    const speech = trimSilence(await synthesize({ index, speaker: line.speaker, text: line.text }));
    const startMs = msAtSample(cursor);
    parts.push(speech);
    cursor += Math.floor(speech.length / 2);
    const endMs = msAtSample(cursor);
    lines.push({ index, speaker: line.speaker, startMs, endMs });

    const pause = samplesForMs(line.pauseAfterMs);
    if (pause > 0) {
      parts.push(Buffer.alloc(pause * 2));
      cursor += pause;
    }

    onProgress?.({
      index,
      total: script.lines.length,
      speaker: line.speaker,
      text: line.text,
      durationMs: endMs - startMs,
    });
  }

  const data = Buffer.concat(parts);
  return {
    wav: encodeWav(data, { channels: 1, sampleRate: FIXTURE_SAMPLE_RATE, bitsPerSample: 16 }),
    timing: { name, sampleRate: FIXTURE_SAMPLE_RATE, durationMs: msAtSample(cursor), lines },
  };
}
