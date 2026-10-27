/** Minimal RIFF/WAVE reader: enough to confirm a fixture's format and get its samples. */
import { readFileSync } from "node:fs";

export interface WavAudio {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Raw little-endian sample data, with the RIFF framing stripped. */
  data: Buffer;
}

/** Parses a WAV from memory. Throws when the RIFF framing is missing or truncated. */
export function parseWav(buffer: Buffer): WavAudio {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("not a RIFF/WAVE file");
  }

  let format: Omit<WavAudio, "data"> | undefined;
  let data: Buffer | undefined;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(body, body + Math.min(size, buffer.length - body));
    }
    offset = body + size + (size % 2);
  }

  if (!format || !data) throw new Error("missing fmt or data chunk");
  return { ...format, data };
}

/** Reads and parses a WAV file. */
export function readWavFile(path: string): WavAudio {
  return parseWav(readFileSync(path));
}
