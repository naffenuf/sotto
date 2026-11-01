import { describe, expect, it } from "vitest";
import {
  BRIEFING_OPENER,
  BRIEFING_OPENER_MANY,
  KEY_POINT_MAX_WORDS,
  MAX_BRIEFING_PACKETS,
  asksForResearch,
  briefingOpener,
  packetRelevance,
  packetSourceUrls,
  packetsForBriefing,
  renderPacketsForAnswer,
  MAX_KEY_POINTS,
  MAX_PACKET_SOURCES,
  MAX_PLANNER_IDEAS,
  PACKET_ID_PATTERN,
  PACKET_TEASER_MAX_WORDS,
  PACKET_TITLE_MAX_CHARS,
  PacketReplySchema,
  RESEARCH_PACKET_SCHEMA_NAME,
  PlannerIdeaSchema,
  PlannerReplySchema,
  QUESTION_MAX_CHARS,
  RESEARCH_GATE_SCHEMA_NAME,
  RESEARCH_GATE_THRESHOLD,
  RESEARCH_PLANNER_SCHEMA_NAME,
  ResearchGateReplySchema,
  TOPIC_MAX_CHARS,
  WHY_MAX_WORDS,
  findDuplicateIdea,
  hookIdea,
  packetFileName,
  renderPacketMarkdown,
  researchGateJsonSchema,
  researchPacketJsonSchema,
  researchPlannerJsonSchema,
  researchScore,
  topicFromQuestion,
  type ResearchIdea,
  type ResearchPacket,
} from "./research.js";

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

/** Every node in the schema, so a rule can be checked on all of them. */
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

function closedAndRequired(schema: object): void {
  for (const { path, node } of walk(schema)) {
    if (node.type !== "object") continue;
    expect(node.additionalProperties, `${path} is open`).toBe(false);
    const properties = Object.keys((node.properties ?? {}) as object);
    expect(new Set(node.required as string[]), `${path} requires every property`).toEqual(
      new Set(properties),
    );
  }
  for (const { path, node } of walk(schema)) {
    for (const keyword of unsupportedKeywords) {
      expect(node[keyword], `${path} uses ${keyword}`).toBeUndefined();
    }
  }
}

const plannerItem = researchPlannerJsonSchema.properties.ideas.items as JsonSchemaNode;

describe("researchPlannerJsonSchema", () => {
  it("is in the subset strict structured output accepts", () => {
    closedAndRequired(researchPlannerJsonSchema);
  });

  it("describes the same fields PlannerIdeaSchema validates", () => {
    const schemaKeys = Object.keys(plannerItem.properties as object);
    const zodKeys = Object.keys(PlannerIdeaSchema.shape);
    expect(schemaKeys.sort()).toEqual(zodKeys.sort());
  });

  it("names the stated limits in its descriptions, since no keyword can carry them", () => {
    const properties = plannerItem.properties as Record<string, JsonSchemaNode>;
    expect(properties.topic?.description).toContain(String(TOPIC_MAX_CHARS));
    expect(properties.question?.description).toContain(String(QUESTION_MAX_CHARS));
    expect(properties.why?.description).toContain(String(WHY_MAX_WORDS));
    expect(researchPlannerJsonSchema.properties.ideas.description).toContain(
      String(MAX_PLANNER_IDEAS),
    );
  });

  it("has a name the request can send", () => {
    expect(RESEARCH_PLANNER_SCHEMA_NAME).toMatch(/^[a-z_]+$/);
  });
});

