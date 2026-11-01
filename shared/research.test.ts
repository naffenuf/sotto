import { describe, expect, it } from "vitest";
import {
  MAX_PLANNER_IDEAS,
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
  researchGateJsonSchema,
  researchPlannerJsonSchema,
  researchScore,
  topicFromQuestion,
  type ResearchIdea,
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
