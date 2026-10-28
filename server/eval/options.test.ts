import { describe, expect, it } from "vitest";
import { DEFAULT_CHATTINESS, chattinessLevels } from "../../shared/policy.js";
import { evalFixtures, isEvalFixture, parseEvalArgs, runTimestamp } from "./options.js";

describe("evalFixtures", () => {
  const captured = [
    "ask-diagram",
    "ask-search",
    "brainstorm",
    "moment-mixed",
    "moment-contradiction",
    "no-wake",
  ];

  it("takes brainstorm, no-wake and every moment fixture, in that order", () => {
    expect(evalFixtures(captured)).toEqual([
      "brainstorm",
      "no-wake",
      "moment-contradiction",
      "moment-mixed",
    ]);
  });

  it("leaves out the wake-phrase fixtures, which US-017 measures instead", () => {
    expect(isEvalFixture("ask-search")).toBe(false);
    expect(isEvalFixture("ask-diagram")).toBe(false);
  });

  it("takes whatever is captured, and nothing that is not", () => {
    expect(evalFixtures(["brainstorm"])).toEqual(["brainstorm"]);
    expect(evalFixtures([])).toEqual([]);
  });
});

describe("parseEvalArgs", () => {
  it("runs the whole eval set at the default chattiness with no arguments", () => {
    expect(parseEvalArgs([])).toEqual({
      chattiness: [DEFAULT_CHATTINESS],
      fixtures: null,
      skipJudge: false,
    });
  });

  it("takes one chattiness, or all of them", () => {
    expect(parseEvalArgs(["--chattiness", "quiet"])).toMatchObject({ chattiness: ["quiet"] });
    expect(parseEvalArgs(["--chattiness", "all"])).toMatchObject({
      chattiness: [...chattinessLevels],
    });
  });

  it("takes a comma-separated fixture list and the no-judge flag", () => {
    expect(parseEvalArgs(["--fixtures", "moment-fact, brainstorm", "--no-judge"])).toEqual({
      chattiness: [DEFAULT_CHATTINESS],
      fixtures: ["moment-fact", "brainstorm"],
      skipJudge: true,
    });
  });

  it("says what is wrong rather than guessing", () => {
    expect(parseEvalArgs(["--chattiness"])).toEqual({ error: "--chattiness needs a value" });
    expect(parseEvalArgs(["--chattiness", "loud"])).toMatchObject({
      error: expect.stringContaining("unknown chattiness"),
    });
    expect(parseEvalArgs(["--fixtures", " , "])).toEqual({ error: "--fixtures was empty" });
    expect(parseEvalArgs(["--quick"])).toMatchObject({
      error: expect.stringContaining("unknown argument"),
    });
  });
});

describe("runTimestamp", () => {
  it("names a run by local date and time, to the second", () => {
    expect(runTimestamp(new Date(2026, 9, 28, 9, 4, 5))).toBe("2026-10-28_090405");
  });
});
