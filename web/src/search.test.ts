import { describe, expect, it } from "vitest";
import { matchesQuery, normalizeQuery, splitMatches } from "./search.js";

describe("search", () => {
  it("normalizes a query by trimming and lowercasing", () => {
    expect(normalizeQuery("  Caterer ")).toBe("caterer");
    expect(normalizeQuery("   ")).toBe("");
  });

  it("matches case-insensitively and never on an empty query", () => {
    expect(matchesQuery("The $900 caterer", "cater")).toBe(true);
    expect(matchesQuery("The $900 CATERER", "caterer")).toBe(true);
    expect(matchesQuery("anything", "")).toBe(false);
  });

  it("splits text into plain and matching parts, keeping the original case", () => {
    expect(splitMatches("Bend to Portland, then Bend again", "bend")).toEqual([
      { text: "Bend", match: true },
      { text: " to Portland, then ", match: false },
      { text: "Bend", match: true },
      { text: " again", match: false },
    ]);
  });

  it("returns the whole text as one plain part when nothing matches, or nothing is asked", () => {
    expect(splitMatches("Thursday afternoon", "friday")).toEqual([{ text: "Thursday afternoon", match: false }]);
    expect(splitMatches("Thursday afternoon", "")).toEqual([{ text: "Thursday afternoon", match: false }]);
  });

  it("handles a match at the very end and adjacent matches", () => {
    expect(splitMatches("aa", "a")).toEqual([{ text: "a", match: true }, { text: "a", match: true }]);
    expect(splitMatches("x", "x")).toEqual([{ text: "x", match: true }]);
  });
});
