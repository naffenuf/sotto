import { describe, expect, it } from "vitest";
import {
  DETAIL_MAX_WORDS,
  HEADLINE_MAX_CHARS,
  OBSERVER_SCHEMA_NAME,
  ObserverCandidateSchema,
  ObserverReplySchema,
  WHY_NOW_MAX_WORDS,
  candidateTypes,
  clipChars,
  clipWords,
  observerCandidatesJsonSchema,
} from "./candidates.js";

/** Keywords strict structured output rejects, and the union form it wants. */
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

type JsonSchemaNode = Record<string, unknown>;

/** Every object and array node in the schema, so a rule can be checked on all of them. */
function walk(node: unknown, path = "$", found: { path: string; node: JsonSchemaNode }[] = []) {
  if (node === null || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, `${path}[${index}]`, found));
    return found;
  }
  const schema = node as JsonSchemaNode;
  found.push({ path, node: schema });
  for (const [key, value] of Object.entries(schema)) walk(value, `${path}.${key}`, found);
  return found;
}

const item = observerCandidatesJsonSchema.properties.candidates.items as JsonSchemaNode;

/** A minimal candidate satisfying the JSON Schema, built from the schema alone. */
function sample(node: JsonSchemaNode): Record<string, unknown> {
  const properties = node.properties as Record<string, JsonSchemaNode>;
  const value: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    const choices = property.enum as string[] | undefined;
    if (choices !== undefined) value[key] = choices[0];
    else if (property.type === "array") value[key] = ["0:1"];
    else if (property.type === "number") value[key] = 0.5;
    else if (property.type === "object") value[key] = sample(property);
    else value[key] = "something said";
  }
  return value;
}

