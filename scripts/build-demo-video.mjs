#!/usr/bin/env node
// Assembles the demo video from a recorded take, the rendered slides and the
// narration: see tasks/demo-video.md ("The cut").
//
//   node scripts/build-demo-video.mjs [demo/takes/take4.mov]
//
// Pieces are encoded to one format (1080p30 H.264, AAC 48 kHz stereo) and
// joined with the concat demuxer; the whole thing is loudness-normalised last.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const take = resolve(process.argv[2] ?? "demo/takes/take4.mov");
const build = resolve("demo/build");
const out = resolve("demo/sotto-demo.mp4");
mkdirSync(build, { recursive: true });

const FONT = "/Library/Fonts/SF-Compact.ttf";
// The Chrome window's tab strip, address bar and the extension banner sit in
// the top 145 px; the page content is 1719 px wide from x=101.
const FRAME = "crop=1719:935:101:145,scale=1920:-2,pad=1920:1080:0:(oh-ih)/2:black,fps=30,format=yuv420p";
const VIDEO = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", "30"];
const AUDIO = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
}
function duration(file) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
}

/** A callout: white text on a dark band, bottom third, for `seconds` from `at` (segment-local). */
function callout(text, at, seconds = 2.6) {
  const safe = text.replace(/\\/g, "\\\\").replace(/'/g, "’").replace(/:/g, "\\:");
  return (
    `drawtext=fontfile=${FONT}:text='${safe}':fontsize=44:fontcolor=white:` +
    `box=1:boxcolor=black@0.62:boxborderw=22:x=(w-text_w)/2:y=h-200:` +
    `enable='between(t,${at.toFixed(2)},${(at + seconds).toFixed(2)})'`
  );
}

// The cut, on the take's clock (tasks/demo-video.md). `callouts` are at take times.
const SEGMENTS = [
  { name: "A", from: 32.0, to: 38.3, fadeIn: 0.6 },
  { name: "A2", from: 51.9, to: 61.2 },
  { name: "B", from: 74.5, to: 83.4 },
  { name: "C", from: 88.4, to: 111.7, callouts: [[108.5, "Nobody asked. It waited for a pause."]] },
  { name: "C2", from: 135.0, to: 148.0, callouts: [[135.5, "A sourced answer, in the next gap."]] },
  { name: "D", from: 166.0, to: 177.9 },
  // "Sotto, go ahead" and the correction, with the 2.5 s the call-on takes
  // to be acted on cut out between them.
  { name: "E1", from: 208.2, to: 210.5 },
  {
    name: "E2", from: 212.9, to: 243.1,
    callouts: [[212.9, "It raised a hand. The room called on it."], [238.4, "It stops the moment anyone talks."]],
  },
  { name: "F", from: 248.0, to: 266.0, callouts: [[253.5, "A wrap-up from its own notes."]], fadeOut: 2.5 },
];

const parts = [];

function slide(name, { fadeIn = 0, fadeOut = 0, tail = 0.9 } = {}) {
  const png = resolve(build, `${name}.png`);
  const wav = resolve("demo/narration", `${name}.wav`);
  const len = duration(wav) + tail;
  const file = resolve(build, `slide-${name}.mp4`);
  const vf = [`scale=1920:1080,format=yuv420p`];
  if (fadeIn > 0) vf.push(`fade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut > 0) vf.push(`fade=t=out:st=${(len - fadeOut).toFixed(2)}:d=${fadeOut}`);
  const af = [`adelay=400|400`, `apad`];
  if (fadeOut > 0) af.push(`afade=t=out:st=${(len - fadeOut).toFixed(2)}:d=${fadeOut}`);
  ffmpeg([
    "-loop", "1", "-framerate", "30", "-i", png, "-i", wav,
    "-t", len.toFixed(2), "-vf", vf.join(","), "-af", af.join(","),
    ...VIDEO, ...AUDIO, "-shortest", file,
  ]);
  parts.push(file);
  console.log(`slide ${name}: ${len.toFixed(1)} s`);
}

function segment(seg) {
  const len = seg.to - seg.from;
  const file = resolve(build, `seg-${seg.name}.mp4`);
  const vf = [FRAME];
  for (const [at, text] of seg.callouts ?? []) vf.push(callout(text, at - seg.from));
  if (seg.fadeIn) vf.push(`fade=t=in:st=0:d=${seg.fadeIn}`);
  if (seg.fadeOut) vf.push(`fade=t=out:st=${(len - seg.fadeOut).toFixed(2)}:d=${seg.fadeOut}`);
  // 20 ms ramps at both ends so a cut never clicks.
  const af = [`afade=t=in:st=0:d=0.02`, `afade=t=out:st=${(len - (seg.fadeOut ?? 0.02)).toFixed(3)}:d=${seg.fadeOut ?? 0.02}`];
  ffmpeg([
    "-ss", seg.from.toFixed(3), "-to", seg.to.toFixed(3), "-i", take,
    "-vf", vf.join(","), "-af", af.join(","), ...VIDEO, ...AUDIO, file,
  ]);
  parts.push(file);
  console.log(`segment ${seg.name}: ${len.toFixed(1)} s`);
}

slide("01-title", { fadeIn: 0.6 });
slide("02-stack", { fadeOut: 0.4 });
for (const seg of SEGMENTS) segment(seg);
slide("03-end", { fadeIn: 0.5, fadeOut: 1.0, tail: 2.5 });

const list = resolve(build, "concat.txt");
writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n") + "\n");
const joined = resolve(build, "joined.mp4");
ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
// Loudness last, over the whole programme, video untouched.
ffmpeg(["-i", joined, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", ...AUDIO, "-movflags", "+faststart", out]);
console.log(`\n${out}: ${duration(out).toFixed(1)} s`);
