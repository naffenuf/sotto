import { describe, expect, it } from "vitest";
import { correctedName, introducedName, introducedNames } from "./speakerIntroductions.js";

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

describe("a name corrected by somebody else", () => {
  it("reads the correction off the front of the turn", () => {
    expect(correctedName("No, that was EJ. Okay. So we're planning our trip")).toBe("EJ");
    expect(correctedName("It's EJ, not AJ.")).toBe("EJ");
    expect(correctedName("Her name is Priya")).toBe("Priya");
    expect(correctedName("Actually that's Jordan")).toBe("Jordan");
  });

  it("does not read ordinary sentences as corrections", () => {
    expect(correctedName("That was fine")).toBeNull();
    expect(correctedName("It's Thursday then")).toBeNull();
    expect(correctedName("No, that was the plan all along")).toBeNull();
    expect(correctedName("She's right about the bus")).toBeNull();
    expect(correctedName("I think that was EJ")).toBeNull();
  });
});