describe("clipping", () => {
  it("leaves text that already fits alone", () => {
    expect(clipChars("short enough", 90)).toBe("short enough");
    expect(clipWords("three words here", 60)).toBe("three words here");
  });

  it("cuts a long headline at a word boundary", () => {
    const long = `${"ninety ".repeat(20)}end`;
    const clipped = clipChars(long, HEADLINE_MAX_CHARS);
    expect(clipped.length).toBeLessThanOrEqual(HEADLINE_MAX_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped).not.toContain("  ");
  });

  it("cuts mid-word rather than losing most of the headline", () => {
    // One word longer than the limit: there is no boundary to cut at.
    const clipped = clipChars("x".repeat(40), 10);
    expect(clipped).toBe("xxxxxxxxx…");
  });

  it("cuts a long detail to a word count", () => {
    const long = Array.from({ length: 120 }, (_, index) => `w${index}`).join(" ");
    const clipped = clipWords(long, DETAIL_MAX_WORDS);
    // The ellipsis rides on the last word it kept, so the count is the limit.
    expect(clipped.split(" ")).toHaveLength(DETAIL_MAX_WORDS);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("ObserverCandidateSchema", () => {
  const valid: Record<string, unknown> = {
    type: "contradiction",
    headline: "The $20k studio doesn't fit the $4k first-version budget",
    detail: "They set the whole budget at $4,000 and are now proposing $20,000 of design.",
    whyNow: "They are about to book it",
    evidenceTurnIds: ["0:3", "0:20"],
    relatedBoardItemIds: ["c1"],
    scores: { relevance: 0.9, novelty: 0.8, importance: 0.95, confidence: 0.85 },
  };

  it("accepts a well-formed candidate unchanged", () => {
    expect(ObserverCandidateSchema.parse(valid)).toEqual(valid);
  });

  it("enforces the stated limits by clipping, and puts every field on one line", () => {
    const parsed = ObserverCandidateSchema.parse({
      ...valid,
      headline: `${"a very long headline ".repeat(10)}end`,
      detail: Array.from({ length: 200 }, (_, index) => `w${index}`).join("\n"),
      whyNow: Array.from({ length: 40 }, () => "now").join("  "),
    });
    expect(parsed.headline.length).toBeLessThanOrEqual(HEADLINE_MAX_CHARS);
    expect(parsed.detail.split(" ")).toHaveLength(DETAIL_MAX_WORDS);
    expect(parsed.whyNow.split(" ")).toHaveLength(WHY_NOW_MAX_WORDS);
    for (const text of [parsed.headline, parsed.detail, parsed.whyNow]) {
      expect(text).not.toMatch(/[\n\t]|\s\s/);
    }
  });

  it("clamps a score the model put outside 0-1", () => {
    const parsed = ObserverCandidateSchema.parse({
      ...valid,
      scores: { relevance: 1.4, novelty: -0.2, importance: 10, confidence: 0 },
    });
    expect(parsed.scores).toEqual({
      relevance: 1,
      novelty: 0,
      importance: 1,
      confidence: 0,
    });
  });

  it("rejects an unknown type, a missing field, an empty headline and strays", () => {
    expect(ObserverCandidateSchema.safeParse({ ...valid, type: "nitpick" }).success).toBe(false);
    expect(ObserverCandidateSchema.safeParse({ ...valid, headline: "   " }).success).toBe(false);
    expect(ObserverCandidateSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(
      ObserverCandidateSchema.safeParse({ ...valid, scores: { relevance: 1 } }).success,
    ).toBe(false);
    for (const key of Object.keys(valid)) {
      const { [key]: _dropped, ...without } = valid;
      expect(ObserverCandidateSchema.safeParse(without).success, `${key} is optional`).toBe(false);
    }
  });
});

describe("ObserverReplySchema", () => {
  it("keeps the candidates unvalidated, so one bad one can be dropped alone", () => {
    const parsed = ObserverReplySchema.parse({ candidates: [{ nonsense: true }, 7] });
    expect(parsed.candidates).toHaveLength(2);
  });

  it("rejects a reply that is not a list of candidates", () => {
    expect(ObserverReplySchema.safeParse({ candidates: {} }).success).toBe(false);
    expect(ObserverReplySchema.safeParse({}).success).toBe(false);
    expect(ObserverReplySchema.safeParse({ candidates: [], extra: 1 }).success).toBe(false);
  });
});

describe("observerCandidatesJsonSchema", () => {
  it("is named, closed and fully required all the way down", () => {
    expect(OBSERVER_SCHEMA_NAME).toBe("observer_candidates");
    for (const { path, node } of walk(observerCandidatesJsonSchema)) {
      for (const keyword of unsupportedKeywords) {
        expect(node[keyword], `${path} uses ${keyword}`).toBeUndefined();
      }
      if (node.type !== "object") continue;
      expect(node.additionalProperties, `${path} is open`).toBe(false);
      const properties = Object.keys(node.properties as JsonSchemaNode);
      expect(node.required, `${path} does not require every property`).toEqual(properties);
    }
  });

  it("offers exactly the types the zod schema accepts", () => {
    const type = (item.properties as Record<string, JsonSchemaNode>).type!;
    expect(type.enum).toEqual([...candidateTypes]);
  });

  it("describes a candidate zod then accepts, with every field required", () => {
    const full = sample(item);
    expect(ObserverCandidateSchema.safeParse(full).success).toBe(true);
    for (const key of Object.keys(full)) {
      const { [key]: _dropped, ...without } = full;
      expect(ObserverCandidateSchema.safeParse(without).success, `${key} is optional`).toBe(false);
    }
  });

  it("states the limits it cannot express as keywords", () => {
    const properties = item.properties as Record<string, JsonSchemaNode>;
    expect(properties.headline?.description).toContain(String(HEADLINE_MAX_CHARS));
    expect(properties.detail?.description).toContain(String(DETAIL_MAX_WORDS));
    expect(properties.whyNow?.description).toContain(String(WHY_NOW_MAX_WORDS));
    const scores = (properties.scores?.properties ?? {}) as Record<string, JsonSchemaNode>;
    for (const [name, score] of Object.entries(scores)) {
      expect(score.description, name).toContain("0 to 1");
    }
  });
});
