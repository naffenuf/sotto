/**
 * How soon the transcript panel has something to show (US-007).
 *
 * The criterion is three seconds from the first spoken word, and both numbers
 * are on record: `fixtures/audio/brainstorm.timing.json` says when line 0
 * starts in the audio, and the capture says when the API's first `transcript`
 * frame came back. Replaying the capture at `max` sets the pipeline clock to
 * each frame's recorded arrival time, so simulated time here *is* the
 * conversation's own timeline — the measurement is the same one a live session
 * would make, taken instantly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureTimingSchema } from "../../shared/fixtures.js";
import { EventReplaySource, assemblerSink } from "../asr/EventReplaySource.js";
import { TurnAssembler } from "../asr/turns.js";
import { FIXTURE_AUDIO_DIR } from "../audio/WavReplaySource.js";
import { SimulatedClock } from "../clock.js";

const quiet = { warn: () => {} };

/** How long the panel may stay empty after the first word is spoken. */
const FIRST_TEXT_BUDGET_MS = 3_000;

describe("first text in the transcript panel", () => {
  it("arrives within three seconds of the first spoken word", async () => {
    const timing = FixtureTimingSchema.parse(
      JSON.parse(readFileSync(join(FIXTURE_AUDIO_DIR, "brainstorm.timing.json"), "utf8")),
    );
    const firstWordMs = timing.lines[0]?.startMs ?? 0;

    const clock = new SimulatedClock(0);
    let firstTextMs: number | null = null;
    const assembler = new TurnAssembler({
      clock,
      startedAtMs: 0,
      logger: quiet,
      onUpdate: (turn) => {
        // A partial counts: gray italic text is still text on the screen.
        if (firstTextMs === null && turn.text.trim() !== "") firstTextMs = clock.now();
      },
    });

    await EventReplaySource.forFixture("brainstorm", { clock, speed: "max" }).run(
      assemblerSink(assembler),
    );

    expect(firstTextMs).not.toBeNull();
    expect((firstTextMs ?? 0) - firstWordMs).toBeLessThanOrEqual(FIRST_TEXT_BUDGET_MS);
  });
});