describe("PlannerIdeaSchema", () => {
  const valid = {
    topic: "competitor pricing",
    question: "What do Otter and Fireflies charge per seat per month?",
    why: "the pricing argument rests on a number nobody has",
    sourceTurnIds: ["0:4"],
  };

  it("accepts an idea and leaves it alone", () => {
    expect(PlannerIdeaSchema.parse(valid)).toEqual(valid);
  });

  it("collapses whitespace and clips the stated limits", () => {
    const parsed = PlannerIdeaSchema.parse({
      ...valid,
      topic: `  ${"topic ".repeat(40)}`,
      question: `what\n is  ${"x".repeat(400)}`,
      why: Array.from({ length: WHY_MAX_WORDS + 10 }, (_, index) => `w${index}`).join(" "),
    });
    expect(parsed.topic.length).toBeLessThanOrEqual(TOPIC_MAX_CHARS);
    expect(parsed.question.length).toBeLessThanOrEqual(QUESTION_MAX_CHARS);
    expect(parsed.question).not.toContain("\n");
    expect(parsed.why.split(" ")).toHaveLength(WHY_MAX_WORDS);
    expect(parsed.why.endsWith("…")).toBe(true);
  });

  it("rejects an idea with no question", () => {
    expect(PlannerIdeaSchema.safeParse({ ...valid, question: "  " }).success).toBe(false);
    expect(PlannerIdeaSchema.safeParse({ ...valid, topic: "" }).success).toBe(false);
  });

  it("types the reply's ideas as unknown, so one bad idea does not lose the others", () => {
    const parsed = PlannerReplySchema.parse({ ideas: [valid, { nonsense: true }] });
    expect(parsed.ideas).toHaveLength(2);
  });
});

describe("researchGateJsonSchema", () => {
  it("is in the subset strict structured output accepts", () => {
    closedAndRequired(researchGateJsonSchema);
  });

  it("describes the same three questions ResearchGateReplySchema validates", () => {
    expect(Object.keys(researchGateJsonSchema.properties).sort()).toEqual(
      Object.keys(ResearchGateReplySchema.shape).sort(),
    );
  });

  it("states the range in every description, because Glimmer never reads the schema", () => {
    for (const property of Object.values(researchGateJsonSchema.properties)) {
      expect(property.description).toContain("0 to 1");
    }
  });

  it("has a name the request can send", () => {
    expect(RESEARCH_GATE_SCHEMA_NAME).toMatch(/^[a-z_]+$/);
  });
});

describe("ResearchGateReplySchema", () => {
  it("clamps a model that gets inventive about the range", () => {
    expect(ResearchGateReplySchema.parse({ useful: 8, unknown: -2, answerable: 0.5 })).toEqual({
      useful: 1,
      unknown: 0,
      answerable: 0.5,
    });
  });
});

describe("researchScore", () => {
  it("keeps an idea that is good everywhere at roughly its own level", () => {
    expect(researchScore({ useful: 0.7, unknown: 0.7, answerable: 0.7 })).toBeCloseTo(0.7, 6);
  });

  it("drags down an idea no search could answer, however useful", () => {
    const score = researchScore({ useful: 1, unknown: 1, answerable: 0.2 });
    expect(score).toBeLessThan(RESEARCH_GATE_THRESHOLD);
  });

  it("drags down an idea the group already knows, however answerable", () => {
    const score = researchScore({ useful: 0.9, unknown: 0.1, answerable: 1 });
    expect(score).toBeLessThan(RESEARCH_GATE_THRESHOLD);
  });

  it("passes an idea that is strong on all three", () => {
    expect(researchScore({ useful: 0.9, unknown: 0.8, answerable: 0.9 })).toBeGreaterThan(
      RESEARCH_GATE_THRESHOLD,
    );
  });

  it("is zero when any question is zero", () => {
    expect(researchScore({ useful: 1, unknown: 1, answerable: 0 })).toBe(0);
  });
});

describe("findDuplicateIdea", () => {
  const earlier: ResearchIdea[] = [
    {
      id: "idea-1",
      topic: "competitor pricing",
      question: "What do Otter and Fireflies charge per seat per month?",
      why: "the pricing argument rests on it",
      sourceTurnIds: ["0:4"],
    },
    {
      id: "idea-2",
      topic: "drive time",
      question: "How long is the drive from Manchester to the Peak District on a weekday?",
      why: "the return time hangs on it",
      sourceTurnIds: ["0:9"],
    },
  ];

  it("finds nothing in an empty history", () => {
    expect(findDuplicateIdea(earlier[0]!, [])).toBeUndefined();
  });

  it("catches the same topic, whatever the question", () => {
    expect(
      findDuplicateIdea(
        { topic: "Competitor Pricing!", question: "Which of them has a free tier?" },
        earlier,
      ),
    ).toBe("idea-1");
  });

  it("catches the same question under a different topic", () => {
    expect(
      findDuplicateIdea(
        {
          topic: "seat prices",
          question: "Per seat per month, what do Fireflies and Otter charge?",
          },
        earlier,
      ),
    ).toBe("idea-1");
  });

  it("lets a genuinely different question through", () => {
    expect(
      findDuplicateIdea(
        { topic: "GDPR retention", question: "How long may voice recordings be stored?" },
        earlier,
      ),
    ).toBeUndefined();
  });

  it("is not fooled by two questions sharing only filler words", () => {
    expect(
      findDuplicateIdea(
        { topic: "venue capacity", question: "How many people does the Edale barn hold?" },
        earlier,
      ),
    ).toBeUndefined();
  });
});

