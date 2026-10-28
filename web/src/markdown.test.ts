import { describe, expect, it } from "vitest";
import { isWebUrl, parseInline, parseMarkdown } from "./markdown.js";

describe("parseInline", () => {
  it("leaves plain text alone", () => {
    expect(parseInline("just words")).toEqual([{ kind: "text", text: "just words" }]);
  });

  it("reads bold, italics and code around the text between them", () => {
    expect(parseInline("a **b** c *d* e `f`")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", text: "b" },
      { kind: "text", text: " c " },
      { kind: "em", text: "d" },
      { kind: "text", text: " e " },
      { kind: "code", text: "f" },
    ]);
  });

  it("prefers bold over italics when both could match", () => {
    expect(parseInline("**both**")).toEqual([{ kind: "strong", text: "both" }]);
  });

  it("reads underscores as italics", () => {
    expect(parseInline("_quietly_")).toEqual([{ kind: "em", text: "quietly" }]);
  });

  it("reads a web link", () => {
    expect(parseInline("see [the table](https://example.com/x)")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "the table", href: "https://example.com/x" },
    ]);
  });

  it("keeps a link to anything but the web as literal text", () => {
    expect(parseInline("[click](javascript:alert)")).toEqual([
      { kind: "text", text: "[click](javascript:alert)" },
    ]);
    expect(parseInline("[click](/sessions)")).toEqual([
      { kind: "text", text: "[click](/sessions)" },
    ]);
    // Whatever the URL looks like, nothing but http(s) becomes an href.
    expect(parseInline("[click](javascript:alert(1))").some((span) => span.kind === "link")).toBe(
      false,
    );
  });

  it("leaves an unclosed marker as text", () => {
    expect(parseInline("2 * 3 is 6")).toEqual([{ kind: "text", text: "2 * 3 is 6" }]);
  });
});

describe("parseMarkdown", () => {
  it("joins the lines of a paragraph and splits on a blank line", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { kind: "paragraph", spans: [{ kind: "text", text: "one two" }] },
      { kind: "paragraph", spans: [{ kind: "text", text: "three" }] },
    ]);
  });

  it("reads a bullet list as one block", () => {
    const blocks = parseMarkdown("intro\n\n- first\n* second\n\nafter");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "bullets", "paragraph"]);
    const bullets = blocks[1];
    if (bullets?.kind !== "bullets") throw new Error("expected a bullet list");
    expect(bullets.items).toEqual([
      [{ kind: "text", text: "first" }],
      [{ kind: "text", text: "second" }],
    ]);
  });

  it("reads a numbered list, however the numbers are written", () => {
    const blocks = parseMarkdown("1. first\n2) second\n7. third");
    expect(blocks).toHaveLength(1);
    const numbers = blocks[0];
    if (numbers?.kind !== "numbers") throw new Error("expected a numbered list");
    expect(numbers.items.map(([span]) => (span?.kind === "text" ? span.text : ""))).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("ends a list at the next paragraph without eating it", () => {
    const blocks = parseMarkdown("- only one\nnot an item");
    expect(blocks).toEqual([
      { kind: "bullets", items: [[{ kind: "text", text: "only one" }]] },
      { kind: "paragraph", spans: [{ kind: "text", text: "not an item" }] },
    ]);
  });

  it("reads headings up to three deep and no further", () => {
    expect(parseMarkdown("# one\n### three\n#### four")).toEqual([
      { kind: "heading", level: 1, spans: [{ kind: "text", text: "one" }] },
      { kind: "heading", level: 3, spans: [{ kind: "text", text: "three" }] },
      { kind: "paragraph", spans: [{ kind: "text", text: "#### four" }] },
    ]);
  });

  it("parses spans inside list items", () => {
    const blocks = parseMarkdown("- a **bold** one");
    const bullets = blocks[0];
    if (bullets?.kind !== "bullets") throw new Error("expected a bullet list");
    expect(bullets.items[0]).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", text: "bold" },
      { kind: "text", text: " one" },
    ]);
  });

  it("has nothing to say about nothing", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n  \n")).toEqual([]);
  });

  it("survives Windows line endings", () => {
    expect(parseMarkdown("one\r\n\r\ntwo")).toHaveLength(2);
  });
});

describe("isWebUrl", () => {
  it("takes http and https only", () => {
    expect(isWebUrl("https://example.com/a")).toBe(true);
    expect(isWebUrl("http://example.com")).toBe(true);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("data:text/html,<b>")).toBe(false);
    expect(isWebUrl("/relative")).toBe(false);
  });
});
