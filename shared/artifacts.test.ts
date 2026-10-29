import { describe, expect, it } from "vitest";
import {
  ARTIFACT_CSP,
  ARTIFACT_FILE_PATTERN,
  ARTIFACT_HTML_MAX_BYTES,
  ARTIFACT_TITLE_MAX_CHARS,
  ShowHtmlArgsSchema,
  artifactFileName,
  artifactSlug,
  artifactUrl,
  showHtmlJsonSchema,
} from "./artifacts.js";

describe("artifact file names", () => {
  it("numbers from 01 and slugs the title", () => {
    expect(artifactFileName(1, "User flow")).toBe("01-user-flow.html");
    expect(artifactFileName(2, "Pricing: a comparison!")).toBe("02-pricing-a-comparison.html");
    expect(artifactFileName(12, "Timeline")).toBe("12-timeline.html");
    // Numbering past 99 keeps going rather than wrapping.
    expect(artifactFileName(100, "x")).toBe("100-x.html");
  });

  it("always produces a name, whatever the title was", () => {
    expect(artifactSlug("")).toBe("artifact");
    expect(artifactSlug("…???…")).toBe("artifact");
    expect(artifactSlug("  Leading and trailing  ")).toBe("leading-and-trailing");
    // Cut at 40 characters, and never left ending in a dash.
    const long = artifactSlug("a".repeat(30) + " " + "b".repeat(30));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
  });

  it("recognises its own names and nothing else", () => {
    expect(ARTIFACT_FILE_PATTERN.test(artifactFileName(1, "User flow"))).toBe(true);
    expect(ARTIFACT_FILE_PATTERN.test(artifactFileName(7, "…???…"))).toBe(true);
    for (const bad of [
      "../session.json",
      "01-user-flow.html/../..",
      "..",
      ".env",
      "01-user-flow.htm",
      "board.md",
      "01-User-Flow.html",
      "01-user flow.html",
      "01-.html",
    ]) {
      expect(ARTIFACT_FILE_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it("builds a URL under the session it belongs to", () => {
    expect(artifactUrl("events-ask-diagram-1", "01-user-flow.html")).toBe(
      "/api/sessions/events-ask-diagram-1/artifacts/01-user-flow.html",
    );
  });
});

describe("ShowHtmlArgsSchema", () => {
  it("takes a document and clips an overlong title rather than refusing it", () => {
    const parsed = ShowHtmlArgsSchema.parse({
      title: "  The  user   flow\n ",
      html: "<!DOCTYPE html><html><body><svg/></body></html>",
    });
    expect(parsed.title).toBe("The user flow");
    expect(parsed.html).toContain("<svg/>");

    const clipped = ShowHtmlArgsSchema.parse({ title: "word ".repeat(40), html: "<p>x</p>" });
    expect(clipped.title.length).toBeLessThanOrEqual(ARTIFACT_TITLE_MAX_CHARS);
    expect(clipped.title.endsWith("…")).toBe(true);
  });

  it("refuses an empty document and one too big to be a glance", () => {
    expect(ShowHtmlArgsSchema.safeParse({ title: "x", html: "   " }).success).toBe(false);
    expect(
      ShowHtmlArgsSchema.safeParse({ title: "x", html: "x".repeat(ARTIFACT_HTML_MAX_BYTES + 1) })
        .success,
    ).toBe(false);
  });
});

describe("showHtmlJsonSchema", () => {
  it("says the same thing as the zod schema", () => {
    expect(Object.keys(showHtmlJsonSchema.properties)).toEqual(
      Object.keys(ShowHtmlArgsSchema.shape),
    );
    // Strict function calling wants every property required and the object
    // closed, which is also what the parser assumes.
    expect([...showHtmlJsonSchema.required]).toEqual(Object.keys(showHtmlJsonSchema.properties));
    expect(showHtmlJsonSchema.additionalProperties).toBe(false);
  });

  it("uses no keyword strict mode rejects", () => {
    const json = JSON.stringify(showHtmlJsonSchema);
    for (const keyword of ["minLength", "maxLength", "minItems", "maxItems", "oneOf", "format"]) {
      expect(json, keyword).not.toContain(`"${keyword}"`);
    }
    // The limits are advice the model reads, not validation it never sees.
    expect(showHtmlJsonSchema.properties.title.description).toContain("60 characters");
    expect(showHtmlJsonSchema.properties.html.description).toContain("self-contained");
  });
});

describe("ARTIFACT_CSP", () => {
  it("blocks everything an artifact could reach for", () => {
    // Exactly what PRD US-020 asks for; the iframe's missing
    // `allow-same-origin` is the other half.
    expect(ARTIFACT_CSP).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:",
    );
  });
});