describe("hookIdea", () => {
  it("reads the question out of the headline and the why out of whyNow", () => {
    const idea = hookIdea({
      headline: "What do Otter, Fireflies and Granola charge per seat?",
      detail: "They are costing a paid tier off numbers nobody can back up.",
      whyNow: "the pricing decision is on the table now",
      evidenceTurnIds: ["0:4", "0:5"],
    });
    expect(idea.question).toBe("What do Otter, Fireflies and Granola charge per seat?");
    expect(idea.why).toBe("the pricing decision is on the table now");
    expect(idea.sourceTurnIds).toEqual(["0:4", "0:5"]);
    expect(idea.topic.length).toBeLessThanOrEqual(TOPIC_MAX_CHARS);
  });

  it("falls back to the detail when the hook left whyNow empty", () => {
    const idea = hookIdea({
      headline: "How long is the drive to Edale on a Thursday afternoon?",
      detail: "The 5pm call is being planned around an hour's drive nobody has checked.",
      whyNow: "   ",
      evidenceTurnIds: ["0:9"],
    });
    expect(idea.why).toContain("5pm call");
  });

  it("gives two hooks asking the same thing the same topic handle", () => {
    const first = topicFromQuestion("What do Otter and Fireflies charge per seat?");
    const second = topicFromQuestion("What do Otter and Fireflies charge, per seat, in 2026?");
    expect(second).toBe(first);
  });

  it("falls back to the question when it is all filler", () => {
    expect(topicFromQuestion("what is it to us")).not.toBe("");
  });
});

describe("researchPacketJsonSchema", () => {
  it("is in the subset strict structured output accepts", () => {
    closedAndRequired(researchPacketJsonSchema);
  });

  it("describes the same fields PacketReplySchema validates", () => {
    const schemaKeys = Object.keys(researchPacketJsonSchema.properties);
    const zodKeys = Object.keys(PacketReplySchema.shape);
    expect(schemaKeys.sort()).toEqual(zodKeys.sort());
  });

  it("names the stated limits in its descriptions, since no keyword can carry them", () => {
    const properties = researchPacketJsonSchema.properties as Record<string, JsonSchemaNode>;
    expect(properties.title?.description).toContain(String(PACKET_TITLE_MAX_CHARS));
    expect(properties.teaser?.description).toContain(String(PACKET_TEASER_MAX_WORDS));
    expect(properties.keyPoints?.description).toContain(String(MAX_KEY_POINTS));
    expect(properties.keyPoints?.description).toContain(String(KEY_POINT_MAX_WORDS));
    expect(properties.sources?.description).toContain(String(MAX_PACKET_SOURCES));
  });

  it("has a name the request can send", () => {
    expect(RESEARCH_PACKET_SCHEMA_NAME).toMatch(/^[a-z_]+$/);
  });
});

