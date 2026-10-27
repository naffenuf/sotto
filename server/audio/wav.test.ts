import { describe, expect, it } from "vitest";
import { parseWav } from "./wav.js";

/** Builds a RIFF file from arbitrary chunks, to exercise the chunk walker. */
function riff(chunks: Array<{ id: string; body: Buffer }>): Buffer {
  const parts = chunks.map(({ id, body }) => {
    const header = Buffer.alloc(8);
    header.write(id, 0, "ascii");
    header.writeUInt32LE(body.length, 4);
    // RIFF chunks are word-aligned.
    const pad = body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([header, body, pad]);
  });
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + payload.length, 4);
  head.write("WAVE", 8, "ascii");
  return Buffer.concat([head, payload]);
}

function fmtChunk(channels: number, sampleRate: number, bitsPerSample: number): Buffer {
  const body = Buffer.alloc(16);
  const bytesPerFrame = (bitsPerSample / 8) * channels;
  body.writeUInt16LE(1, 0);
  body.writeUInt16LE(channels, 2);
  body.writeUInt32LE(sampleRate, 4);
  body.writeUInt32LE(sampleRate * bytesPerFrame, 8);
  body.writeUInt16LE(bytesPerFrame, 12);
  body.writeUInt16LE(bitsPerSample, 14);
  return body;
}

describe("parseWav", () => {
  it("skips chunks it does not care about, including odd-sized ones", () => {
    const data = Buffer.from(Int16Array.of(1, 2, 3).buffer);
    const file = riff([
      { id: "fmt ", body: fmtChunk(1, 24_000, 16) },
      { id: "LIST", body: Buffer.from("INFOsotto", "ascii") },
      { id: "data", body: data },
    ]);

    expect(parseWav(file)).toEqual({
      channels: 1,
      sampleRate: 24_000,
      bitsPerSample: 16,
      data,
    });
  });

  it("clamps a data chunk whose declared size runs past the end of the file", () => {
    const file = riff([
      { id: "fmt ", body: fmtChunk(1, 24_000, 16) },
      { id: "data", body: Buffer.alloc(64) },
    ]);
    file.writeUInt32LE(4_000, file.length - 64 - 4);
    const truncated = file.subarray(0, file.length - 10);

    expect(parseWav(truncated).data).toHaveLength(54);
  });

  it("rejects a file with no fmt chunk", () => {
    const file = riff([{ id: "data", body: Buffer.alloc(64) }]);
    expect(() => parseWav(file)).toThrow(/missing fmt or data chunk/);
  });
});
