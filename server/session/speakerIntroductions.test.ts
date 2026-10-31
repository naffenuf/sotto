import { describe, expect, it } from "vitest";
import { introducedName } from "./speakerIntroductions.js";

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
