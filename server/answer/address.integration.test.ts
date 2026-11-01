/**
 * V2-008 rechecks the human checkpoint's fifteen addresses against real Spark,
 * then runs captured speech through the classifier and the session wiring.
 * These calls live only in test:integration; no microphone or speakers are used.
 */
import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import type { TurnUpdate } from "../../shared/turns.js";
import { parseAsrFrameRecords } from "../../shared/asr.js";
import { TurnAssembler } from "../asr/turns.js";
import { SimulatedClock, systemClock } from "../clock.js";
import { EventBus } from "../events/bus.js";
import { MuseClient } from "../model/client.js";
import { SessionManager } from "../session/SessionManager.js";
import { AddressWatcher } from "./AddressWatcher.js";
import { classifyAddress } from "./address.js";

loadDotenv({ quiet: true });
const apiKey = (process.env.MODEL_API_KEY ?? "").trim();
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const model = new MuseClient({ apiKey, logger: quiet });

/** The checkpoint's exact cases, not model-generated variants. */
const cases = [
  {
    "before": "",
    "text": "Hi, I'm Craig… it's a Saturday so the stock market is closed but I was wondering " +
      "Soto can you tell me the bull case and the bear case for the upcoming anthropic IPO",
    "want": "request"
  },
  {
    "before": "",
    "text": "Soto",
    "want": "name_only"
  },
  {
    "before": "Craig: Soto",
    "text": "can you tell me the bull and bear case for the upcoming anthropic IPO",
    "want": "request"
  },
  {
    "before": "",
    "text": "oh Soto you're not doing well",
    "want": "mention"
  },
  {
    "before": "",
    "text": "honestly I think Sotto is being way too chatty today",
    "want": "mention"
  },
  {
    "before": "",
    "text": "we should go to Soto's after this the tacos are great",
    "want": "mention"
  },
  {
    "before": "",
    "text": "Exactly. Sotto voce if you want to be fancy about it",
    "want": "mention"
  },
  {
    "before": "",
    "text": "Sotto what do the main competitors charge per month",
    "want": "request"
  },
  {
    "before": "",
    "text": "hey Sato remind us what we decided about the budget",
    "want": "request"
  },
  {
    "before": "",
    "text": "I asked Soto earlier and it said the venue holds forty",
    "want": "mention"
  },
  {
    "before": "",
    "text": "Soto could you pull up the drive time to the lake house",
    "want": "request"
  },
  {
    "before": "",
    "text": "ok so Sotto flagged the caterer thing which was useful",
    "want": "mention"
  },
  {
    "before": "",
    "text": "Soto is right though we can't afford six gardens",
    "want": "mention"
  },
  {
    "before": "EJ: Soto",
    "text": "never mind",
    "want": "mention"
  },
  {
    "before": "",
    "text": "thanks Soto that was helpful can you also check the weather for Saturday",
    "want": "request"
  }
];

function turn(text: string, id = "0:1", speaker = "A"): TurnUpdate {
  return { turnId: id, speaker, text, final: true, startMs: 0, endMs: 100,
    speakerMappingUncertain: false };
}

describe.skipIf(apiKey === "")("V2-008 real address classification", () => {
  it.each(cases)("$want: $text", async ({ before, text, want }) => {
    const started = systemClock.now();
    const previous = before === "" ? [] : [turn(before.replace(/^[^:]+: /, ""), "0:0")];
    const result = await classifyAddress(model, {
      turn: turn(text), previous, speakers: { A: before.startsWith("EJ:") ? "EJ" : "Craig" },
    });
    console.log(`[address] ${want} ${Math.round(systemClock.now() - started)} ms: ${result.kind}`);
    expect(result.kind).toBe(want);
    if (want === "request") expect(result.question.trim()).not.toBe("");
    else expect(result.question).toBe("");
  });

  it.each([
    ["no-wake", 0], ["ask-search", 1], ["ask-diagram", 1],
    ["research-business-idea", 1], ["offsite-plan", 1],
  ] as const)("classifies the %s capture without fallback", async (fixture, expected) => {
    const clock = new SimulatedClock();
    const questions: string[] = [];
    const timing: Record<string, unknown>[] = [];
    const watcher = new AddressWatcher({
      clock,
      classify: (input, signal) => classifyAddress(model, input, signal),
      speakers: () => ({}),
      onListening: () => {},
      onQuestion: (question) => questions.push(question.question),
      onTiming: (event) => timing.push(event),
    });
    const assembler = new TurnAssembler({ clock, startedAtMs: 0, logger: quiet,
      onUpdate: (update) => watcher.acceptTurn(update) });
    for (const record of parseAsrFrameRecords(readFileSync(`fixtures/events/${fixture}.jsonl`, "utf8"))) {
      clock.advanceTo(record.atMs);
      assembler.accept(record);
      await clock.settle();
    }
    await watcher.flush();
    watcher.stop();
    // V2-008b: how much of the check the room never waited for. `waitedMs` is
    // what the final turn still had to wait for the early answer, so a small
    // number there is the whole point of the story.
    for (const event of timing.filter((one) => one.stage === "address_early")) {
      console.log(`[address early] ${fixture}: ${JSON.stringify(event)}`);
    }
    console.log(`[address capture] ${fixture}: ${questions.length} requests: ${questions.join(" | ")}`);
    expect(questions).toHaveLength(expected);
    expect(timing.filter((event) => event.stage === "address_fallback")).toEqual([]);
    // A reused verdict must not cost the question its last words.
    if (fixture === "ask-search") expect(questions[0]).toContain("per month");
  });

  it("produces zero answers in a real-model no-wake session", async () => {
    const bus = new EventBus(quiet);
    const answerCards: unknown[] = [];
    const errors: unknown[] = [];
    bus.subscribe((event) => {
      if (event.type === "card" && event.card.variant === "answer") answerCards.push(event.card);
      if (event.type === "status" && event.status.state === "error") errors.push(event.status);
    });
    const sessions = new SessionManager({
      bus, apiKey, logger: quiet, replaySpeed: "max", createStore: () => null,
    });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "no-wake" });
    await ended;
    expect(bus.snapshot().filter((event) => event.type === "status" &&
      event.status.channel === "transcription" && event.status.state === "error")).toEqual([]);
    expect(answerCards).toEqual([]);
    expect(errors).toEqual([]);
  }, 10 * 60_000);
});
