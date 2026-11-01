import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAsrFrameRecords } from "../../shared/asr.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { TurnAssembler } from "../asr/turns.js";
import { isQuestionShaped } from "./questionShape.js";

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/** The final turn texts a capture really produced, punctuation and all. */
function finals(fixture: string): string[] {
  const texts: string[] = [];
  const assembler = new TurnAssembler({
    startedAtMs: 0,
    logger: quiet,
    onUpdate: (turn: TurnUpdate) => {
      if (turn.final) texts.push(turn.text);
    },
  });
  for (const record of parseAsrFrameRecords(
    readFileSync(`fixtures/events/${fixture}.jsonl`, "utf8"),
  )) {
    assembler.accept(record);
  }
  return texts;
}

/**
 * Turns the classifier has to be given a chance at: every question in the
 * fixtures that a lookup could answer, verbatim from the captures.
 */
const openQuestions: string[] = [
  // `offsite-plan`: the drive time, which V3-002's integration test measures.
  " Is it an hour and a half? I might be remembering summer traffic. ",
  // The same fixture's other half of the venue hook — a question with the
  // question taken off the front.
  " And I have no idea whether they have a Thursday free this month. ",
  // `research-business-idea`: a market size somebody half remembers.
  " Two billion where does that number come from? ",
  " And who's funded? If somebody raised 30 million last year that changes the plan ",
  // `moment-contradiction`: a price.
  " And how much are we talking for that? ",
  // Shapes the captures do not happen to contain but a room certainly says.
  "What does Loom actually charge per seat these days?",
  "Does anyone know how big the UK market for this is?",
  "I wonder how long that drive actually takes",
  "how many people does the farmhouse hold",
  "we'd need to check what the licence allows",
];

/** Statements that must cost nothing, verbatim from the captures. */
const statements: string[] = [
  " I think we start with the core loop. You photograph what's in your fridge and we suggest three things you could actually cook tonight. ",
  " Right and the suggestions have to respect what you don't have not just what you do. ",
  " So point one suggestions are limited to what's on hand plus a short pantry list we assume everyone has. ",
  " Fourth, a shopping nudge not a full grocery list just your one ingredient away from three more meals ",
  " Which leaves Wednesday and Thursday. And Wednesday the board call is that morning. ",
  " And then the drive home in the dark. Which nobody loves. ",
  " He waited for the fork to go down. That was the whole signal. ",
  " Works for me. ",
];

describe("isQuestionShaped", () => {
  it.each(openQuestions)("passes %j", (text) => {
    expect(isQuestionShaped(text)).toBe(true);
  });

  it.each(statements)("rejects %j", (text) => {
    expect(isQuestionShaped(text)).toBe(false);
  });

  /**
   * V3-002's budget: no more than about a quarter of `brainstorm`'s turns may
   * reach the model. Measured here rather than asserted from the scripts,
   * because the transcription is what the filter actually reads.
   */
  it("sends about a tenth of brainstorm's turns to the model", () => {
    const turns = finals("brainstorm");
    const shaped = turns.filter(isQuestionShaped);
    expect(turns.length).toBe(24);
    expect(shaped.length / turns.length).toBeLessThanOrEqual(0.25);
    // The two it does pass are the ones a person would call questions.
    expect(shaped).toHaveLength(2);
  });

  it("passes every lookup question the fixtures contain", () => {
    for (const fixture of ["offsite-plan", "research-business-idea", "moment-contradiction"]) {
      const shaped = finals(fixture).filter(isQuestionShaped);
      for (const question of openQuestions.filter((text) =>
        finals(fixture).includes(text),
      )) {
        expect(shaped, `${fixture}: ${question}`).toContain(question);
      }
    }
  });

  /**
   * The other captures are not gated by the PRD, but a filter that quietly
   * started passing everything would be the expensive kind of regression. The
   * bound is per conversation because the conversations differ in kind:
   * `research-business-idea` is mostly questions, and
   * `rhetorical-questions` is nothing but, which is what it is for.
   */
  it.each([
    ["brainstorm", 0.25], ["no-wake", 0.2], ["offsite-plan", 0.3],
    ["ask-search", 0.1], ["ask-diagram", 0.1],
    ["moment-assumption", 0.3], ["moment-contradiction", 0.25], ["moment-dropped", 0.15],
    ["moment-fact", 0.1], ["moment-mixed", 0.25],
    ["research-business-idea", 0.35], ["rhetorical-questions", 0.45],
  ])("sends no more than its share of %s's turns to the model", (fixture, most) => {
    const turns = finals(fixture);
    const share = turns.filter(isQuestionShaped).length / turns.length;
    expect(share, `${fixture}: ${Math.round(share * 100)}%`).toBeLessThanOrEqual(most);
  });
});
