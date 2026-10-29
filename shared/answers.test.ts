import { describe, expect, it } from "vitest";
import {
  ANSWER_DETAIL_MAX_WORDS,
  ANSWER_HEADLINE_MAX_CHARS,
  ASK_QUESTION_MAX_CHARS,
  AskRequestSchema,
  splitAnswer,
} from "./answers.js";

describe("splitAnswer", () => {
  it("takes the first line as the headline and the rest as the detail", () => {
    const text = [
      "Notion is $12, Evernote $25, Confluence $5.42 a seat",
      "",
      "- **Notion:** Plus $12/user/mo",
      "- **Evernote:** Teams $24.99/user/mo",
    ].join("\n");

    const answer = splitAnswer(text);
    expect(answer.headline).toBe("Notion is $12, Evernote $25, Confluence $5.42 a seat");
    expect(answer.detailMd).toBe(
      "- **Notion:** Plus $12/user/mo\n- **Evernote:** Teams $24.99/user/mo",
    );
    expect(answer.sources).toEqual([]);
    expect(answer.headlineComplete).toBe(true);
  });

  it("reads a half-written reply, and says the headline is not finished yet", () => {
    const answer = splitAnswer("Notion is $12, Evernote");
    expect(answer.headline).toBe("Notion is $12, Evernote");
    expect(answer.headlineComplete).toBe(false);
    expect(answer.detailMd).toBe("");
  });

  it("calls the headline finished as soon as a second line exists", () => {
    expect(splitAnswer("The answer\n").headlineComplete).toBe(true);
    expect(splitAnswer("The answer\n\nSome detail").detailMd).toBe("Some detail");
  });

  it("has nothing to say about an empty reply", () => {
    expect(splitAnswer("   \n\n")).toEqual({
      headline: "",
      detailMd: "",
      sources: [],
      headlineComplete: false,
    });
  });

  it("strips the markdown a headline can arrive wearing", () => {
    expect(splitAnswer("## What rivals charge\n\nx").headline).toBe("What rivals charge");
    expect(splitAnswer("**What rivals charge**\n\nx").headline).toBe("What rivals charge");
    expect(splitAnswer("- What rivals charge\n\nx").headline).toBe("What rivals charge");
  });

  it("clips a long headline at a word boundary", () => {
    const long = `${"price ".repeat(30)}end`;
    const headline = splitAnswer(`${long}\n\nx`).headline;
    expect(headline.length).toBeLessThanOrEqual(ANSWER_HEADLINE_MAX_CHARS);
    expect(headline.endsWith("…")).toBe(true);
    expect(headline).not.toContain("  ");
  });

  it("clips a long detail to the word limit and keeps its line breaks", () => {
    const detail = Array.from({ length: 60 }, (_, index) => `- bullet ${index} with words`).join(
      "\n",
    );
    const answer = splitAnswer(`Headline\n\n${detail}`);
    const words = answer.detailMd.split(/\s+/).filter((word) => word !== "");
    // The ellipsis joins the last word, so the clip is at most one token over.
    expect(words.length).toBeLessThanOrEqual(ANSWER_DETAIL_MAX_WORDS);
    expect(answer.detailMd).toContain("\n");
    expect(answer.detailMd.endsWith("…")).toBe(true);
  });

  it("pulls a Sources block out of the detail", () => {
    const text = [
      "Team notes run $5-$25 a seat",
      "",
      "- **Notion:** $12",
      "",
      "Sources:",
      "- Notion Pricing 2026 - https://example.com/notion",
      "- [Confluence pricing](https://example.com/confluence)",
    ].join("\n");

    const answer = splitAnswer(text);
    expect(answer.detailMd).toBe("- **Notion:** $12");
    expect(answer.sources).toEqual([
      { title: "Notion Pricing 2026", url: "https://example.com/notion" },
      { title: "Confluence pricing", url: "https://example.com/confluence" },
    ]);
  });

  it("reads the other shapes a source arrives in", () => {
    const text = [
      "Headline",
      "",
      "**Sources:** - Bare https://example.com/one, and trailing punctuation.",
      "https://example.com/two",
      "- https://example.com/one",
      "not a source at all",
    ].join("\n");

    const answer = splitAnswer(text);
    expect(answer.sources).toEqual([
      { title: "Bare", url: "https://example.com/one" },
      { title: "", url: "https://example.com/two" },
    ]);
  });

  it("leaves the detail alone when the model lists no sources", () => {
    const answer = splitAnswer("Headline\n\nThe board already says this: we ship in March.");
    expect(answer.sources).toEqual([]);
    expect(answer.detailMd).toBe("The board already says this: we ship in March.");
  });
});

describe("AskRequestSchema", () => {
  it("takes a typed question, trimmed (US-019)", () => {
    const parsed = AskRequestSchema.parse({ question: "  what did we decide?  " });
    expect(parsed.question).toBe("what did we decide?");
  });

  it("refuses a question that is blank or longer than the box allows", () => {
    for (const question of ["", "   ", "x".repeat(ASK_QUESTION_MAX_CHARS + 1)]) {
      expect(() => AskRequestSchema.parse({ question })).toThrow();
    }
    expect(() =>
      AskRequestSchema.parse({ question: "x".repeat(ASK_QUESTION_MAX_CHARS) }),
    ).not.toThrow();
  });
});
