/**
 * The planted moments of one fixture, placed on both timelines (PRD US-016).
 *
 * A moment is written in terms of script lines (`setupLines`, `triggerLine`,
 * `deadlineLine`); scoring needs times. There are two timelines to put them
 * on and the harness records both:
 *
 *   - **The audio.** `<fixture>.timing.json` says where each line was rendered
 *     in the WAV. Exact, and completely independent of the transcription.
 *   - **The session clock.** What the policy actually saw: a frame arrives
 *     600–760 ms after the audio it describes, and the endpointer trims about
 *     half a second off each end of a line (`fixtures/events/NOTES.md`), so
 *     the turns a line produced are offset from the line itself.
 *
 * So turns are matched to lines by overlap with {@link TURN_SLACK_MS} of slack
 * each side — the same allowance `board.integration.test.ts` makes — and the
 * moment carries both the scripted times and the turn ids it resolved to.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MomentRecord } from "../../shared/eval.js";
import {
  FixtureScriptSchema,
  FixtureTimingSchema,
  type FixtureScript,
  type FixtureTiming,
  type PlantedMoment,
} from "../../shared/fixtures.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { FIXTURE_AUDIO_DIR } from "../audio/WavReplaySource.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Where the scripts the moments are planted in live. */
export const FIXTURE_SCRIPTS_DIR = join(repoRoot, "fixtures/scripts");

/**
 * How far outside a scripted line a turn may sit and still be that line's.
 * The transcription's endpointer trims the start and end of every line, so a
 * turn never lines up with its script exactly.
 */
export const TURN_SLACK_MS = 1_500;

/** The script of `fixture`, validated. */
export function loadScript(fixture: string): FixtureScript {
  const path = join(FIXTURE_SCRIPTS_DIR, `${fixture}.json`);
  return FixtureScriptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Where each line of `fixture` landed in the rendered audio. */
export function loadTiming(fixture: string): FixtureTiming {
  const path = join(FIXTURE_AUDIO_DIR, `${fixture}.timing.json`);
  return FixtureTimingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** The final turns that overlap a scripted line, in the order they finalised. */
export function turnsForLine(
  line: number,
  timing: FixtureTiming,
  turns: readonly TurnUpdate[],
): TurnUpdate[] {
  const scripted = timing.lines.find((entry) => entry.index === line);
  if (scripted === undefined) return [];
  return turns.filter(
    (turn) =>
      turn.startMs <= scripted.endMs + TURN_SLACK_MS &&
      (turn.endMs ?? turn.startMs) >= scripted.startMs - TURN_SLACK_MS,
  );
}

/** The session-clock end of the last turn overlapping a line, or `null`. */
function lineEndOnClock(
  line: number,
  timing: FixtureTiming,
  turns: readonly TurnUpdate[],
): number | null {
  const ends = turnsForLine(line, timing, turns).map((turn) => turn.endMs ?? turn.startMs);
  return ends.length === 0 ? null : Math.max(...ends);
}

/** The scripted end of a line in the audio, or 0 for a line with no timing. */
function scriptedEnd(line: number, timing: FixtureTiming): number {
  return timing.lines.find((entry) => entry.index === line)?.endMs ?? 0;
}

/** One planted moment, with everything a report needs to place it in time. */
export function resolveMoment(
  moment: PlantedMoment,
  timing: FixtureTiming,
  turns: readonly TurnUpdate[],
): MomentRecord {
  return {
    id: moment.id,
    type: moment.type,
    expectedLevel: moment.expectedLevel,
    description: moment.description,
    triggerLine: moment.triggerLine,
    deadlineLine: moment.deadlineLine,
    triggerEndMs: scriptedEnd(moment.triggerLine, timing),
    deadlineEndMs: scriptedEnd(moment.deadlineLine, timing),
    setupTurnIds: moment.setupLines.flatMap((line) =>
      turnsForLine(line, timing, turns).map((turn) => turn.turnId),
    ),
    triggerTurnIds: turnsForLine(moment.triggerLine, timing, turns).map((turn) => turn.turnId),
    triggerTurnEndMs: lineEndOnClock(moment.triggerLine, timing, turns),
    deadlineTurnEndMs: lineEndOnClock(moment.deadlineLine, timing, turns),
  };
}

/** Every moment in `fixture`, resolved against the turns a replay produced. */
export function resolveMoments(
  fixture: string,
  turns: readonly TurnUpdate[],
): MomentRecord[] {
  const script = loadScript(fixture);
  if (script.moments.length === 0) return [];
  const timing = loadTiming(fixture);
  return script.moments.map((moment) => resolveMoment(moment, timing, turns));
}

/** The lines a moment rests on, quoted for the judge. */
export function momentLines(
  moment: PlantedMoment,
  script: FixtureScript,
): { setup: string[]; trigger: string } {
  const quote = (line: number): string => {
    const spoken = script.lines[line];
    return spoken === undefined ? `[line ${line} is missing]` : `${spoken.speaker}: ${spoken.text}`;
  };
  return {
    setup: moment.setupLines.map(quote),
    trigger: quote(moment.triggerLine),
  };
}
