/**
 * V2-008 measures where first-sentence latency goes without changing delivery.
 * Raw Responses events are observed only in this integration harness: search
 * intervals are client-observed, not claims about the provider's internal work.
 */
import OpenAI from "openai";
import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import { emptyBoard } from "../../shared/board.js";
import type { AnswerLogRecord } from "../../shared/answers.js";
import { systemClock } from "../clock.js";
import { MODEL_BASE_URL, MuseClient } from "../model/client.js";
import { AnswerAgent } from "./AnswerAgent.js";

loadDotenv({ quiet: true });
const apiKey = (process.env.MODEL_API_KEY ?? "").trim();
const quiet = { log: () => {}, warn: () => {} };

describe.skipIf(apiKey === "")("V2-008 first-sentence latency measurement", () => {
  it.each([
    "Give me the full bull and bear case for the upcoming Anthropic IPO.",
    "What did we decide about the budget, and why?",
  ])("measures search and generation for %s", async (question) => {
    const sdk = new OpenAI({ apiKey, baseURL: MODEL_BASE_URL });
    const started = systemClock.now();
    const elapsed = (): number => Math.round(systemClock.now() - started);
    const searches = new Map<string, { start: number; end: number | null }>();
    let firstTextMs: number | null = null;
    let firstSentenceMs: number | null = null;
    const model = new MuseClient({
      apiKey, logger: quiet,
      streamingResponses: {
        create: async (body) => {
          const stream = await sdk.responses.create(body);
          return (async function* () {
            for await (const event of stream) {
              if (event.type === "response.web_search_call.in_progress") {
                searches.set(event.item_id, { start: elapsed(), end: null });
              } else if (event.type === "response.web_search_call.completed") {
                const search = searches.get(event.item_id);
                if (search !== undefined) search.end = elapsed();
              } else if (event.type === "response.output_text.delta" && event.item_id.startsWith("msg_")) {
                firstTextMs ??= elapsed();
              }
              yield event;
            }
          })();
        },
      },
    });
    const answers: AnswerLogRecord[] = [];
    const agent = new AnswerAgent({
      clock: systemClock, model, logger: quiet,
      board: () => emptyBoard(), speakers: () => ({ A: "Craig" }),
      transcript: () => [{
        turnId: "0:0", speaker: "A", final: true, startMs: 0, endMs: 10_000,
        speakerMappingUncertain: false,
        text: "We decided on a five thousand dollar budget because that covers the venue and catering.",
      }],
      onCard: (_card, answer) => {
        if (answer.spokenText !== "") firstSentenceMs ??= elapsed();
      },
      onRecord: (answer) => answers.push(answer),
    });
    agent.ask({ question, askedBy: "A", turnId: "0:1" });
    await agent.flush();
    const intervals = [...searches.values()];
    console.log(`[answer latency] ${JSON.stringify({
      question, firstTextMs, firstSentenceMs, completedMs: elapsed(), searches: intervals,
      summedSearchMs: intervals.reduce((sum, item) => sum + (item.end ?? item.start) - item.start, 0),
      spokenWords: answers[0]?.spokenText.split(/\s+/).length,
    })}`);
    expect(answers[0]?.status, answers[0]?.error).toBe("done");
    expect(firstSentenceMs).not.toBeNull();
    expect(answers[0]?.spokenText.toLowerCase()).not.toMatch(/^.{0,30}the short version/);
  }, 120_000);
});
