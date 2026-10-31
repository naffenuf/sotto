/**
 * V2-006's pure matcher contract: short ASR excerpts should match speech,
 * while unrelated turns that borrow a few words must remain human context.
 */
import { describe, expect, it } from "vitest";
import { echoOverlap, isSelfEcho } from "./selfEcho.js";

const spoken = "I'm Sotto. The north entrance is closed; please use the garden gate instead.";

describe("self-echo token overlap", () => {
  it.each([
    ["exact echo", spoken],
    ["partial echo", "Use the garden gate instead"],
    ["ASR errors", "the north entrance was close please use a garden gate instead"],
    ["punctuation and case", "I’M SOTTO!"],
  ])("recognizes %s", (_name, captured) => {
    expect(isSelfEcho(captured, [spoken])).toBe(true);
  });

  it.each([
    ["unrelated side talk", "Alex cannot attend Thursday afternoon"],
    ["quoting a few words", "You mentioned garden gate but Alex needs parking directions tomorrow"],
    ["empty text", "..."],
  ])("keeps %s", (_name, captured) => {
    expect(isSelfEcho(captured, [spoken])).toBe(false);
  });

  it("includes the 0.6 boundary and does not inflate repeated words", () => {
    expect(echoOverlap("one two three extra words", "one two three")).toBe(0.6);
    expect(isSelfEcho("one two three extra words", ["one two three"])).toBe(true);
    expect(echoOverlap("gate gate gate gate", "garden gate")).toBe(0.25);
    expect(isSelfEcho("hello", [])).toBe(false);
  });

  it("does not pool unrelated utterances into a match", () => {
    expect(isSelfEcho("one two three four five", ["one two", "three four"])).toBe(false);
  });
});
