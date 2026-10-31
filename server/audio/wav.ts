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

/** Mono 16-bit PCM is the only thing Sotto writes, so the header is fixed but the rate is not. */
export interface WavFormat {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

/**
 * Wraps raw little-endian PCM in RIFF framing — the inverse of
 * {@link parseWav}, used by the fixture renderer.
 */
export function encodeWav(data: Buffer, format: WavFormat): Buffer {
  const { channels, sampleRate, bitsPerSample } = format;
  const bytesPerFrame = (bitsPerSample / 8) * channels;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM, uncompressed
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  header.writeUInt16LE(bytesPerFrame, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
