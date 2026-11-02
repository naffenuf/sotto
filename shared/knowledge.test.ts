/**
 * V3-009: how the group's own files are named, cited and resolved.
 */
import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_CITATION_PREFIX,
  KNOWLEDGE_EXTENSIONS,
  SearchKnowledgeArgsSchema,
  knowledgeCitation,
  isKnowledgeCitation,
  renderKnowledgeResults,
  resolveKnowledgeCitation,
  searchKnowledgeDescription,
  searchKnowledgeJsonSchema,
} from "./knowledge.js";

describe("a file as a source", () => {
  it("is named `file: <name>`, never a URL", () => {
    const citation = knowledgeCitation("customers.csv");
    expect(citation.url).toBe("file:customers.csv");
    expect(citation.title).toBe("file: customers.csv");
    expect(isKnowledgeCitation(citation.url)).toBe(true);
    expect(isKnowledgeCitation(citation.title)).toBe(true);
  });

  it("is told apart from every page a search can return", () => {
    for (const url of [
      "https://example.com/pricing",
      "http://en.wikipedia.org",
      "example.com/file:notes.md",
      "",
    ]) {
      expect(isKnowledgeCitation(url)).toBe(false);
    }
  });
});

describe("resolving a file the model named", () => {
  const read = ["customers.csv", "prices.csv", "notes.md"];

  it("takes every spelling of a file the search really read", () => {
    for (const named of [
      "customers.csv",
      "file:customers.csv",
      "file: customers.csv",
      "  FILE: Customers.CSV ",
      "knowledge/customers.csv",
      "fixtures/knowledge-demo/customers.csv",
    ]) {
      expect(resolveKnowledgeCitation(named, read)).toBe("customers.csv");
    }
  });

  it("drops a file nothing returned, as an unopened page is dropped", () => {
    expect(resolveKnowledgeCitation("revenue.csv", read)).toBeUndefined();
    expect(resolveKnowledgeCitation("file:", read)).toBeUndefined();
    expect(resolveKnowledgeCitation("", read)).toBeUndefined();
    expect(resolveKnowledgeCitation("https://example.com/customers.csv", read)).toBeUndefined();
  });
});

describe("the tool's two schemas", () => {
  it("agree, and stay inside what strict function calling accepts", () => {
    expect(searchKnowledgeJsonSchema.additionalProperties).toBe(false);
    expect([...searchKnowledgeJsonSchema.required]).toEqual(
      Object.keys(searchKnowledgeJsonSchema.properties),
    );
    const serialized = JSON.stringify(searchKnowledgeJsonSchema);
    for (const keyword of ["minLength", "maxLength", "minItems", "maxItems", "oneOf"]) {
      expect(serialized).not.toContain(keyword);
    }
  });

  it("normalises a query and refuses an empty one", () => {
    expect(SearchKnowledgeArgsSchema.parse({ query: "  Harborview   renewal\n" })).toEqual({
      query: "Harborview renewal",
    });
    expect(SearchKnowledgeArgsSchema.safeParse({ query: "   " }).success).toBe(false);
    expect(SearchKnowledgeArgsSchema.safeParse({}).success).toBe(false);
  });

  it("tells the model which files there are, and how to cite one", () => {
    const description = searchKnowledgeDescription(["customers.csv", "notes.md"]);
    expect(description).toContain("customers.csv, notes.md");
    expect(description).toContain(KNOWLEDGE_CITATION_PREFIX);
  });
});

describe("what one search hands back", () => {
  it("names the file and the line of every match", () => {
    const text = renderKnowledgeResults("harborview renewal", [
      { file: "customers.csv", line: 2, text: "customer,renews_on | Harborview Clinic,2027-03-01" },
    ]);
    expect(text).toContain("customers.csv (line 2)");
    expect(text).toContain("2027-03-01");
    expect(text).toContain("file: customers.csv");
  });

  it("says so plainly when the files know nothing about it", () => {
    const text = renderKnowledgeResults("tide times", []);
    expect(text).toContain("Nothing in the group's files matches");
    expect(text).toContain("the web");
  });
});

describe("which files are read at all", () => {
  it("is plain text only", () => {
    expect([...KNOWLEDGE_EXTENSIONS]).toEqual([".md", ".txt", ".csv"]);
  });
});
