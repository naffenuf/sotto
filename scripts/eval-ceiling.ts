/**
 * `npm run eval:ceiling` — the most recall the fixtures can give, for free.
 *
 * Replays each capture through the turn assembler only (no model, no network,
 * no session folder), places every planted moment against the board/observer
 * cadence and the silences the transcription reported, and prints how many
 * moments are deliverable at each pause threshold. See
 * `server/eval/ceiling.ts` for what "deliverable" means and why it is an upper
 * bound.
 *
 * Options:
 *   --fixtures a,b    only these (default: every fixture with planted moments)
 *   --every N         pretend the observer looks every N final turns
 *   --speak           measure SPEAK_PAUSE_MS instead (V3-004): the quiet every
 *                     planted open question offers, and the largest threshold
 *                     that clears it by SPEAK_MARGIN_MS. The default fixtures
 *                     are then the two with open questions planted in them.
 */
import { EventReplaySource } from "../server/asr/EventReplaySource.js";
import { TurnAssembler } from "../server/asr/turns.js";
import { SimulatedClock } from "../server/clock.js";
import { NEW_TURNS_PER_UPDATE } from "../server/board/BoardUpdater.js";
import {
  CEILING_THRESHOLDS_MS,
  SPEAK_MARGIN_MS,
  SPEAK_MOMENT_TYPES,
  ceilingTable,
  momentReach,
  speakReach,
  speakThresholdMs,
  type MomentReach,
  type SpeakReach,
} from "../server/eval/ceiling.js";
import { loadScript, resolveMoments } from "../server/eval/moments.js";
import { PAUSE_MS, SPEAK_PAUSE_MS } from "../server/interject/policy.js";
import { QUESTION_FIXTURE, RESEARCH_FIXTURE } from "../shared/e2e.js";
import type { TurnUpdate } from "../shared/turns.js";

/** Every fixture that has something planted in it, in script order. */
const MOMENT_FIXTURES = [
  "moment-contradiction",
  "moment-fact",
  "moment-assumption",
  "moment-dropped",
  "moment-mixed",
];

/** The two conversations with a planted open question in them (V3-004). */
const QUESTION_FIXTURES = [QUESTION_FIXTURE, RESEARCH_FIXTURE];

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** The turn snapshots a capture produces, with no pipeline attached. */
async function replay(fixture: string): Promise<TurnUpdate[]> {
  const clock = new SimulatedClock(0);
  const assembler = new TurnAssembler({ clock, startedAtMs: 0 });
  const turns: TurnUpdate[] = [];
  const source = EventReplaySource.forFixture(fixture, { clock, speed: "max" });
  await source.run({
    onFrame: (record) => {
      const update = assembler.accept(record);
      if (update !== null) turns.push(update);
    },
    onEnd: () => {},
  });
  return turns;
}

function seconds(ms: number): string {
  return `${(ms / 1_000).toFixed(1)}s`;
}

/**
 * The quiet every planted open question offers an answer, and the threshold
 * the PRD's rule picks from it (V3-004).
 *
 * No observer and no board cadence come into it: an open question is noticed
 * on its own final turn and searched for at once, so the only three facts are
 * the window, the real quiet inside it and what the search costs.
 */
