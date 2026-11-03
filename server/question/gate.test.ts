/**
 * Jev in front of the question classifier: it decides whether Spark is asked
 * at all, and Spark still writes every word (post-V3-011).
 */
import { describe, expect, it } from "vitest";
import { SimulatedClock } from "../clock.js";
import type { JevLike, JevRequest, JevResponse } from "../model/JevClient.js";
import type { ModelClient } from "../model/client.js";
import { SPECULATE_CONFIDENCE, gatedClassifyQuestion, needsSpark, renderGateState } from "./gate.js";
import type { QuestionInput } from "./question.js";

function input(text: string, previous: string[] = []): QuestionInput {
  const turn = (id: string, value: string) => ({
    turnId: id, speaker: "A", text: value, final: true, startMs: 0, endMs: 1, speakerMappingUncertain: false,
  });
  return { turn: turn("0:9", text), previous: previous.map((value, i) => turn(`0:${i}`, value)), speakers: { A: "Craig" } };
}

function jevSaying(kind: string, confidence: number, closing = 0): JevLike & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    requests,
    systemOne: async (request) => {
      requests.push(request);
      const response: JevResponse = {
        model: "jev-1.14.0",
        answers: {
          kind: { type: "choice", choice: kind, confidence, probabilities: { [kind]: confidence } },
          closing: { type: "noul", noul: closing },
        },
      };
      return response;
    },
  };
}

function spark(): ModelClient & { calls: number } {
  const model = {
    calls: 0,
    structured: async () => {
      model.calls += 1;
      return { kind: "open_question", question: "Which buses run to Philadelphia on Sunday?", topic: "bus schedules", closing: false, decision: "" };
    },
    grounded: async () => { throw new Error("no"); },
    prose: async () => { throw new Error("no"); },
  };
  return model;
}

describe("needsSpark", () => {
  it("asks Spark for the words of a lookup, a settled decision, and anything Jev is unsure of", () => {
    expect(needsSpark({ kind: "open_question", confidence: 0.95, closing: 0, latencyMs: 1 })).toBe(true);
    expect(needsSpark({ kind: "decision", confidence: 0.9, closing: 0.9, latencyMs: 1 })).toBe(true);
    expect(needsSpark({ kind: "none", confidence: 0.5, closing: 0, latencyMs: 1 })).toBe(true);
    expect(needsSpark({ kind: "none", confidence: 0.8, closing: 0.1, latencyMs: 1 })).toBe(false);
    expect(needsSpark({ kind: "rhetorical", confidence: 0.82, closing: 0.05, latencyMs: 1 })).toBe(false);
  });
});

describe("gatedClassifyQuestion", () => {
  it("answers a confident 'none' itself, with no Spark call", async () => {
    const jev = jevSaying("none", 0.78);
    const model = spark();
    const gates: unknown[] = [];
    const classify = gatedClassifyQuestion(jev, model, { wallClock: new SimulatedClock(0), onGate: (v) => gates.push(v) });
    const result = await classify(input("we should get the invites out by Friday"));
    expect(result).toEqual({ kind: "none", question: "", topic: "", closing: false, decision: "" });
    expect(model.calls).toBe(0);
    expect(gates[0]).toMatchObject({ kind: "none", sparked: false, turnId: "0:9" });
  });

  it("hands a lookup to Spark for the question and the topic", async () => {
    const jev = jevSaying("open_question", 0.96);
    const model = spark();
    const classify = gatedClassifyQuestion(jev, model, { wallClock: new SimulatedClock(0) });
    const result = await classify(input("we need the bus schedules from New York to Philadelphia"));
    expect(result).toMatchObject({ kind: "open_question", topic: "bus schedules" });
    expect(model.calls).toBe(1);
  });

  it("falls back to Spark when Jev fails or is absent", async () => {
    const broken: JevLike = { systemOne: async () => { throw new Error("down"); } };
    const model = spark();
    await gatedClassifyQuestion(broken, model, { wallClock: new SimulatedClock(0) })(input("anything"));
    await gatedClassifyQuestion(null, model, { wallClock: new SimulatedClock(0) })(input("anything"));
    expect(model.calls).toBe(2);
  });

  it("shows Jev the previous turns by name and the latest last", async () => {
    const jev = jevSaying("none", 0.9);
    await gatedClassifyQuestion(jev, spark(), { wallClock: new SimulatedClock(0) })(input("and cheapest", ["we need the bus schedules"]));
    expect(jev.requests[0]?.state).toBe(renderGateState(input("and cheapest", ["we need the bus schedules"])));
    expect(jev.requests[0]?.state).toContain("Craig: we need the bus schedules");
    expect(jev.requests[0]?.state.endsWith("Latest turn:\nCraig: and cheapest")).toBe(true);
  });
});

describe("speculation: a confident lookup starts before Spark is asked", () => {
  function sparkSaying(kind: string): ModelClient & { calls: number } {
    const model = {
      calls: 0,
      structured: async () => {
        model.calls += 1;
        return { kind, question: kind === "open_question" ? "Which buses run on Sunday?" : "", topic: kind === "open_question" ? "the Sunday buses" : "", closing: false, decision: "" };
      },
      grounded: async () => { throw new Error("no"); },
      prose: async () => { throw new Error("no"); },
    };
    return model;
  }

  it("fires onSpeculate first, then settles confirmed when Spark agrees", async () => {
    const events: string[] = [];
    const classify = gatedClassifyQuestion(jevSaying("open_question", SPECULATE_CONFIDENCE), sparkSaying("open_question"), {
      wallClock: new SimulatedClock(0),
      onSpeculate: (input) => events.push(`speculate:${input.turn.turnId}`),
      onSpeculationSettled: (turnId, confirmed) => events.push(`settled:${turnId}:${confirmed}`),
    });
    const result = await classify(input("we need the bus schedules"));
    expect(events).toEqual(["speculate:0:9", "settled:0:9:true"]);
    expect(result).toMatchObject({ kind: "open_question", topic: "the Sunday buses" });
  });

  it("settles unconfirmed when Spark reads it as something else, or fails", async () => {
    const events: string[] = [];
    const options = {
      wallClock: new SimulatedClock(0),
      onSpeculate: () => events.push("speculate"),
      onSpeculationSettled: (_turnId: string, confirmed: boolean) => events.push(`settled:${confirmed}`),
    };
    await gatedClassifyQuestion(jevSaying("open_question", 0.95), sparkSaying("to_group"), options)(input("who's bringing the projector"));
    const broken: ModelClient = { structured: async () => { throw new Error("down"); }, grounded: async () => { throw new Error("no"); }, prose: async () => { throw new Error("no"); } };
    await expect(gatedClassifyQuestion(jevSaying("open_question", 0.95), broken, options)(input("x"))).rejects.toThrow();
    expect(events).toEqual(["speculate", "settled:false", "speculate", "settled:false"]);
  });

  it("does not speculate below the bar, or when nobody is listening for it", async () => {
    const events: string[] = [];
    await gatedClassifyQuestion(jevSaying("open_question", 0.8), sparkSaying("open_question"), {
      wallClock: new SimulatedClock(0),
      onSpeculate: () => events.push("speculate"),
    })(input("maybe the schedules?"));
    expect(events).toEqual([]);
  });
});
