import { describe, expect, it } from "vitest";
import {
  JUDGE_REASON_MAX_WORDS,
  JUDGE_SCHEMA_NAME,
  JudgeReplySchema,
  judgeMatchJsonSchema,
} from "./eval.js";

/** Keywords strict structured output rejects, as `shared/candidates.test.ts` lists them. */
const unsupportedKeywords = [
  "oneOf",
  "allOf",
  "not",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "default",
];

describe("JudgeReplySchema", () => {
  it("accepts a verdict and its reason", () => {
    expect(JudgeReplySchema.parse({ matches: true, reason: "same budget clash" })).toEqual({
      matches: true,
      reason: "same budget clash",
    });
  });

  it("puts the reason on one line and clips it to the stated limit", () => {
    const reason = `padded\n  ${"word ".repeat(JUDGE_REASON_MAX_WORDS + 10).trim()}`;
    const parsed = JudgeReplySchema.parse({ matches: false, reason });
    expect(parsed.reason).not.toContain("\n");
    expect(parsed.reason.split(" ")).toHaveLength(JUDGE_REASON_MAX_WORDS);
  });

  it("rejects a missing field, a non-boolean verdict and strays", () => {
    expect(JudgeReplySchema.safeParse({ reason: "no verdict" }).success).toBe(false);
    expect(JudgeReplySchema.safeParse({ matches: "yes", reason: "x" }).success).toBe(false);
    expect(
      JudgeReplySchema.safeParse({ matches: true, reason: "x", confidence: 0.5 }).success,
    ).toBe(false);
  });
});

describe("judgeMatchJsonSchema", () => {
  it("is named, closed and fully required", () => {
    expect(JUDGE_SCHEMA_NAME).toBe("moment_match");
    expect(judgeMatchJsonSchema.additionalProperties).toBe(false);
    expect([...judgeMatchJsonSchema.required]).toEqual(
      Object.keys(judgeMatchJsonSchema.properties),
    );
  });

  it("uses no keyword strict structured output rejects", () => {
    const json = JSON.stringify(judgeMatchJsonSchema);
    for (const keyword of unsupportedKeywords) {
      expect(json, `${keyword} is not allowed`).not.toContain(`"${keyword}"`);
    }
  });

  it("describes a reply zod then accepts", () => {
    const properties = judgeMatchJsonSchema.properties;
    expect(properties.matches.type).toBe("boolean");
    expect(properties.reason.type).toBe("string");
    expect(JudgeReplySchema.safeParse({ matches: false, reason: "different issue" }).success).toBe(
      true,
    );
  });

  it("states the word limit it cannot express as a keyword", () => {
    expect(judgeMatchJsonSchema.properties.reason.description).toContain(
      String(JUDGE_REASON_MAX_WORDS),
    );
  });
});
