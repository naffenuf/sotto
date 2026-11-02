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

  it("does not let function words match a long answer", () => {
    // The checkpoint session: a room member's line said over Sotto's status
    // answer, which shares only "and the has to on the page" with it.
    const answer =
      "Here's where you're at on the launch workshop. You're three weeks out and you've decided " +
      "on the Makerspace. It has a hard cap of thirty people, the grant covers thirty kits, and " +
      "Saturday is two hundred dollars flat. The plan is to start at eleven and feed people, and " +
      "you want the Bend crowd there. For tickets you're talking about opening fifty at five " +
      "dollars each, with the page going up tonight and invites Friday, and you expect twenty " +
      "alone from Bend. The open tension is fifty tickets for a thirty cap room, with the idea " +
      "that no shows make the oversell fine and a five dollar ticket";
    expect(isSelfEcho(" Oh wait and the kits list has to go on the page? ", [answer])).toBe(false);
    // The same answer, heard back in part, still matches.
    expect(isSelfEcho("the grant covers thirty kits and Saturday is two hundred dollars flat", [answer])).toBe(true);
  });

  it("does not pool unrelated utterances into a match", () => {
    expect(isSelfEcho("one two three four five", ["one two", "three four"])).toBe(false);
  });
});
