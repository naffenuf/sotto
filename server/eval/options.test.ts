import { describe, expect, it } from "vitest";
import { DEFAULT_GATE_MODE } from "../../shared/candidates.js";
import { defaultPolicySettings } from "../../shared/policy.js";
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

  it("takes the two v2 conversations too, last and in the PRD's order (V2-019)", () => {
    expect(isEvalFixture("research-business-idea")).toBe(true);
    expect(isEvalFixture("offsite-plan")).toBe(true);
    expect(evalFixtures([...captured, "offsite-plan", "research-business-idea"])).toEqual([
      "brainstorm",
      "no-wake",
      "moment-contradiction",
      "moment-mixed",
      "offsite-plan",
      "research-business-idea",
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
  it("runs the whole eval set at the default settings with no arguments", () => {
    expect(parseEvalArgs([])).toEqual({
      settings: [defaultPolicySettings()],
      gate: DEFAULT_GATE_MODE,
      fixtures: null,
      skipJudge: false,
    });
  });

  it("takes one frequency and one boldness, or all of either (V2-017)", () => {
    expect(parseEvalArgs(["--frequency", "rare"])).toMatchObject({
      settings: [{ frequency: "rare", boldness: "normal" }],
    });
    expect(parseEvalArgs(["--boldness", "bold"])).toMatchObject({
      settings: [{ frequency: "normal", boldness: "bold" }],
    });
    expect(parseEvalArgs(["--boldness", "all"])).toMatchObject({
      settings: [
        { frequency: "normal", boldness: "cautious" },
        { frequency: "normal", boldness: "normal" },
        { frequency: "normal", boldness: "bold" },
      ],
    });
  });

  it("crosses the two, frequency first", () => {
    const parsed = parseEvalArgs(["--frequency", "all", "--boldness", "all"]);
    expect(parsed).toMatchObject({ settings: expect.any(Array) });
    const settings = "settings" in parsed ? parsed.settings : [];
    expect(settings).toHaveLength(9);
    expect(settings[0]).toEqual({ frequency: "rare", boldness: "cautious" });
    expect(settings[1]).toEqual({ frequency: "rare", boldness: "normal" });
    expect(settings.at(-1)).toEqual({ frequency: "often", boldness: "bold" });
  });

  it("takes a comma-separated fixture list and the no-judge flag", () => {
    expect(parseEvalArgs(["--fixtures", "moment-fact, brainstorm", "--no-judge"])).toEqual({
      settings: [defaultPolicySettings()],
      gate: DEFAULT_GATE_MODE,
      fixtures: ["moment-fact", "brainstorm"],
      skipJudge: true,
    });
  });

  it("takes either gate, and defaults to the observer's own scores (V3-001)", () => {
    expect(parseEvalArgs([])).toMatchObject({ gate: "spark" });
    expect(parseEvalArgs(["--gate", "spark"])).toMatchObject({ gate: "spark" });
    expect(parseEvalArgs(["--gate", "glimmer"])).toMatchObject({ gate: "glimmer" });
  });

  it("says what is wrong rather than guessing", () => {
    expect(parseEvalArgs(["--frequency"])).toEqual({ error: "--frequency needs a value" });
    expect(parseEvalArgs(["--frequency", "constant"])).toMatchObject({
      error: expect.stringContaining("unknown frequency"),
    });
    expect(parseEvalArgs(["--boldness"])).toEqual({ error: "--boldness needs a value" });
    expect(parseEvalArgs(["--boldness", "loud"])).toMatchObject({
      error: expect.stringContaining("unknown boldness"),
    });
    // The setting V2-017 replaced is gone, not quietly accepted.
    expect(parseEvalArgs(["--chattiness", "quiet"])).toMatchObject({
      error: expect.stringContaining("unknown argument"),
    });
    expect(parseEvalArgs(["--fixtures", " , "])).toEqual({ error: "--fixtures was empty" });
    expect(parseEvalArgs(["--gate"])).toEqual({ error: "--gate needs a value" });
    expect(parseEvalArgs(["--gate", "llama"])).toMatchObject({
      error: expect.stringContaining("unknown gate"),
    });
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
