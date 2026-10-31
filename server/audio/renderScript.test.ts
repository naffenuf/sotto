import { describe, expect, it } from "vitest";
import { renderScript, type SynthesizeLine } from "./renderScript.js";
import { parseWav } from "./wav.js";
import {
  FIXTURE_SAMPLE_RATE,
  FixtureTimingSchema,
  type FixtureScript,
} from "../../shared/fixtures.js";

/** PCM16 for `ms` milliseconds, every sample at `amplitude`. */
function tone(ms: number, amplitude = 8_000): Buffer {
  const count = Math.round((FIXTURE_SAMPLE_RATE * ms) / 1000);
  const buffer = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) buffer.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return buffer;
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((FIXTURE_SAMPLE_RATE * ms) / 1000) * 2);
}

function script(...lines: FixtureScript["lines"]): FixtureScript {
  return { lines, wakeQuestions: [], moments: [] };
}

/** Samples in a WAV's data chunk. */
function sampleCount(wav: Buffer): number {
  return parseWav(wav).data.length / 2;
}

describe("renderScript", () => {
  it("lays lines out with their scripted pauses between them", async () => {
    const synthesize: SynthesizeLine = async () => tone(1_000);
    const { wav, timing } = await renderScript(
      "two-lines",
      script(
        { speaker: "A", text: "First.", pauseAfterMs: 500 },
        { speaker: "B", text: "Second.", pauseAfterMs: 0 },
      ),
      synthesize,
    );

    expect(timing).toEqual({
      name: "two-lines",
      sampleRate: FIXTURE_SAMPLE_RATE,
      durationMs: 2_500,
      lines: [
        { index: 0, speaker: "A", startMs: 0, endMs: 1_000 },
        { index: 1, speaker: "B", startMs: 1_500, endMs: 2_500 },
      ],
    });
    expect(FixtureTimingSchema.safeParse(timing).success).toBe(true);

    const format = parseWav(wav);
    expect(format.channels).toBe(1);
    expect(format.sampleRate).toBe(FIXTURE_SAMPLE_RATE);
    expect(format.bitsPerSample).toBe(16);
    expect(sampleCount(wav)).toBe((FIXTURE_SAMPLE_RATE * 2_500) / 1000);
  });

  it("trims the near-silence the engine pads an utterance with, so the pause stays honest", async () => {
    // 300 ms of padding either side of 400 ms of speech: trimming keeps 60 ms
    // of each, so the line is 520 ms and the gap after it is the scripted one.
    const synthesize: SynthesizeLine = async () =>
      Buffer.concat([silence(300), tone(400), silence(300)]);
    const { timing } = await renderScript(
      "padded",
      script(
        { speaker: "A", text: "Padded.", pauseAfterMs: 800 },
        { speaker: "B", text: "Next.", pauseAfterMs: 0 },
      ),
      synthesize,
    );

    const [first, second] = timing.lines;
    expect(first?.endMs).toBe(520);
    expect((second?.startMs ?? 0) - (first?.endMs ?? 0)).toBe(800);
  });

  it("keeps a line of pure silence rather than collapsing it", async () => {
    const synthesize: SynthesizeLine = async () => silence(200);
    const { timing } = await renderScript(
      "quiet",
      script({ speaker: "A", text: "…", pauseAfterMs: 0 }),
      synthesize,
    );

    expect(timing.lines[0]?.endMs).toBe(200);
  });

  it("asks for each line in order, with its speaker and text", async () => {
    const asked: string[] = [];
    const synthesize: SynthesizeLine = async ({ index, speaker, text }) => {
      asked.push(`${index}:${speaker}:${text}`);
      return tone(100);
    };

    await renderScript(
      "ordered",
      script(
        { speaker: "A", text: "One.", pauseAfterMs: 0 },
        { speaker: "B", text: "Two.", pauseAfterMs: 0 },
        { speaker: "A", text: "Three.", pauseAfterMs: 0 },
      ),
      synthesize,
    );

    expect(asked).toEqual(["0:A:One.", "1:B:Two.", "2:A:Three."]);
  });

  it("reports progress per line", async () => {
    const seen: Array<{ index: number; total: number; durationMs: number }> = [];
    await renderScript(
      "progress",
      script(
        { speaker: "A", text: "One.", pauseAfterMs: 400 },
        { speaker: "B", text: "Two.", pauseAfterMs: 0 },
      ),
      async () => tone(250),
      ({ index, total, durationMs }) => seen.push({ index, total, durationMs }),
    );

    expect(seen).toEqual([
      { index: 0, total: 2, durationMs: 250 },
      { index: 1, total: 2, durationMs: 250 },
    ]);
  });
});