describe("PacketReplySchema", () => {
  const valid = {
    title: "Otter and Fireflies charge $8-19 a seat",
    teaser: "Otter Pro is $16.99 a month, or $8.33 on annual billing; Fireflies Pro is $18 or $10.",
    keyPoints: ["Otter Pro: $16.99 monthly, $8.33 annual", "Fireflies Pro: $18 monthly, $10 annual"],
    sources: [{ url: "https://otter.ai/pricing", title: "Pricing | Otter.ai" }],
  };

  it("accepts a packet and leaves it alone", () => {
    expect(PacketReplySchema.parse(valid)).toEqual(valid);
  });

  it("collapses whitespace and clips the stated limits", () => {
    const parsed = PacketReplySchema.parse({
      ...valid,
      title: `  ${"title ".repeat(40)}`,
      teaser: Array.from({ length: PACKET_TEASER_MAX_WORDS + 10 }, (_, i) => `w${i}`).join("\n"),
      keyPoints: Array.from({ length: MAX_KEY_POINTS + 3 }, (_, i) => `point ${i}`),
    });
    expect(parsed.title.length).toBeLessThanOrEqual(PACKET_TITLE_MAX_CHARS);
    expect(parsed.teaser.split(" ")).toHaveLength(PACKET_TEASER_MAX_WORDS);
    expect(parsed.teaser).not.toContain("\n");
    expect(parsed.keyPoints).toHaveLength(MAX_KEY_POINTS);
  });

  it("drops blank and repeated key points rather than showing them", () => {
    const parsed = PacketReplySchema.parse({
      ...valid,
      keyPoints: ["  ", "Otter Pro is $16.99", "Otter Pro is $16.99"],
    });
    expect(parsed.keyPoints).toEqual(["Otter Pro is $16.99"]);
  });

  it("rejects a packet with no title or no teaser: there is nothing to show", () => {
    expect(PacketReplySchema.safeParse({ ...valid, title: " " }).success).toBe(false);
    expect(PacketReplySchema.safeParse({ ...valid, teaser: "" }).success).toBe(false);
  });

  it("types the sources as unknown, so one bad source does not lose the others", () => {
    const parsed = PacketReplySchema.parse({
      ...valid,
      sources: [valid.sources[0], { nonsense: true }],
    });
    expect(parsed.sources).toHaveLength(2);
  });
});

describe("a packet's file names", () => {
  it("only accepts an id the server itself handed out", () => {
    expect(PACKET_ID_PATTERN.test("packet-1")).toBe(true);
    expect(PACKET_ID_PATTERN.test("packet-12")).toBe(true);
    expect(PACKET_ID_PATTERN.test("../../etc/passwd")).toBe(false);
    expect(PACKET_ID_PATTERN.test("packet-1/../x")).toBe(false);
    expect(PACKET_ID_PATTERN.test("packet-")).toBe(false);
  });

  it("spells both halves of one packet", () => {
    expect(packetFileName("packet-2", "json")).toBe("packet-2.json");
    expect(packetFileName("packet-2", "md")).toBe("packet-2.md");
  });
});

