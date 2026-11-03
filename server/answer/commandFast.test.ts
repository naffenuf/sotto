/** Jev in front of the command classifier (post-V3-011). */
import { describe, expect, it } from "vitest";
import { SimulatedClock } from "../clock.js";
import type { JevLike, JevResponse } from "../model/JevClient.js";
import type { ModelClient } from "../model/client.js";
import { gatedClassifyCommand } from "./commandFast.js";

function jevSaying(kind: string, confidence: number): JevLike {
  return {
    systemOne: async () => {
      const response: JevResponse = {
        model: "jev-1.14.0",
        answers: { kind: { type: "choice", choice: kind, confidence, probabilities: { [kind]: confidence } } },
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
      return { command: "new_question", question: "how long does the bus take?" };
    },
    grounded: async () => { throw new Error("no"); },
    prose: async () => { throw new Error("no"); },
  };
  return model;
}

describe("gatedClassifyCommand", () => {
  it("reads a confident new question off the turn, with no Spark call", async () => {
    const model = spark();
    const wall = new SimulatedClock(0);
    expect(await gatedClassifyCommand(jevSaying("new_question", 0.9), model, "Sotto, how long does the bus take?", { wallClock: wall }))
      .toEqual({ command: "new_question", question: "how long does the bus take?" });
    expect(await gatedClassifyCommand(jevSaying("stop", 0.95), model, "Sotto stop", { wallClock: wall }))
      .toEqual({ command: "stop", question: "" });
    expect(await gatedClassifyCommand(jevSaying("quieter", 0.9), model, "Sotto, not now", { wallClock: wall }))
      .toEqual({ command: "quieter", question: "" });
    expect(model.calls).toBe(0);
  });

  it("asks Spark when unsure, when a new question has no words, or when Jev is away", async () => {
    const model = spark();
    const wall = new SimulatedClock(0);
    await gatedClassifyCommand(jevSaying("stop", 0.5), model, "Sotto hmm", { wallClock: wall });
    await gatedClassifyCommand(jevSaying("new_question", 0.95), model, "Sotto", { wallClock: wall });
    await gatedClassifyCommand(null, model, "Sotto, the price?", { wallClock: wall });
    expect(model.calls).toBe(3);
  });
});
