import { describe, expect, it } from "vitest";
import { parseAsrFrameRecords } from "./asr.js";

const lines = [
  { atMs: 598.27, session: 0, frame: { sessionId: "voyager/duplex/ABC" } },
  { atMs: 718.71, session: 0, frame: { type: "speechStart", audioProcessedMs: 60, turnId: 0 } },
  { atMs: 4330.26, session: 1, frame: { type: "speaker", label: "A", audioProcessedMs: 4160 } },
];

describe("parseAsrFrameRecords", () => {
  it("reads a capture back, ignoring blank lines", () => {
    const jsonl = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n\n`;
    expect(parseAsrFrameRecords(jsonl)).toEqual(lines);
  });

  it("names the line that is not a frame record", () => {
    const jsonl = `${JSON.stringify(lines[0])}\n${JSON.stringify({ atMs: -1, session: 0, frame: {} })}\n`;
    expect(() => parseAsrFrameRecords(jsonl)).toThrow(/line 2/);
  });
});
