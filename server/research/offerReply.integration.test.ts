/**
 * V3-005 against real Spark: Sotto has just offered a finding as a
 * statement, and the next thing anybody says either takes it up or does not.
 *
 * The hard cases are the ones that *sound* like a yes. "Yeah, and the
 * deposit's due Friday" is agreement with a colleague, and reading research
 * out over it is exactly the interruption the statement form exists to
 * avoid — so an offline rule on "yeah" would be wrong about half of these.
 * Spelled the way the captures spell things: punctuation is never guaranteed.
 */
import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import type { TurnUpdate } from "../../shared/turns.js";
import { MuseClient } from "../model/client.js";
import { classifyOfferReply } from "./offerReply.js";

loadDotenv({ quiet: true });
const apiKey = (process.env.MODEL_API_KEY ?? "").trim();
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const model = new MuseClient({ apiKey, logger: quiet });

const offer = {
  topic: "comparable venue prices",
  title: "Comparable launch venues charge £40–60 a head",
  spokenText: "There's a quick rundown on comparable venue prices on screen if you want it.",
};

/** Two people picking a venue, which is what every reply below is said into. */
const previous: TurnUpdate[] = [
  {
    turnId: "0:7", speaker: "A", speakerMappingUncertain: false, final: true,
    startMs: 0, endMs: 4_000,
    text: " I think the warehouse one is the only room big enough. ",
  },
  {
    turnId: "0:8", speaker: "B", speakerMappingUncertain: false, final: true,
    startMs: 5_000, endMs: 9_000,
    text: " It is, but nobody has said what it costs us per person. ",
  },
];

function reply(text: string): TurnUpdate {
  return {
    turnId: "0:9", speaker: "B", speakerMappingUncertain: false, final: true,
    startMs: 12_000, endMs: 14_000, text,
  };
}

const cases = [
  { text: " Yeah go on then ", want: "yes" },
  { text: " Sure, what did it say ", want: "yes" },
  { text: " Go ahead, read it out ", want: "yes" },
  { text: " Not now, let's finish the room first ", want: "no" },
  { text: " Maybe later ", want: "no" },
  { text: " Yeah, and the deposit is due on the Friday ", want: "unrelated" },
  { text: " Right, so who is actually booking it ", want: "unrelated" },
  { text: " I'd still rather do it on the Thursday ", want: "unrelated" },
] as const;

describe.skipIf(apiKey === "")("the offer reply classifier, on real Spark", () => {
  it.each(cases)("reads $text as $want", async ({ text, want }) => {
    const verdict = await classifyOfferReply(model, {
      turn: reply(text),
      previous,
      speakers: { A: "Craig", B: "EJ" },
      offer,
    });
    expect(verdict.kind).toBe(want);
  }, 60_000);
});
