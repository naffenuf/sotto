/**
 * V3-006 against real Spark: the command classifier has to tell "stop this
 * one thing" from "contribute less from now on", because the two lead to
 * different places — one cancellation, or a setting that lasts the rest of
 * the meeting. Spelled the way the captures spell things: no punctuation is
 * guaranteed, and `Soto` is as likely a transcription as `Sotto`.
 */
import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import { MuseClient } from "../model/client.js";
import { classifyCommand } from "./command.js";

loadDotenv({ quiet: true });
const apiKey = (process.env.MODEL_API_KEY ?? "").trim();
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const model = new MuseClient({ apiKey, logger: quiet });

const cases = [
  { text: "Sotto, not now", want: "quieter" },
  { text: "Soto that's too much", want: "quieter" },
  { text: "Sotto you're talking too much, let us work", want: "quieter" },
  { text: "Sotto you can jump in more", want: "louder" },
  { text: "Soto don't be shy, chime in whenever you like", want: "louder" },
  { text: "Sotto, stop", want: "stop" },
  { text: "thanks Soto", want: "stop" },
  { text: "Sotto go on", want: "continue" },
  { text: "Sotto what do the main competitors charge per month", want: "new_question" },
] as const;

describe.skipIf(apiKey === "")("the command classifier, on real Spark", () => {
  it.each(cases)("reads $text as $want", async ({ text, want }) => {
    const reply = await classifyCommand(model, text);
    expect(reply.command).toBe(want);
    // Only a request carries words; everything else is the command alone.
    if (want === "new_question") expect(reply.question).not.toBe("");
    else expect(reply.question).toBe("");
  }, 60_000);
});
