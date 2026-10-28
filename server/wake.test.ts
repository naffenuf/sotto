import { describe, expect, it } from "vitest";
import { DEFAULT_WAKE_SPELLINGS, detect } from "./wake.js";

/**
 * Sentences that are Sotto being addressed, with the question each should
 * yield. The first two are verbatim from the captures
 * (`fixtures/events/NOTES.md`): `ask-search` lost both the comma and the
 * question mark on the way through the transcription model, which is why
 * punctuation cannot be required.
 */
const positives: [sentence: string, question: string][] = [
  [
    " Sotto what do the main competitors charge per month. ",
    "what do the main competitors charge per month.",
  ],
  [
    " Sotto, can you sketch the user flow we just described as a diagram? ",
    "can you sketch the user flow we just described as a diagram?",
  ],
  ["Sotto, what did we decide about pricing?", "what did we decide about pricing?"],
  ["Hey Sotto, summarise the board.", "summarise the board."],
  ["Okay Sotto — how many of these are blocked?", "how many of these are blocked?"],
  ["ok sotto, pull up the churn numbers", "pull up the churn numbers"],
  ["So that settles it. Soto, is anyone still against this?", "is anyone still against this?"],
  ["Sota, who owns the digest copy?", "who owns the digest copy?"],
  ["Right, let's move on. Hey Sotto, when did Instagram launch?", "when did Instagram launch?"],
  ["SOTTO, WHAT IS THE BUDGET?", "WHAT IS THE BUDGET?"],
];

/**
 * Sentences that must not fire. The first four are the look-alikes the
 * `no-wake` capture actually produced, transcription and all.
 */
const negatives: string[] = [
  " Exactly. Sotto voce, if you want to be fancy about it. ",
  " We should keep the whole thing quiet, so to speak. The app shouldn't be shouting at you. ",
  " And when it does speak it should have something worth saying so to speak. ",
  " so to speak ",
  " Huh, my uncle ran a place called Soto's Restaurant and he had one rule, never interrupt a table that's enjoying itself. ",
  "Soto's restaurant had the right idea.",
  "We agreed the tone should be sotto voce throughout.",
  "The plan is to go so to market in two weeks.",
  "I think Soto would hate this.",
  " Sotto ",
  "Sotto voce.",
  "Juan Soto signed with the Mets.",
  // A sentence *about* Sotto, which is what a group building it says all day.
  "Sotto is being too chatty today.",
  "Sotto should stay quiet during the demo.",
];

describe("detect", () => {
  it.each(positives)("fires on %j", (sentence, question) => {
    expect(detect(sentence)).toEqual({ triggered: true, question });
  });

  it.each(negatives)("stays quiet on %j", (sentence) => {
    expect(detect(sentence)).toEqual({ triggered: false, question: null });
  });

  it("reads a question from the words when the transcription loses the punctuation", () => {
    // Only the interrogatives do this. An auxiliary needs the comma or the
    // mark, because "Sotto is …" is far more often a sentence about Sotto.
    expect(detect("Sotto how long is the demo slot").triggered).toBe(true);
    expect(detect("Sotto is the demo slot long enough").triggered).toBe(false);
    expect(detect("Sotto is the demo slot long enough?").triggered).toBe(true);
    expect(detect("Sotto, is the demo slot long enough").triggered).toBe(true);
  });

  it("takes the first occurrence that is really an address", () => {
    expect(
      detect("Soto's restaurant, he said. Sotto, what was his one rule?"),
    ).toEqual({ triggered: true, question: "what was his one rule?" });
  });

  it("needs something to answer, so a partial up to the name does not fire", () => {
    // Every wake turn passes through this state on its way to a question.
    for (const partial of [" Sotto", " Sotto,", " Hey Sotto, "]) {
      expect(detect(partial).triggered).toBe(false);
    }
  });

  it("takes the spellings it is given", () => {
    expect(detect("Jarvis, what time is it?").triggered).toBe(false);
    expect(detect("Jarvis, what time is it?", { spellings: ["jarvis"] })).toEqual({
      triggered: true,
      question: "what time is it?",
    });
    // And the defaults stop being wake words when they are not in the list.
    expect(detect("Sotto, what time is it?", { spellings: ["jarvis"] }).triggered).toBe(false);
  });

  it("defaults to the spellings the transcription model produces", () => {
    expect(DEFAULT_WAKE_SPELLINGS).toEqual(["sotto", "soto", "sota"]);
  });
});
