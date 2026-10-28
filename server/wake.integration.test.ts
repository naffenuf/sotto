/**
 * Wake-phrase detection against every captured conversation (PRD US-017).
 *
 * This is an integration test in the sense the story means — the whole
 * capture, replayed at `max` through the real assembler and the real
 * watcher, rather than sentences handed to {@link detect} — but it calls no
 * API and costs nothing: the frames come off disk, and `server/wake.ts` has
 * no model in it.
 *
 * What it is really measuring is the gap between the script and the
 * transcription. `ask-search` was *scripted* as
 * `Sotto, what do the main competitors charge per month?` and came back
 * without the comma or the question mark, and `no-wake` is a conversation
 * written to say "sotto voce", "so to speak" and "Soto's Restaurant" out
 * loud. One trigger and no trigger respectively, from the words as they were
 * actually heard.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAsrFrameRecords } from "../shared/asr.js";
import type { ServerEvent } from "../shared/events.js";
import { TurnAssembler } from "./asr/turns.js";
import { SimulatedClock } from "./clock.js";
import { EventBus } from "./events/bus.js";
import { SessionManager } from "./session/SessionManager.js";
import { WakeWatcher, type WakeTrigger } from "./wakeWatcher.js";

const eventsDir = join(process.cwd(), "fixtures", "events");

/** Every capture, so a fixture added later is covered the moment it lands. */
const captures = readdirSync(eventsDir)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => name.replace(/\.jsonl$/, ""))
  .sort();

/** How many triggers each capture should produce. The wake fixtures ask once. */
const expected: Record<string, number> = {
  "ask-diagram": 1,
  "ask-search": 1,
};

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/**
 * Replays one capture at `max` — the clock is set to each frame's recorded
 * arrival time and no real time passes — and returns what the watcher made
 * of it.
 */
function replay(fixture: string): { questions: WakeTrigger[]; listening: boolean[] } {
  const clock = new SimulatedClock(0);
  const questions: WakeTrigger[] = [];
  const listening: boolean[] = [];
  const watcher = new WakeWatcher({
    onListening: (value) => listening.push(value),
    onQuestion: (trigger) => questions.push(trigger),
  });
  const assembler = new TurnAssembler({
    clock,
    startedAtMs: 0,
    logger: quiet,
    onUpdate: (turn) => watcher.acceptTurn(turn),
  });
  for (const record of parseAsrFrameRecords(
    readFileSync(join(eventsDir, `${fixture}.jsonl`), "utf8"),
  )) {
    clock.advanceTo(record.atMs);
    assembler.accept(record);
  }
  return { questions, listening };
}

describe("wake phrases in the captures", () => {
  it.each(captures)("%s triggers the expected number of times", (fixture) => {
    const { questions } = replay(fixture);
    expect(questions.map((one) => one.question)).toHaveLength(expected[fixture] ?? 0);
  });

  it("pulls the scripted question out of ask-search, punctuation and all", () => {
    const { questions } = replay("ask-search");
    expect(questions).toEqual([
      {
        turnId: questions[0]?.turnId,
        speaker: expect.any(String) as unknown as string,
        question: "what do the main competitors charge per month.",
      },
    ]);
  });

  it("raises the indicator before the question is finished, and drops it after", () => {
    const { listening } = replay("ask-search");
    // Up once while the turn is still a partial, down when it goes final.
    expect(listening).toEqual([true, false]);
  });

  it("is not fooled by sotto voce, so to speak, or Soto's Restaurant", () => {
    const { questions, listening } = replay("no-wake");
    expect(questions).toEqual([]);
    expect(listening).toEqual([]);
  });

  it("publishes the indicator to the browser when a session replays the capture", async () => {
    const bus = new EventBus(quiet);
    const seen: ServerEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    // No model client and no session folder: the indicator and the courtesy
    // hook are not model work, so this path has to run without either.
    const sessions = new SessionManager({
      bus,
      logger: quiet,
      createStore: () => null,
      createModel: () => null,
      replaySpeed: "max",
    });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });

    sessions.start({ kind: "events", fixture: "ask-search" });
    await ended;

    expect(seen.filter((event) => event.type === "wake")).toEqual([
      { type: "wake", listening: true },
      { type: "wake", listening: false },
    ]);
  });
});
