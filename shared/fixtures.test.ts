import { describe, expect, it } from "vitest";
import { FixtureScriptSchema } from "./fixtures.js";

const line = (speaker: "A" | "B", text: string) => ({ speaker, text, pauseAfterMs: 500 });

const lines = [
  line("A", "The budget is under five thousand."),
  line("B", "Noted."),
  line("A", "Let's hire the twenty thousand dollar agency."),
  line("B", "Sure."),
];

const moment = {
  id: "budget-contradiction",
  type: "contradiction" as const,
  setupLines: [0],
  triggerLine: 2,
  deadlineLine: 3,
  expectedLevel: "interject" as const,
  description: "A said under $5K at line 0, then proposes a $20K agency at line 2.",
};

const messages = (result: ReturnType<typeof FixtureScriptSchema.safeParse>) =>
  result.success ? [] : result.error.issues.map((issue) => issue.message);

describe("FixtureScriptSchema", () => {
  it("accepts a script with a moment and defaults the optional arrays", () => {
    const result = FixtureScriptSchema.safeParse({ lines, moments: [moment] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.wakeQuestions).toEqual([]);
      expect(result.data.followUpLines).toEqual([]);
      expect(result.data.moments).toHaveLength(1);
    }
  });

  // V3-014: the lines Sotto may answer are the wake questions plus these, so
  // one that does not exist would quietly widen what the eval allows.
  it("rejects a follow-up line that does not exist", () => {
    const result = FixtureScriptSchema.safeParse({ lines, followUpLines: [1, 9] });
    expect(messages(result)).toContainEqual(expect.stringContaining("line 9 does not exist"));
  });

  it("rejects a follow-up line that already says Sotto's name", () => {
    const result = FixtureScriptSchema.safeParse({
      lines,
      wakeQuestions: [{ line: 2, question: "what now?" }],
      followUpLines: [2],
    });
    expect(messages(result)).toContainEqual(
      expect.stringContaining("already addresses Sotto by name"),
    );
  });

  it("rejects line indexes that do not exist", () => {
    const result = FixtureScriptSchema.safeParse({
      lines,
      wakeQuestions: [{ line: 9, question: "what now?" }],
    });
    expect(messages(result)).toContainEqual(expect.stringContaining("line 9 does not exist"));
  });

  it("rejects a setup line at or after the trigger line", () => {
    const result = FixtureScriptSchema.safeParse({
      lines,
      moments: [{ ...moment, setupLines: [2] }],
    });
    expect(messages(result)).toContainEqual(expect.stringContaining("must come before triggerLine"));
  });

  it("rejects a deadline before the trigger line", () => {
    const result = FixtureScriptSchema.safeParse({
      lines,
      moments: [{ ...moment, deadlineLine: 1 }],
    });
    expect(messages(result)).toContainEqual(
      expect.stringContaining("must be at or after triggerLine"),
    );
  });

  it("rejects an unknown moment type", () => {
    const result = FixtureScriptSchema.safeParse({
      lines,
      moments: [{ ...moment, type: "vibes" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a research_hook expecting a research card", () => {
    const result = FixtureScriptSchema.safeParse({
      lines,
      moments: [{ ...moment, type: "research_hook", expectedLevel: "research" }],
    });
    expect(messages(result)).toEqual([]);
  });

  it("rejects a research_hook expecting an interjection", () => {
    const result = FixtureScriptSchema.safeParse({
      lines,
      moments: [{ ...moment, type: "research_hook" }],
    });
    expect(messages(result)).toContainEqual(
      expect.stringContaining('expectedLevel must be "research" or "speak"'),
    );
  });

  it("accepts a research_hook the room wondered aloud expecting speech", () => {
    const result = FixtureScriptSchema.safeParse({
      lines,
      moments: [{ ...moment, type: "research_hook", expectedLevel: "speak" }],
    });
    expect(messages(result)).toEqual([]);
  });

  it("accepts a read-back moment expecting speech (V3-013)", () => {
    const result = FixtureScriptSchema.safeParse({
      lines,
      moments: [{ ...moment, type: "unanswered_question", expectedLevel: "speak" }],
    });
    expect(messages(result)).toEqual([]);
  });

  it("rejects a research expectation on a moment the policy delivers", () => {
    const result = FixtureScriptSchema.safeParse({
      lines,
      moments: [{ ...moment, type: "unanswered_question", expectedLevel: "research" }],
    });
    expect(messages(result)).toContainEqual(
      expect.stringContaining("only applies to a research_hook"),
    );
  });
});
