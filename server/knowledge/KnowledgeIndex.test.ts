/**
 * V3-009: reading the knowledge folder, and searching it.
 *
 * The demo folder (`fixtures/knowledge-demo/`) is the one these run against
 * wherever they can, because it is the folder the integration test and the
 * demo use: a search that works on a temp file and not on that one is not
 * working.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_SNIPPET_MAX_CHARS } from "../../shared/knowledge.js";
import { KnowledgeIndex, contentWords } from "./KnowledgeIndex.js";

const quiet = { log: () => {}, warn: () => {} };
const DEMO = "fixtures/knowledge-demo";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sotto-knowledge-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loading a folder", () => {
  it("is null when there is no folder, which is the ordinary session", () => {
    expect(KnowledgeIndex.load(join(dir, "nothing-here"), { logger: quiet })).toBeNull();
  });

  it("is null when the folder holds nothing readable", () => {
    writeFileSync(join(dir, "logo.png"), "not text");
    writeFileSync(join(dir, "data.json"), "{}");
    expect(KnowledgeIndex.load(dir, { logger: quiet })).toBeNull();
  });

  it("takes .md, .txt and .csv and leaves everything else", () => {
    for (const name of ["notes.md", "scratch.txt", "customers.csv", "sheet.xlsx", "deck.pdf"]) {
      writeFileSync(join(dir, name), "renewal\n");
    }
    const index = KnowledgeIndex.load(dir, { logger: quiet });
    expect(index?.files()).toEqual(["customers.csv", "notes.md", "scratch.txt"]);
  });

  it("reads the demo folder", () => {
    const index = KnowledgeIndex.load(DEMO, { logger: quiet });
    // Name order, which is also the order they are searched in.
    expect(index?.files()).toEqual(["README.md", "customers.csv", "notes.md", "prices.csv"]);
  });
});

describe("searching", () => {
  it("answers a renewal question from the customer list, with its header", () => {
    const index = KnowledgeIndex.load(DEMO, { logger: quiet });
    const hits = index?.search("When does Harborview Clinic's contract renew?") ?? [];
    expect(hits.length).toBeGreaterThan(0);
    const first = hits[0];
    expect(first?.file).toBe("customers.csv");
    expect(first?.text).toContain("Harborview Clinic");
    expect(first?.text).toContain("2027-03-01");
    // A row of a CSV means nothing without its columns.
    expect(first?.text).toContain("renews_on");
    expect(first?.line).toBeGreaterThan(1);
  });

  it("finds the price of a plan, best line first", () => {
    const index = KnowledgeIndex.load(DEMO, { logger: quiet });
    const hits = index?.search("Pro plan price per seat") ?? [];
    // The one line that actually answers it: three of the four words, and
    // the number.
    expect(hits[0]?.file).toBe("notes.md");
    expect(hits[0]?.text).toContain("$40 per seat per month");
    expect(hits.some((hit) => hit.file === "prices.csv")).toBe(true);
  });

  it("matches on the words that mean something, not on the asking", () => {
    expect(contentWords("When does the Harborview contract renew?")).toEqual([
      "harborview",
      "contract",
      "renew",
    ]);
    // A query of nothing but filler matches nothing at all.
    const index = KnowledgeIndex.load(DEMO, { logger: quiet });
    expect(index?.search("when does it")).toEqual([]);
  });

  it("ranks a line carrying the whole phrase above one with the words scattered", () => {
    writeFileSync(
      join(dir, "notes.md"),
      ["The renewal is the thing.", "Harborview renewal is on the first of March."].join("\n"),
    );
    const index = KnowledgeIndex.load(dir, { logger: quiet });
    expect(index?.search("harborview renewal")[0]?.line).toBe(2);
  });

  it("returns the same snippets in the same order every time", () => {
    const index = KnowledgeIndex.load(DEMO, { logger: quiet });
    expect(index?.search("renewal date")).toEqual(index?.search("renewal date"));
  });

  it("clips a long line rather than handing over a file", () => {
    writeFileSync(join(dir, "notes.txt"), `renewal ${"x".repeat(2_000)}`);
    const index = KnowledgeIndex.load(dir, { logger: quiet });
    const hit = index?.search("renewal")[0];
    expect(hit?.text.length).toBeLessThanOrEqual(KNOWLEDGE_SNIPPET_MAX_CHARS);
    expect(hit?.text.endsWith("…")).toBe(true);
  });

  it("holds to its limit", () => {
    const index = KnowledgeIndex.load(DEMO, { logger: quiet });
    expect((index?.search("fictional", 3) ?? []).length).toBe(3);
    expect(index?.search("fictional", 0)).toEqual([]);
  });
});
