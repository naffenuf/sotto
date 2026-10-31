import { describe, expect, it } from "vitest";
import { ACK_QUICK, ACK_SEARCH, chooseAcknowledgment, searchLikely } from "./ack.js";

describe("chooseAcknowledgment", () => {
  it("buys time for a question that has to be looked up", () => {
    for (const question of [
      "what do the main competitors charge per month?",
      "how big is the market for this?",
      "who else has raised money in this space?",
      "how long is the drive from the office?",
    ]) {
      expect(chooseAcknowledgment(question), question).toBe(ACK_SEARCH);
      expect(searchLikely(question), question).toBe(true);
    }
  });

  it("just says it heard a question about the conversation", () => {
    for (const question of [
      "what did we decide about pricing?",
      "did we agree on Thursday?",
      "can you recap where we are?",
      "what's on the board so far?",
      "what are the open questions?",
      "wrap us up",
    ]) {
      expect(chooseAcknowledgment(question), question).toBe(ACK_QUICK);
      expect(searchLikely(question), question).toBe(false);
    }
  });

  it("assumes a search when it cannot tell, because silence is the worse guess", () => {
    expect(chooseAcknowledgment("thoughts?")).toBe(ACK_SEARCH);
  });

  it("keeps both acknowledgments short enough to be cut off politely", () => {
    for (const phrase of [ACK_QUICK, ACK_SEARCH]) {
      expect(phrase.length).toBeLessThanOrEqual(16);
    }
  });
});
