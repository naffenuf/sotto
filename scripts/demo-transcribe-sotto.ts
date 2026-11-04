/**
 * Gives Sotto's lines in a demo take word positions, so a cut can land
 * between two of its sentences without guessing.
 *
 * The session never records where inside an utterance Sotto was: its
 * transcript rows have a start and nothing else. So this takes Sotto's own
 * channel out of the take (the centre of the stereo; while EJ or Craig talks
 * over it, the side they are *not* on), sends only the stretches where Sotto
 * is talking through the realtime transcription — the same instrument the
 * room's partials come from — and writes the frames with a map back to the
 * take's clock. `scripts/demo/take.mjs` reads it if it is there.
 *
 *   npm run demo:transcribe-sotto      # real API, real time: ~2 min, a few cents
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { RealtimeTranscriptionClient } from "../server/asr/realtimeClient.js";
import { WavReplaySource } from "../server/audio/WavReplaySource.js";
import { encodeWav } from "../server/audio/wav.js";
import { loadConfig } from "../server/config.js";
import type { AsrFrameRecord } from "../shared/asr.js";
// @ts-expect-error plain .mjs helpers without type declarations
import { TAKE, sottoAsrPath } from "./demo/config.mjs";
// @ts-expect-error plain .mjs helpers without type declarations
import { FRAME_S, analyseTake } from "./demo/take.mjs";

const RATE = 24_000;
/** Kept either side of a stretch, so the first and last word are whole. */
const MARGIN_S = 0.25;
/** Silence between stretches, long enough for the endpointer to close a turn. */
const SPACER_S = 2.0;

interface Stretch {
  takeStart: number;
  takeEnd: number;
  wavStart: number;
}

const analysis = analyseTake({ take: TAKE.video, session: TAKE.session, sottoAsr: false });
const spans: Array<[number, number]> = analysis.lines
  .filter((l: { voice: string; measured: boolean; out: number; in: number }) => l.voice === "S" && l.measured && l.out - l.in > 0.2)
  .map((l: { in: number; out: number }) => [Math.max(0, l.in - MARGIN_S), l.out + MARGIN_S]);

const raw = execFileSync("ffmpeg", ["-v", "error", "-i", TAKE.video, "-vn", "-ac", "2", "-ar", String(RATE), "-f", "s16le", "-"], {
  maxBuffer: 1 << 30,
});
const stereo = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
const perFrame = Math.round(RATE * FRAME_S);

const pieces: Int16Array[] = [];
const stretches: Stretch[] = [];
let wavAt = SPACER_S;
pieces.push(new Int16Array(Math.round(SPACER_S * RATE)));
for (const [from, to] of spans) {
  const a = Math.round(from * RATE), b = Math.round(to * RATE);
  const mono = new Int16Array(b - a);
  for (let i = a; i < b; i++) {
    const f = Math.floor(i / perFrame);
    const e = analysis.voices.E[f], c = analysis.voices.C[f];
    const l = stereo[2 * i] ?? 0, r = stereo[2 * i + 1] ?? 0;
    // Sotto is on both sides; a person is on one. Keep the side nobody else is on.
    mono[i - a] = e && c ? 0 : c ? l : e ? r : (l + r) >> 1;
  }
  stretches.push({ takeStart: from, takeEnd: to, wavStart: wavAt });
  pieces.push(mono, new Int16Array(Math.round(SPACER_S * RATE)));
  wavAt += to - from + SPACER_S;
}
const total = pieces.reduce((n, p) => n + p.length, 0);
const pcm = Buffer.alloc(total * 2);
let off = 0;
for (const p of pieces) {
  pcm.set(Buffer.from(p.buffer, p.byteOffset, p.byteLength), off);
  off += p.byteLength;
}
mkdirSync("demo/build", { recursive: true });
const wavPath = `demo/build/${TAKE.name}.sotto.wav`;
writeFileSync(wavPath, encodeWav(pcm, { channels: 1, sampleRate: RATE, bitsPerSample: 16 }));
console.log(`${wavPath}: ${stretches.length} stretches, ${(total / RATE).toFixed(1)} s, transcribing at real time…`);

const frames: AsrFrameRecord[] = [];
const client = new RealtimeTranscriptionClient({ apiKey: loadConfig().modelApiKey, onFrame: (r) => frames.push(r) });
await client.run(new WavReplaySource(wavPath));

const out = sottoAsrPath();
writeFileSync(out, JSON.stringify({ take: TAKE.video, stretches, frames }) + "\n");
const turns = frames.filter((r) => (r.frame as { type?: string }).type === "speechComplete").length;
console.log(`${out}: ${frames.length} frames, ${turns} turns`);
