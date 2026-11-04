#!/usr/bin/env node
// Builds a hard-panned stereo mix of a rendered fixture for a demo video:
// speaker A on the left channel, speaker B on the right, using the line
// positions in `<name>.timing.json`. The mono WAV is what the server hears
// (the audio contract is mono); this file is only ever for the soundtrack.
//
//   node scripts/pan-fixture.mjs launch-workshop [out.wav]
//
// Needs ffmpeg on PATH. Output: 48 kHz 16-bit stereo, same length as the mono.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/pan-fixture.mjs <fixture> [out.wav]");
  process.exit(2);
}
const audioDir = resolve("fixtures/audio");
const mono = resolve(audioDir, `${name}.wav`);
const out = process.argv[3] ?? resolve(audioDir, `${name}.stereo.wav`);
const timing = JSON.parse(readFileSync(resolve(audioDir, `${name}.timing.json`), "utf8"));

// A line is kept on its own side with a little margin so no consonant is clipped.
const MARGIN_S = 0.05;
const gate = (speaker) =>
  timing.lines
    .filter((l) => l.speaker === speaker)
    .map((l) => `between(t,${(l.startMs / 1000 - MARGIN_S).toFixed(3)},${(l.endMs / 1000 + MARGIN_S).toFixed(3)})`)
    .join("+");

const speakers = [...new Set(timing.lines.map((l) => l.speaker))];
if (speakers.length !== 2) {
  console.error(`expected two speakers, found ${speakers.join(", ")}`);
  process.exit(1);
}
const [left, right] = speakers.sort();

// Two copies of the mono track; each is silenced wherever the *other*
// speaker is talking, then the pair is joined as L/R.
const filter = [
  `[0:a]asplit=2[l][r]`,
  `[l]volume=0:enable='${gate(right)}'[lo]`,
  `[r]volume=0:enable='${gate(left)}'[ro]`,
  `[lo][ro]join=inputs=2:channel_layout=stereo[out]`,
].join(";");

const args = ["-y", "-i", mono, "-filter_complex", filter, "-map", "[out]", "-ar", "48000", "-c:a", "pcm_s16le", out];
const result = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
if (result.status !== 0) {
  console.error(result.stderr.toString());
  process.exit(result.status ?? 1);
}
console.log(`${left} left, ${right} right -> ${out}`);
