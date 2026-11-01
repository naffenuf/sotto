import { describe, expect, it } from "vitest";
import { emptyBoard, type Board } from "../../shared/board.js";
import {
  RESEARCH_GATE_SCHEMA_NAME,
  RESEARCH_GATE_THRESHOLD,
  type ResearchIdea,
} from "../../shared/research.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import { ModelCallError, type StructuredCall } from "../model/client.js";
import type { JudgmentClient, JudgmentWhere } from "../model/judgment.js";
import { GATE_MAX_TOKENS, ResearchGate, renderGateRequest } from "./ResearchGate.js";

const idea: ResearchIdea = {
  id: "idea-1",
  topic: "competitor pricing",
  question: "What do Otter and Fireflies charge per seat per month?",
  why: "the pricing argument rests on a number nobody has",
  sourceTurnIds: ["0:4"],
};

/** A judgment client that answers from a script. */
function judge(
  reply: () => Promise<unknown>,
  where: JudgmentWhere = "local",
): { client: JudgmentClient; calls: StructuredCall[] } {
  const calls: StructuredCall[] = [];
  return {
    calls,
    client: {
      where,
      structured: (call) => {
        calls.push(call);
        return reply();
      },
    },
  };
}

function gateFor(
  client: JudgmentClient | null,
  turns: TurnUpdate[] = [],
  board: Board = emptyBoard(),
): ResearchGate {
  return new ResearchGate({
    clock: new SimulatedClock(0),
    client: () => Promise.resolve(client),
    board: () => board,
    turns: () => turns,
    logger: { log: () => {}, warn: () => {} },
  });
}

describe("ResearchGate", () => {
  it("queues an idea that scores above the threshold", async () => {
    const { client, calls } = judge(() =>
      Promise.resolve({ useful: 0.9, unknown: 0.8, answerable: 0.9 }),
    );
    const record = await gateFor(client).score(idea);
    expect(record.decision).toBe("queued");
    expect(record.where).toBe("local");
    expect(record.scores).toEqual({ useful: 0.9, unknown: 0.8, answerable: 0.9 });
    expect(record.score).toBeGreaterThan(RESEARCH_GATE_THRESHOLD);
    expect(record.threshold).toBe(RESEARCH_GATE_THRESHOLD);
    expect(record.ideaId).toBe("idea-1");
    expect(record.question).toBe(idea.question);
    expect(calls[0]?.schemaName).toBe(RESEARCH_GATE_SCHEMA_NAME);
    expect(calls[0]?.maxTokens).toBe(GATE_MAX_TOKENS);
    expect(calls[0]?.reasoningEffort).toBe("low");
  });

  it("rejects an idea that scores below it", async () => {
    const { client } = judge(() => Promise.resolve({ useful: 0.6, unknown: 0.2, answerable: 0.9 }));
    const record = await gateFor(client).score(idea);
    expect(record.decision).toBe("rejected");
    expect(record.score).toBeLessThan(RESEARCH_GATE_THRESHOLD);
  });

  it("decides on the threshold it was given", async () => {
    const scores = { useful: 0.5, unknown: 0.5, answerable: 0.5 };
    const { client } = judge(() => Promise.resolve(scores));
    const strict = new ResearchGate({
      clock: new SimulatedClock(0),
      client: () => Promise.resolve(client),
      board: emptyBoard,
      turns: () => [],
      threshold: 0.9,
      logger: { log: () => {}, warn: () => {} },
    });
    expect((await strict.score(idea)).decision).toBe("rejected");
    const lax = new ResearchGate({
      clock: new SimulatedClock(0),
      client: () => Promise.resolve(judge(() => Promise.resolve(scores)).client),
      board: emptyBoard,
      turns: () => [],
      threshold: 0.4,
      logger: { log: () => {}, warn: () => {} },
    });
    expect((await lax.score(idea)).decision).toBe("queued");
  });

  it("fails rather than passes when the call does not come back", async () => {
    const { client } = judge(() => Promise.reject(new ModelCallError("truncated")));
    const record = await gateFor(client).score(idea);
    expect(record.decision).toBe("failed");
    expect(record.error).toContain("truncated");
    expect(record.scores).toBeUndefined();
    expect(record.score).toBe(0);
    expect(record.where).toBe("local");
  });

  it("fails on a reply that does not match the schema", async () => {
    const { client } = judge(() => Promise.resolve({ useful: "very" }));
    const record = await gateFor(client).score(idea);
    expect(record.decision).toBe("failed");
    expect(record.error).toContain("research gate reply");
  });

  it("fails when there is no model to ask", async () => {
    const record = await gateFor(null).score(idea);
    expect(record.decision).toBe("failed");
    expect(record.where).toBeNull();
    expect(record.error).toContain("no model");
  });

  it("records which model answered", async () => {
    const { client } = judge(
      () => Promise.resolve({ useful: 0.9, unknown: 0.9, answerable: 0.9 }),
      "cloud",
    );
    expect((await gateFor(client).score(idea)).where).toBe("cloud");
  });
});

describe("renderGateRequest", () => {
  it("names the question, its topic and why it was proposed", () => {
    const rendered = renderGateRequest(emptyBoard(), [], idea);
    expect(rendered).toContain("Topic: competitor pricing");
    expect(rendered).toContain(`Question: ${idea.question}`);
    expect(rendered).toContain("Why it was proposed: the pricing argument");
    expect(rendered).toContain("between 0 and 1");
  });

  it("prints the last few turns without ids: the gate judges the question", () => {
    const turn: TurnUpdate = {
      turnId: "0:4",
      speaker: "A",
      speakerMappingUncertain: false,
      text: "I think Otter is about ten dollars",
      final: true,
      startMs: 4_000,
      endMs: 5_000,
    };
    const rendered = renderGateRequest(emptyBoard(), [turn], idea);
    expect(rendered).toContain("A: I think Otter is about ten dollars");
    expect(rendered).not.toContain("[0:4]");
  });
});
