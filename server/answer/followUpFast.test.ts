/** Jev in front of the follow-up classifier (post-V3-011). */
import { describe, expect, it } from "vitest";
import { SimulatedClock } from "../clock.js";
import type { JevLike, JevResponse } from "../model/JevClient.js";
import type { ModelClient } from "../model/client.js";
import type { FollowUpInput } from "./followUp.js";
import { gatedClassifyFollowUp, renderFollowUpState } from "./followUpFast.js";

function input(text: string): FollowUpInput {
  return {
    turn: { turnId: "0:4", speaker: "A", text, final: true, startMs: 0, endMs: 1, speakerMappingUncertain: false },
    previous: [],
    speakers: { A: "Craig" },
    answer: { question: "how long is the bus?", headline: "About two hours", spokenText: "About two hours, Craig." },
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
      return { kind: "to_sotto", question: "How much is a bus ticket, roughly?" };
    },
    grounded: async () => { throw new Error("no"); },
    prose: async () => { throw new Error("no"); },
  };
  return model;
}

describe("gatedClassifyFollowUp", () => {
  it("asks a confident follow-up as said, with no Spark call", async () => {
    const model = spark();
    const classify = gatedClassifyFollowUp(jevSaying("to_sotto", 0.9), model, { wallClock: new SimulatedClock(0) });
    expect(await classify(input("And how much is the ticket roughly?"))).toEqual({
      kind: "to_sotto", question: "And how much is the ticket roughly?",
    });
    expect(model.calls).toBe(0);
  });

  it("closes on a confident to_room or closing itself", async () => {
    const model = spark();
    const wall = new SimulatedClock(0);
    expect(await gatedClassifyFollowUp(jevSaying("to_room", 0.85), model, { wallClock: wall })(input("EJ, what do you think?")))
      .toEqual({ kind: "to_room", question: "" });
    expect(await gatedClassifyFollowUp(jevSaying("closing", 0.95), model, { wallClock: wall })(input("Thanks.")))
      .toEqual({ kind: "closing", question: "" });
    expect(model.calls).toBe(0);
  });

  it("asks Spark when Jev is unsure or away", async () => {
    const model = spark();
    const wall = new SimulatedClock(0);
    await gatedClassifyFollowUp(jevSaying("to_sotto", 0.5), model, { wallClock: wall })(input("and the other one?"));
    await gatedClassifyFollowUp(null, model, { wallClock: wall })(input("and the other one?"));
    expect(model.calls).toBe(2);
  });

  it("shows Jev what Sotto was asked and what it said", () => {
    const state = renderFollowUpState(input("And how much is the ticket roughly?"));
    expect(state).toContain("Sotto was asked: how long is the bus?");
    expect(state).toContain("Sotto answered: About two hours, Craig.");
    expect(state.endsWith("Latest turn:\nCraig: And how much is the ticket roughly?")).toBe(true);
  });
});
