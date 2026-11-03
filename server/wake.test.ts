import { describe, expect, it } from "vitest";
import { DEFAULT_WAKE_SPELLINGS, detect, detectsAddress, normalizeWakeSpelling, questionAfterName } from "./wake.js";

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

  it("reads an auxiliary after the name only when asked to, for the fallback", () => {
    const asked = "Sotto did you look up any of the things we were talking about";
    expect(detect(asked).triggered).toBe(false);
    expect(detect(asked, { looseQuestions: true })).toEqual({
      triggered: true,
      question: "did you look up any of the things we were talking about",
    });
    // Talking about Sotto is still not asking it, loose or not.
    expect(detect("Sotto is being too chatty", { looseQuestions: true }).triggered).toBe(false);
    expect(detect("Sotto should stay quiet", { looseQuestions: true }).triggered).toBe(false);
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

  it("catches the `Sato` the research-business-idea capture produced", () => {
    expect(detect(" Sato, what did you find on competitors? ")).toEqual({
      triggered: true,
      question: "what did you find on competitors?",
    });
  });

  it("defaults to the spellings the transcription model produces", () => {
    expect(DEFAULT_WAKE_SPELLINGS).toEqual(["sotto", "soto", "sato", "sota", "sado", "sana"]);
  });
});

/**
 * V2-008b reads the question off the final text when an early classification
 * is reused, so this has to work on text {@link detect} would reject.
 */
describe("reading the question off the name, loosely", () => {
  it("takes everything after the name, with the separator removed", () => {
    expect(questionAfterName(" Sato, what did you find on competitors? "))
      .toBe("what did you find on competitors?");
    expect(questionAfterName(" Sotto what do the main competitors charge per month. "))
      .toBe("what do the main competitors charge per month.");
  });

  it("reads a name mid-sentence, which the strict rules refuse", () => {
    const text = "I was wondering Soto can you give me the bull case";
    expect(detect(text).triggered).toBe(false);
    expect(questionAfterName(text)).toBe("can you give me the bull case");
  });

  it("looks past a possessive and sotto voce to a real address behind them", () => {
    expect(questionAfterName("Soto's place — Sotto, what was his rule?"))
      .toBe("what was his rule?");
    expect(questionAfterName("Sotto voce. Sotto, how long have we got?"))
      .toBe("how long have we got?");
  });

  it("is empty when there is no name, and when nothing follows it", () => {
    expect(questionAfterName("what do rivals charge")).toBe("");
    expect(questionAfterName(" Sotto, ")).toBe("");
  });
});

/**
 * The checkpoint session (`2026-11-01_1928-mic`): "Sotto, where are we at"
 * came back as two words and "Sotto, wrap us up" as `Sado`, and neither was
 * heard. The transcript should also read `Sotto` wherever the name was used
 * as an address, whatever the API spelled.
 */
describe("the name heard as two words, and the transcript's spelling of it", () => {
  it("folds a sentence-initial 'so to' into the name", () => {
    expect(detect(" So to where where are we at at this point? ")).toEqual({
      triggered: true,
      question: "where where are we at at this point?",
    });
    expect(detect("Okay so to, what did we decide?").triggered).toBe(true);
    expect(detectsAddress(" So to where are we at ")).toBe(true);
    // Mid-sentence it is two ordinary words.
    expect(detect("That's the plan, so to speak, what next?").triggered).toBe(false);
    expect(detectsAddress("we agreed, so to speak")).toBe(false);
  });

  it("accepts the spellings the checkpoint produced", () => {
    expect(detect("Sado, wrap us up").triggered).toBe(true);
    expect(detect("Sana, what time is it?").triggered).toBe(true);
  });

  it("rewrites an address to Sotto and leaves everything else as said", () => {
    expect(normalizeWakeSpelling(" Soto? Where are we at at this point? ")).toBe(" Sotto? Where are we at at this point? ");
    expect(normalizeWakeSpelling("Sado, wrap us up.")).toBe("Sotto, wrap us up.");
    expect(normalizeWakeSpelling(" So to where where are we at ")).toBe(" Sotto where where are we at ");
    expect(normalizeWakeSpelling("hey Sato remind us what we decided")).toBe("hey Sotto remind us what we decided");
    expect(normalizeWakeSpelling("Soto not now. Did you hear back?")).toBe("Sotto not now. Did you hear back?");
    // Not addresses: a restaurant, a report of an earlier answer, sotto voce,
    // and "so to speak", which has no question after it.
    for (const text of [
      "we should go to Soto's after this",
      "I asked Soto earlier and it said the venue holds forty",
      "Exactly. Sotto voce, if you want to be fancy about it.",
      "So to speak, that is the whole plan.",
      "Can you stop Sana?",
    ]) {
      expect(normalizeWakeSpelling(text), text).toBe(text);
    }
  });
});