describe("renderPacketMarkdown", () => {
  const packet = (overrides: Partial<ResearchPacket> = {}): ResearchPacket => ({
    id: "packet-1",
    ideaId: "idea-1",
    title: "Otter charges $16.99 a seat",
    teaser: "Monthly billing is $16.99; annual is $8.33.",
    keyPoints: ["Pro: $16.99 monthly", "Business: $30 monthly"],
    sources: [{ url: "https://otter.ai/pricing", title: "Pricing | Otter.ai" }],
    createdAtMs: 120_000,
    latencyMs: 14_200,
    ...overrides,
  });

  it("leads with the title, the question and the teaser", () => {
    const markdown = renderPacketMarkdown(packet(), "What does Otter charge per seat?");
    expect(markdown.startsWith("# Otter charges $16.99 a seat")).toBe(true);
    expect(markdown).toContain("_What does Otter charge per seat?_");
    expect(markdown).toContain("Monthly billing is $16.99");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("lists the key points and links every source", () => {
    const markdown = renderPacketMarkdown(packet(), "What does Otter charge?");
    expect(markdown).toContain("- Pro: $16.99 monthly");
    expect(markdown).toContain("## Sources");
    expect(markdown).toContain("- [Pricing | Otter.ai](https://otter.ai/pricing)");
  });

  it("names the visual and where it was written, when there is one", () => {
    const markdown = renderPacketMarkdown(
      packet({ visual: { title: "Per-seat pricing", path: "artifacts/01-pricing.html", url: "/api/x" } }),
      "What does Otter charge?",
    );
    expect(markdown).toContain("## Visual");
    expect(markdown).toContain("Per-seat pricing");
    expect(markdown).toContain("artifacts/01-pricing.html");
  });

  it("leaves the visual heading out when there is none", () => {
    expect(renderPacketMarkdown(packet(), "q")).not.toContain("## Visual");
  });
});

describe("the briefing (V2-015)", () => {
  const competitors = (): ResearchPacket => ({
    id: "packet-1",
    ideaId: "idea-1",
    title: "Otter, Fireflies and Granola all only transcribe",
    teaser: "The three named competitors ship transcripts and summaries; none of them speaks up.",
    keyPoints: ["Otter reviews complain about summary quality", "Fireflies has no live prompts"],
    sources: [{ url: "https://otter.ai/pricing", title: "Otter.ai — Pricing" }],
    createdAtMs: 60_000,
    latencyMs: 14_000,
  });

  const marketSize = (): ResearchPacket => ({
    ...competitors(),
    id: "packet-2",
    ideaId: "idea-2",
    title: "Meeting software was $3.5B in 2025",
    teaser: "Analysts put the market at $3.5 billion, growing 18% a year.",
    keyPoints: ["Two vendors raised $600M between them in 2024"],
    sources: [{ url: "https://example.com/market", title: "Market size 2025" }],
    createdAtMs: 100_000,
  });

  it("knows the ways a question asks what Sotto found", () => {
    for (const asked of [
      "what did you find on competitors?",
      "what have you found?",
      "tell us about that research",
      "show us",
      "did you look into the market size?",
      "anything on pricing?",
    ]) {
      expect(asksForResearch(asked), asked).toBe(true);
    }
  });

  it("leaves an ordinary question alone", () => {
    for (const asked of [
      "what do the main competitors charge per month?",
      "what did we decide about pricing?",
      "how long would that take to build?",
      "who owns Otter?",
    ]) {
      expect(asksForResearch(asked), asked).toBe(false);
    }
  });

  it("picks the packet the question is about, ignoring the asking words", () => {
    const packets = [competitors(), marketSize()];
    expect(
      packetsForBriefing("what did you find on competitors?", packets).map((one) => one.id),
    ).toEqual(["packet-1"]);
    expect(
      packetsForBriefing("what did you find on the market size?", packets).map((one) => one.id),
    ).toEqual(["packet-2"]);
  });

  it("matches a subject the packet names in the singular", () => {
    expect(packetRelevance("anything on competitors?", competitors())).toBeGreaterThan(0);
    expect(packetRelevance("anything on competitors?", marketSize())).toBe(0);
  });

  it("offers the most recent research when the question names no subject", () => {
    const packets = [competitors(), marketSize()];
    expect(packetsForBriefing("what did you find?", packets).map((one) => one.id)).toEqual([
      "packet-2",
      "packet-1",
    ]);
  });

  it("never offers more than it can brief on", () => {
    const many = Array.from({ length: MAX_BRIEFING_PACKETS + 2 }, (_, index) => ({
      ...competitors(),
      id: `packet-${index + 1}`,
    }));
    expect(packetsForBriefing("what did you find?", many)).toHaveLength(MAX_BRIEFING_PACKETS);
  });

  it("is empty when the question is not asking, or there is nothing to ask about", () => {
    expect(packetsForBriefing("what do rivals charge?", [competitors()])).toEqual([]);
    expect(packetsForBriefing("what did you find?", [])).toEqual([]);
  });

  it("opens differently for one piece of research and for several", () => {
    expect(briefingOpener([competitors()])).toBe(BRIEFING_OPENER);
    expect(briefingOpener([competitors(), marketSize()])).toBe(BRIEFING_OPENER_MANY);
  });

  it("gives the model the title, the findings and the full URLs", () => {
    const rendered = renderPacketsForAnswer([competitors(), marketSize()]);
    expect(rendered).toContain("### packet-1 — Otter, Fireflies and Granola all only transcribe");
    expect(rendered).toContain("- Otter reviews complain about summary quality");
    expect(rendered).toContain("- Otter.ai — Pricing - https://otter.ai/pricing");
    expect(rendered).toContain("### packet-2 — Meeting software was $3.5B in 2025");
  });

  it("says when a visual is already on the group's screen", () => {
    const rendered = renderPacketsForAnswer([
      {
        ...competitors(),
        visual: { title: "Feature grid", path: "artifacts/01-grid.html", url: "/api/x" },
      },
    ]);
    expect(rendered).toContain("A visual is on the group's screen with this: Feature grid");
  });

  it("collects every page the briefing rests on, without repeats", () => {
    expect(packetSourceUrls([competitors(), competitors(), marketSize()])).toEqual([
      "https://otter.ai/pricing",
      "https://example.com/market",
    ]);
  });
});
