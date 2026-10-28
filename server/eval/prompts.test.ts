import { describe, expect, it } from "vitest";
import { PROMPTS } from "../prompts/index.js";
import { hashOf } from "./judge.js";
import { promptHashes } from "./prompts.js";

describe("promptHashes", () => {
  it("hashes every prompt the server has, named by its repo path", () => {
    const hashes = promptHashes();
    expect(hashes.map((one) => one.file)).toEqual(
      Object.values(PROMPTS).map((name) => `server/prompts/${name}.md`),
    );
  });

  it("hashes the text the model is given, so the judge's own hash agrees", () => {
    const judge = promptHashes().find((one) => one.file === "server/prompts/judge.md");
    expect(judge?.hash).toHaveLength(12);
    expect(judge?.hash).not.toBe(hashOf(""));
  });

  it("gives every prompt a different hash", () => {
    const hashes = promptHashes().map((one) => one.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});
