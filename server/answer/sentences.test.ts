import { describe, expect, it } from "vitest";
import { splitSentences } from "./sentences.js";

describe("splitSentences", () => {
  it("holds back a sentence that is still being written", () => {
    expect(splitSentences("Notion is twelve dollars a")).toEqual({
      sentences: [],
      tail: "Notion is twelve dollars a",
    });
  });

  it("holds back a full stop until something follows it", () => {
    // The stop could still turn out to be a decimal point.
    expect(splitSentences("Notion is twelve dollars.")).toEqual({
      sentences: [],
      tail: "Notion is twelve dollars.",
    });
    expect(splitSentences("Notion is twelve dollars. ").sentences).toEqual([
      "Notion is twelve dollars.",
    ]);
  });

  it("does not read a price as two sentences", () => {
    const { sentences, tail } = splitSentences("Confluence is $5.42 a seat. Notion");
    expect(sentences).toEqual(["Confluence is $5.42 a seat."]);
    expect(tail.trim()).toBe("Notion");
  });

  it("keeps the terminator and whatever closes the sentence with it", () => {
    expect(splitSentences('She asked "how much?" Then left. ').sentences).toEqual([
      'She asked "how much?"',
      "Then left.",
    ]);
  });

  it("ends a sentence at a line break, since a list never terminates one", () => {
    const { sentences, tail } = splitSentences("Three things\nFirst one\nSecond");
    expect(sentences).toEqual(["Three things", "First one"]);
    expect(tail).toBe("Second");
  });

  it("skips blank lines rather than offering them as sentences", () => {
    expect(splitSentences("One.\n\n\nTwo.\n").sentences).toEqual(["One.", "Two."]);
  });

  it("will not split on an initial or a stray dot", () => {
    expect(splitSentences("E. Haas wrote it. ").sentences).toEqual(["E. Haas wrote it."]);
  });

  it("loses nothing: the sentences and the tail rebuild the words", () => {
    const text = "First one. Second one! Third?\nFourth is unfinished";
    const { sentences, tail } = splitSentences(text);
    expect([...sentences, tail].join(" ").replace(/\s+/g, " ")).toBe(
      text.replace(/\s+/g, " "),
    );
  });
});
