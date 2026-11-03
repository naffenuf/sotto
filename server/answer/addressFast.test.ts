/** Jev in front of the address classifier (post-V3-011). */
import { describe, expect, it } from "vitest";
import { SimulatedClock } from "../clock.js";
import type { JevLike, JevResponse } from "../model/JevClient.js";
import type { ModelClient } from "../model/client.js";
import type { AddressInput } from "./address.js";
import { gatedClassifyAddress } from "./addressFast.js";

function input(text: string, raised = 0): AddressInput {
  return {
    turn: { turnId: "0:1", speaker: "A", text, final: true, startMs: 0, endMs: 1, speakerMappingUncertain: false },
    previous: [],
    speakers: { A: "Craig" },
    raised,
  };
}

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
      return { kind: "request", question: "look up the bus schedules" };
    },
    grounded: async () => { throw new Error("no"); },
    prose: async () => { throw new Error("no"); },
  };
  return model;
}

describe("gatedClassifyAddress", () => {
  it("answers a confident request itself, with the words read off the turn", async () => {
    const model = spark();
    const classify = gatedClassifyAddress(jevSaying("request", 0.9), model, { wallClock: new SimulatedClock(0) });
    expect(await classify(input("Sotto can you look up those bus schedules?"))).toEqual({
      kind: "request", question: "can you look up those bus schedules?",
    });
    expect(model.calls).toBe(0);
  });

  it("answers a confident mention or call_on itself", async () => {
    const model = spark();
    expect(await gatedClassifyAddress(jevSaying("mention", 0.85), model, { wallClock: new SimulatedClock(0) })(input("Sotto has been quiet today")))
      .toEqual({ kind: "mention", question: "" });
    expect(await gatedClassifyAddress(jevSaying("call_on", 0.8), model, { wallClock: new SimulatedClock(0) })(input("Sotto, go ahead", 1)))
      .toEqual({ kind: "call_on", question: "" });
    expect(model.calls).toBe(0);
  });

  it("asks Spark when Jev is unsure, when a request has no words, or when Jev is away", async () => {
    const model = spark();
    const wall = new SimulatedClock(0);
    await gatedClassifyAddress(jevSaying("mention", 0.55), model, { wallClock: wall })(input("Sotto what"));
    await gatedClassifyAddress(jevSaying("request", 0.95), model, { wallClock: wall })(input("Sotto"));
    await gatedClassifyAddress(null, model, { wallClock: wall })(input("Sotto, the price?"));
    expect(model.calls).toBe(3);
  });
});
