/**
 * V3-002 against real Spark: what the room wonders aloud, read off the
 * captures. These calls live only in `test:integration`; no microphone, no
 * speakers and no live transcription — the frames come off disk.
 *
 * The four seconds the story is measured against are the seconds the room
 * waited: the classification starts when the turn goes final, so the whole
 * budget is the call's own wall-clock latency, which the timing line records.
 */
import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import { parseAsrFrameRecords } from "../../shared/asr.js";
import { TurnAssembler } from "../asr/turns.js";
import { SimulatedClock } from "../clock.js";
import { MuseClient } from "../model/client.js";
import { classifyQuestion, type OpenQuestion } from "./question.js";
import { QuestionWatcher } from "./QuestionWatcher.js";

loadDotenv({ quiet: true });
const apiKey = (process.env.MODEL_API_KEY ?? "").trim();
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const model = new MuseClient({ apiKey, logger: quiet });

/** The seconds the PRD gives a question between being said and being noticed. */
const BUDGET_MS = 4_000;

interface Replayed {
  questions: OpenQuestion[];
  timing: Record<string, unknown>[];
  /** Final turn text by turn id, for reading a verdict back to a sentence. */
  texts: Map<string, string>;
}

/** Replays a capture through the watcher, exactly as a session would. */
async function replay(fixture: string): Promise<Replayed> {
  const clock = new SimulatedClock(0);
  const questions: OpenQuestion[] = [];
  const timing: Record<string, unknown>[] = [];
  const texts = new Map<string, string>();
  const watcher = new QuestionWatcher({
    clock,
    classify: (input, signal) => classifyQuestion(model, input, signal),
    speakers: () => ({ A: "EJ", B: "Craig" }),
    onOpenQuestion: (question) => questions.push(question),
    onTiming: (record) => timing.push(record),
  });
  const assembler = new TurnAssembler({
    clock,
    startedAtMs: 0,
    logger: quiet,
    onUpdate: (turn) => {
      if (turn.final) texts.set(turn.turnId, turn.text.trim());
      watcher.acceptTurn(turn);
    },
  });
  for (const record of parseAsrFrameRecords(readFileSync(`fixtures/events/${fixture}.jsonl`, "utf8"))) {
    clock.advanceTo(record.atMs);
    assembler.accept(record);
    await clock.settle();
  }
  await watcher.flush();
  watcher.stop();
  for (const record of timing.filter((one) => one["stage"] === "question")) {
    console.log(
      `[question] ${fixture} ${record["kind"]} in ${Math.round(Number(record["latencyMs"]))} ms: ` +
        `${texts.get(String(record["turnId"]))}`,
    );
  }
  for (const question of questions) {
    console.log(`[question] ${fixture} open: ${question.question} (${question.topic})`);
  }
  return { questions, timing, texts };
}

/**
 * How long the conversation's classifications took, sorted.
 *
 * Gated on the median rather than the maximum, because the maximum is not the
 * classifier: the first call of a process pays the SDK's connection setup
 * (measured 5,855 ms against 1,152–3,900 for the eight that followed it in
 * `offsite-plan`), and low-effort Spark has a long tail — across four runs of
 * these four conversations one call in forty reached the 6 s deadline and was
 * logged as a `fallback`, which is the designed behaviour rather than a
 * failure. The PRD's four seconds are asserted where the PRD asserts them: on
 * the question itself.
 */
function latencies(fixture: string, timing: readonly Record<string, unknown>[]): number[] {
  const fallbacks = timing.filter((one) => one["fallback"] === true).length;
  const spent = timing
    .filter((one) => one["stage"] === "question")
    .map((one) => Number(one["latencyMs"]));
  const sorted = [...spent].sort((a, b) => a - b);
  console.log(
    `[question] ${fixture}: ${spent.length} calls, median ` +
      `${Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0)} ms, max ` +
      `${Math.round(sorted.at(-1) ?? 0)} ms, ${fallbacks} timed out`,
  );
  return sorted;
}

/** The median call, which is what a room would feel question after question. */
function median(sorted: readonly number[]): number {
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe.skipIf(apiKey === "")("V3-002 real question classification", () => {
  it("notices the drive-time question in offsite-plan, inside four seconds", async () => {
    const { questions, timing, texts } = await replay("offsite-plan");
    const drive = questions.find((one) => /hour|drive|half/i.test(one.question));
    expect(drive, `open questions: ${questions.map((one) => one.question).join(" | ")}`)
      .toBeDefined();
    // The turn it came from is the one the group doubted the drive in.
    expect(texts.get(drive?.turnId ?? "")).toMatch(/hour and a half/i);
    expect(drive?.topic).not.toBe("");
    const spent = Number(
      timing.find((one) => one["stage"] === "question" && one["turnId"] === drive?.turnId)?.[
        "latencyMs"
      ],
    );
    console.log(`[question] offsite-plan drive time noticed in ${Math.round(spent)} ms`);
    expect(spent).toBeLessThanOrEqual(BUDGET_MS);
    // And the conversation's classifications as a whole are inside it.
    expect(median(latencies("offsite-plan", timing))).toBeLessThanOrEqual(BUDGET_MS);
    // The questions only the group can answer are not Sotto's to look up.
    const asked = questions.map((one) => one.question.toLowerCase()).join(" | ");
    expect(asked).not.toMatch(/food|projector|adapter/);
  }, 10 * 60_000);

  it("finds exactly the one real question in rhetorical-questions", async () => {
    const { questions, timing } = await replay("rhetorical-questions");
    expect(questions.map((one) => one.question)).toHaveLength(1);
    expect(questions[0]?.question.toLowerCase()).toMatch(/loom/);
    expect(questions[0]?.topic).not.toBe("");
    expect(median(latencies("rhetorical-questions", timing))).toBeLessThanOrEqual(BUDGET_MS);
  }, 10 * 60_000);

  it.each(["brainstorm", "no-wake"])("finds nothing to look up in %s", async (fixture) => {
    const { questions, timing } = await replay(fixture);
    expect(questions.map((one) => one.question)).toEqual([]);
    expect(median(latencies(fixture, timing))).toBeLessThanOrEqual(BUDGET_MS);
  }, 10 * 60_000);
});