async function speak(fixtures: readonly string[]): Promise<void> {
  console.log(
    `[ceiling] speak thresholds over ${fixtures.join(", ")}; ` +
      `SPEAK_PAUSE_MS is currently ${SPEAK_PAUSE_MS}, margin ${SPEAK_MARGIN_MS} ms`,
  );
  const reaches: SpeakReach[] = [];
  for (const fixture of fixtures) {
    const script = loadScript(fixture);
    const planted = script.moments.filter((moment) =>
      (SPEAK_MOMENT_TYPES as readonly string[]).includes(moment.type),
    );
    if (planted.length === 0) {
      console.log(`[ceiling] ${fixture}: no planted open questions, skipped`);
      continue;
    }
    const turns = await replay(fixture);
    const ids = new Set(planted.map((moment) => moment.id));
    for (const moment of resolveMoments(fixture, turns).filter((one) => ids.has(one.id))) {
      const reach = speakReach(fixture, moment, turns);
      reaches.push(reach);
      if (reach.windowMs === null) {
        console.log(`  ${fixture}/${moment.id}: window unresolved — no turns matched its lines`);
        continue;
      }
      const ready = reach.silenceByReady
        .filter((entry) => entry.offsetMs > 0)
        .map((entry) => `+${seconds(entry.offsetMs)} ${Math.round(entry.bestSilenceMs)} ms`)
        .join(", ");
      console.log(
        `  ${fixture}/${moment.id}: window ${seconds(reach.windowMs.fromMs)}–` +
          `${seconds(reach.windowMs.untilMs)} ` +
          `(${seconds(reach.windowMs.untilMs - reach.windowMs.fromMs)}), ` +
          `longest quiet ${Math.round(reach.bestSilenceMs)} ms ` +
          `(margin at ${SPEAK_PAUSE_MS} ms: ` +
          `${Math.round(reach.bestSilenceMs - SPEAK_PAUSE_MS)} ms); once ready ${ready}`,
      );
    }
  }
  const largest = speakThresholdMs(reaches);
  console.log(
    `\n${reaches.length} planted open questions. Largest threshold leaving every one of ` +
      `them ${SPEAK_MARGIN_MS} ms of margin: ${
        largest === null ? "n/a" : `${Math.round(largest)} ms`
      }` +
      `${largest !== null && SPEAK_PAUSE_MS <= largest ? " — SPEAK_PAUSE_MS clears it" : ""}`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--speak")) {
    await speak(option("fixtures")?.split(",").filter(Boolean) ?? QUESTION_FIXTURES);
    return;
  }
  const fixtures = option("fixtures")?.split(",").filter(Boolean) ?? MOMENT_FIXTURES;
  const everyRaw = option("every");
  const everyTurns = everyRaw === undefined ? NEW_TURNS_PER_UPDATE : Number(everyRaw);
  if (!Number.isInteger(everyTurns) || everyTurns < 1) {
    console.error(`[ceiling] --every needs a whole number of turns, got ${everyRaw}`);
    process.exit(1);
  }

  console.log(
    `[ceiling] observer looks every ${everyTurns} final turn(s); ` +
      `PAUSE_MS is currently ${PAUSE_MS}`,
  );
  const reaches: MomentReach[] = [];
  for (const fixture of fixtures) {
    const script = loadScript(fixture);
    if (script.moments.length === 0) {
      console.log(`[ceiling] ${fixture}: no planted moments, skipped`);
      continue;
    }
    const turns = await replay(fixture);
    for (const moment of resolveMoments(fixture, turns)) {
      const reach = momentReach(fixture, moment, turns, everyTurns);
      reaches.push(reach);
      if (reach.windowMs === null) {
        console.log(`  ${fixture}/${moment.id}: window unresolved — no turns matched its lines`);
        continue;
      }
      const look =
        reach.lookAtMs === null
          ? "never (no look before the conversation ended)"
          : `${seconds(reach.lookAtMs)} (+${seconds(reach.lookDelayMs ?? 0)})`;
      console.log(
        `  ${fixture}/${moment.id}: window ${seconds(reach.windowMs.fromMs)}–` +
          `${seconds(reach.windowMs.untilMs)} ` +
          `(${seconds(reach.windowMs.untilMs - reach.windowMs.fromMs)}), ` +
          `look at ${look}, longest silence left ${Math.round(reach.bestSilenceMs)} ms`,
      );
    }
  }

  console.log(`\n${reaches.length} planted moments. Reachable by pause threshold:`);
  for (const row of ceilingTable(reaches)) {
    const mark = row.pauseMs === PAUSE_MS ? "  <- PAUSE_MS" : "";
    console.log(
      `  ${String(row.pauseMs).padStart(5)} ms: ${row.reachable}/${row.total}` +
        `  recall ceiling ${row.recallCeiling.toFixed(2)}${mark}`,
    );
  }
}

await main();
