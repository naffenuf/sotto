import { describe, expect, it } from "vitest";
import { introducedName, introducedNames } from "./speakerIntroductions.js";

describe("self-introductions", () => {
  it.each([
    ["I'm Alex, I coordinate a community garden.", "Alex"],
    ["And I'm Sam I help build small tools.", "Sam"],
    ["Hello, my name is Craig.", "Craig"],
    ["Hi, I'm Zoë.", "Zoë"],
    ["I am Anne-Marie.", "Anne-Marie"],
    ["This is Craig, I have a question.", "Craig"],
  ])("recognizes %s", (text, name) => expect(introducedName(text)).toBe(name));
  it.each([
    "I'm planning a workshop.", "I'm happy to help.", "I'm Ready.",
    "I'm meeting Jordan tomorrow.", "I'm a volunteer.",
    "Jordan said I'm Alex.", "I'm Sotto.",
    "This is a problem.", "This is Craig’s idea.",
  ])("does not guess from %s", (text) => expect(introducedName(text)).toBeNull());
});

describe("two introductions in one turn", () => {
  it("keeps every name, in order", () => {
    expect(introducedNames("I'm Craig. I'm EJ. Okay, so we're three weeks out from the launch.")).toEqual(["Craig", "EJ"]);
    expect(introducedNames("Hi, I'm Alex, I coordinate a garden. And I'm Sam I help build small tools.")).toEqual(["Alex", "Sam"]);
  });
  it("still refuses what a single introduction refuses", () => {
    expect(introducedNames("I'm Craig. I'm happy to help. Jordan said I'm Alex.")).toEqual(["Craig"]);
    expect(introducedNames("I'm planning a workshop.")).toEqual([]);
  });
});
