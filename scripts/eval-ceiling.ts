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
 */
import { EventReplaySource } from "../server/asr/EventReplaySource.js";
import { TurnAssembler } from "../server/asr/turns.js";
import { SimulatedClock } from "../server/clock.js";
import { NEW_TURNS_PER_UPDATE } from "../server/board/BoardUpdater.js";
import {
  CEILING_THRESHOLDS_MS,
  ceilingTable,
  momentReach,
  type MomentReach,
} from "../server/eval/ceiling.js";
import { loadScript, resolveMoments } from "../server/eval/moments.js";
import { PAUSE_MS } from "../server/interject/policy.js";
import type { TurnUpdate } from "../shared/turns.js";

/** Every fixture that has something planted in it, in script order. */
const MOMENT_FIXTURES = [
  "moment-contradiction",
  "moment-fact",
  "moment-assumption",
  "moment-dropped",
  "moment-mixed",
];

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

async function main(): Promise<void> {
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
