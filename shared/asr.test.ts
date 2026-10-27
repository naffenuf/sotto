import { describe, expect, it } from "vitest";
import { asAsrEvent, parseAsrFrameRecords } from "./asr.js";

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

describe("asAsrEvent", () => {
  it("narrows each of the five turn frames", () => {
    const frames = [
      { type: "speechStart", turnId: 3, audioProcessedMs: 60 },
      { type: "transcript", transcript: " Okay, so", final: false, audioProcessedMs: 1440 },
      { type: "speaker", label: "B", audioProcessedMs: 4160 },
      { type: "speechEnd", turnId: 3, audioProcessedMs: 9820 },
      { type: "speechComplete", turnId: 3, transcript: " Okay, so. ", audioProcessedMs: 9820 },
    ];
    for (const frame of frames) {
      expect(asAsrEvent(frame)).toEqual({ event: frame });
    }
  });

  it("returns null for frames that say nothing about turns", () => {
    expect(asAsrEvent({ sessionId: "voyager/duplex/ABC" })).toBeNull();
    expect(asAsrEvent({ type: "audioProgress", audioProcessedMs: 80 })).toBeNull();
    expect(asAsrEvent({ raw: "<binary frame>" })).toBeNull();
  });

  it("reports a known frame type that does not match its shape", () => {
    const narrowed = asAsrEvent({ type: "speechEnd", audioProcessedMs: 10 });
    expect(narrowed).not.toBeNull();
    expect(narrowed).toHaveProperty("error");
  });
});
