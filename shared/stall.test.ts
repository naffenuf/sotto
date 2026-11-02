/**
 * V3-007's shapes: the ideas reply, and the schema that asks for it.
 *
 * The pair of them have to agree the way `shared/candidates.test.ts` holds the
 * observer's two in agreement — strict structured output rejects the length
 * keywords, so every limit is stated in a description and enforced by the zod
 * schema, and only a test keeps the two honest.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_STALL_IDEAS,
  STALL_IDEAS_SCHEMA_NAME,
  STALL_IDEA_MAX_WORDS,
  STALL_OFFER_COOLDOWN_MS,
  STALL_SPEECH_BUDGET_MS,
  STALL_TOPIC_MAX_WORDS,
  StallIdeasReplySchema,
  stallIdeasJsonSchema,
  stallOutcomes,
} from "./stall.js";

/** Keywords strict structured output rejects. */
const unsupported = [
  "oneOf", "allOf", "not", "minItems", "maxItems", "minLength", "maxLength",
  "pattern", "format", "minimum", "maximum", "default",
];

describe("stallIdeasJsonSchema", () => {
  it("is closed, fully required, and uses no keyword strict output rejects", () => {
    const text = JSON.stringify(stallIdeasJsonSchema);
    for (const keyword of unsupported) expect(text).not.toContain(`"${keyword}"`);
    expect(stallIdeasJsonSchema.additionalProperties).toBe(false);
    expect([...stallIdeasJsonSchema.required].sort()).toEqual(
      Object.keys(stallIdeasJsonSchema.properties).sort(),
    );
  });

  it("states every limit the zod schema enforces, since nothing else can", () => {
    const text = JSON.stringify(stallIdeasJsonSchema);
    expect(text).toContain(String(MAX_STALL_IDEAS));
    expect(text).toContain(String(STALL_IDEA_MAX_WORDS));
    expect(text).toContain(String(STALL_TOPIC_MAX_WORDS));
    // And it says out loud that nothing is a real answer, which is the
    // outcome the prompt is written to allow.
    expect(stallIdeasJsonSchema.properties.ideas.description).toMatch(/empty array/i);
  });

  it("names itself once", () => {
    expect(STALL_IDEAS_SCHEMA_NAME).toBe("stall_ideas");
  });
});

describe("StallIdeasReplySchema", () => {
  it("keeps three ideas at most, best first", () => {
    const parsed = StallIdeasReplySchema.parse({
      topic: "the name",
      ideas: ["one", "two", "three", "four"],
    });
    expect(parsed.ideas).toEqual(["one", "two", "three"]);
  });

  it("clips an overlong idea rather than losing the set", () => {
    const long = Array.from({ length: STALL_IDEA_MAX_WORDS + 8 }, (_, i) => `w${i}`).join(" ");
    const parsed = StallIdeasReplySchema.parse({ topic: "the name", ideas: [long] });
    expect(parsed.ideas[0]?.split(" ")).toHaveLength(STALL_IDEA_MAX_WORDS);
  });

  it("clips the topic and collapses its whitespace, since it is said out loud", () => {
    const parsed = StallIdeasReplySchema.parse({
      topic: "  the\n name   of the whole product line ",
      ideas: ["one"],
    });
    expect(parsed.topic).toBe("the name of the whole");
    expect(parsed.topic.split(" ")).toHaveLength(STALL_TOPIC_MAX_WORDS);
  });

  it("drops a blank idea, and an empty list is a valid reply", () => {
    expect(StallIdeasReplySchema.parse({ topic: "the name", ideas: ["  ", "one"] }).ideas)
      .toEqual(["one"]);
    expect(StallIdeasReplySchema.parse({ topic: "the name", ideas: [] }).ideas).toEqual([]);
  });

  it("rejects a reply with a field it does not know", () => {
    expect(
      StallIdeasReplySchema.safeParse({ topic: "the name", ideas: [], why: "because" }).success,
    ).toBe(false);
  });
});

describe("the limits", () => {
  it("rations an offer to one every ten minutes, as the PRD asks", () => {
    expect(STALL_OFFER_COOLDOWN_MS).toBe(10 * 60_000);
  });

  it("gives the ideas about twenty seconds of speech", () => {
    expect(STALL_SPEECH_BUDGET_MS).toBe(20_000);
  });

  it("records an outcome for a stall that was never offered", () => {
    expect(stallOutcomes).toContain("cooldown");
    expect(stallOutcomes).toContain("no_ideas");
    expect(stallOutcomes).toContain("offered");
  });
});
