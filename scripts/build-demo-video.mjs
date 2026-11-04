#!/usr/bin/env node
// Assembles the demo video from a recorded take, the rendered slides and the
// narration: see tasks/demo-video.md ("The cut").
//
//   npm run demo:check    resolve the cut, write demo/build/review.md, encode nothing
//   npm run demo:video    the same, then build demo/sotto-demo.mp4
//   npm run demo:x        the 70-second cut for X, captioned: demo/sotto-x.mp4
//   (--check works with --cut x too)
//
// Pieces are encoded to one format (1080p30 H.264, AAC 48 kHz stereo) and
// joined with the concat demuxer; the whole thing is loudness-normalised last.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TAKE, timelinePath } from "./demo/config.mjs";
import { alignWords, end, linesIn, resolveSegments, start } from "./demo/cut.mjs";
import { analyseTake, formatTime, tokens, voiceName } from "./demo/take.mjs";

const CHECK_ONLY = process.argv.includes("--check");
const CUT_NAME = process.argv.includes("--cut") ? process.argv[process.argv.indexOf("--cut") + 1] : "demo";
const take = resolve(TAKE.video);
const slides = resolve("demo/build");

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

/** A callout: white text on a dark band, for `seconds` from `at` (segment-local), at height `y`. */
function callout(text, at, seconds = 2.6, y = "h-200") {
  const safe = text.replace(/\\/g, "\\\\").replace(/'/g, "’").replace(/:/g, "\\:");
  return (
    `drawtext=fontfile=${FONT}:text='${safe}':fontsize=44:fontcolor=white:` +
    `box=1:boxcolor=black@0.62:boxborderw=22:x=(w-text_w)/2:y=${y}:` +
    `enable='between(t,${at.toFixed(2)},${(at + seconds).toFixed(2)})'`
  );
}

/** Characters per caption line, and lines per caption. */
const CAPTION_LINE = 46;
const CAPTION_LINES = 2;
/**
 * What the transcription misheard in the room's lines, fixed for the captions
 * only (cutting still matches the transcript as heard). Sotto's lines are
 * never touched: they are what it said.
 */
const CAPTION_FIXES = [
  [/\bBen crowd\b/, "Bend crowd"],
  [/^Is bend\b/, "Is Bend"],
];
/** Vertical distance between caption rows. */
const CAPTION_ROW_PX = 66;

/**
 * Captions for a segment, from the measured lines: each line's words are
 * packed into captions of up to two lines and spread over the line's in/out
 * by length. Written to text files (drawtext's textfile), so nothing in the
 * dialogue has to survive filtergraph escaping.
 */
function captions(seg, dir) {
  const shown = [];
  for (const { line } of linesIn(analysis, seg)) {
    if (line.out - line.in < 0.3) continue;
    // A line that began before the segment and is mostly outside it is not
    // captioned: its words are not in the video. (One that starts inside and
    // runs past the end, like a long hello, keeps the captions that fit.)
    const inside = Math.min(line.out, seg.to) - Math.max(line.in, seg.from);
    if (line.in < seg.from - 0.1 && inside < (line.out - line.in) / 2) continue;
    const raw = line.unlisted ? sentence(line.words.map((w) => w.w).join(" ")) : line.text;
    const text = line.voice === "S" ? raw : CAPTION_FIXES.reduce((t, [from, to]) => t.replace(from, to), raw);
    if (!text) continue;
    const who = voiceName(line.voice);
    const chunks = captionChunks(text, CAPTION_LINE * CAPTION_LINES - who.length - 2);
    // Each caption starts when its first word does: the word before it was
    // reported (a partial trails speech by 0.3–0.6 s), or, without word
    // positions, its share of the line's length.
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const heard = line.words?.length ? alignWords(tokens(text), line.words) : null;
    const starts = [];
    let chars = 0, words = 0;
    for (const chunk of chunks) {
      const prev = words > 0 && heard?.[words - 1] != null ? line.words[heard[words - 1]].at - 0.2 : null;
      starts.push(words === 0 ? line.in : Math.max(line.in, prev ?? line.in + (line.out - line.in) * (chars / total)));
      chars += chunk.length;
      words += tokens(chunk).length;
    }
    chunks.forEach((chunk, k) => {
      const from = Math.max(starts[k], seg.from) - seg.from;
      const to = Math.min(k === chunks.length - 1 ? line.out + 0.3 : starts[k + 1], seg.to) - seg.from;
      shown.push({ from, to, rows: wrap(`${who}: ${chunk}`, CAPTION_LINE), key: `${line.id}-${k}` });
    });
  }
  // One caption at a time: when two people overlap, the earlier caption gives
  // way to the later one rather than both drawing in the same place.
  shown.sort((x, y) => x.from - y.from);
  shown.forEach((c, i) => {
    if (shown[i + 1]) c.to = Math.min(c.to, shown[i + 1].from);
  });
  // One drawtext per caption row: this font draws a newline in a multi-line
  // textfile as a missing-glyph box.
  const filters = [];
  for (const c of shown.filter((x) => x.to - x.from >= 0.2)) {
    c.rows.forEach((row, r) => {
      const file = resolve(dir, `cap-${seg.name}-${c.key}-${r}.txt`);
      writeFileSync(file, row);
      const y = `h-70-${(c.rows.length - r) * CAPTION_ROW_PX}`;
      filters.push(
        `drawtext=fontfile=${FONT}:textfile=${file}:fontsize=42:fontcolor=white:` +
        `box=1:boxcolor=black@0.7:boxborderw=12:x=(w-text_w)/2:y=${y}:` +
        `enable='between(t,${c.from.toFixed(2)},${c.to.toFixed(2)})'`,
      );
    });
  }
  return filters;
}
/**
 * A line's text as captions: whole sentences together while they fit, a long
 * sentence split at a comma or dash where it can be, and only then by words.
 */
function captionChunks(text, max) {
  const out = [];
  for (const sent of text.split(/(?<=[.?!])\s+/)) {
    const pieces = sent.length <= max ? [sent] : sent.split(/(?<=[,;:—])\s+/).flatMap((p) => pack(p.split(/\s+/), max));
    for (const piece of pack(pieces, max)) {
      const last = out.at(-1);
      if (last !== undefined && /[.?!]$/.test(last) && last.length + 1 + piece.length <= max) out[out.length - 1] = `${last} ${piece}`;
      else out.push(piece);
    }
  }
  return out;
}
const sentence = (s) => (s ? s[0].toUpperCase() + s.slice(1) + "." : "");
/** Words packed into strings of at most `max` characters. */
function pack(words, max) {
  const out = [];
  for (const w of words) {
    const last = out.at(-1);
    if (last !== undefined && last.length + 1 + w.length <= max) out[out.length - 1] = `${last} ${w}`;
    else out.push(w);
  }
  return out;
}
const wrap = (text, width) => pack(text.split(/\s+/), width);

// The cuts, by what is said: see scripts/demo/cut.mjs for start()/end(), and
// demo/take4.timeline.md for the lines. Every edge is checked against the
// take's own audio; `npm run demo:check` resolves the cut and writes the
// review sheet without encoding anything. A callout is [ref, text] or
// [ref, text, seconds].
const CUTS = {
  // The three-minute submission video.
  demo: {
    out: "demo/sotto-demo.mp4",
    build: "demo/build",
    intro: [["01-title", { fadeIn: 0.6 }], ["02-stack", { fadeOut: 0.4 }]],
    calloutY: "h-200",
    captions: false,
    segments: [
      // One unbroken stretch: the whole hello, the names, Craig's opener, the
      // fire-code cap and "30 kits" (which the correction later cites), the Bend
      // crowd, the drive-time question, EJ's guess, and the claim.
      // "Okay, it's running" before the hello is left out.
      {
        name: "A", from: start("Hi, I'm Sotto"), to: end("I'll check the drive time from Portland to Bend"), fadeIn: 0.6,
        callouts: [[start("I'll check the drive time"), "Nobody asked. It waited for a pause."]],
      },
      {
        name: "C2", from: start("On the drive time from Portland to Bend"), to: end("gets you there by lunch"),
        callouts: [[start("On the drive time from Portland to Bend"), "A sourced answer, in the next gap."]],
      },
      { name: "D", from: start("Good. And tickets"), to: end("Free or five bucks") },
      // "Sotto, go ahead" and the correction, with the pause the call-on takes
      // to be acted on cut out between them.
      { name: "E1", from: start("Sotto, go ahead"), to: end("Sotto, go ahead") },
      {
        name: "E2", from: start("50 tickets"), to: end("we'll read it after"),
        callouts: [[start("50 tickets"), "It raised a hand. The room called on it."], [start("Sotto, hold on"), "It stops the moment anyone talks."]],
      },
      {
        name: "F", from: start("I'll grab a volunteer"), to: end("Charge 5 dollars for tickets."), fadeOut: 2.0,
        callouts: [[start("Here's where we got to"), "A wrap-up from its own notes."]],
      },
    ],
  },
  // About 70 seconds for X: no intro slides, straight into the drive-time
  // question, captioned because the feed autoplays muted. Callouts move to the
  // top so they never sit on a caption.
  x: {
    out: "demo/sotto-x.mp4",
    build: "demo/build/x",
    intro: [],
    calloutY: "60",
    captions: true,
    segments: [
      // Sotto introduces itself and its rule, then the room gives the drive
      // question a reason ("Half the mailing list is out there").
      { name: "X0", from: start("Hi, I'm Sotto"), to: end("only speak up when it's worth it."), fadeIn: 0.5 },
      {
        // The pause after "…worth it." is 0.59 s: room for a short dissolve only.
        name: "X1", crossfade: 0.15, from: start("I want the Ben crowd"), to: end("I'll check the drive time from Portland to Bend"),
        callouts: [[start("I'll check the drive time"), "Nobody asked. It waited for a pause."]],
      },
      {
        name: "X2", from: start("On the drive time from Portland to Bend"), to: end("gets you there by lunch"),
        callouts: [[start("On the drive time from Portland to Bend"), "A sourced answer, in the next gap."]],
      },
      { name: "X3", from: start("Good. And tickets"), to: end("Free or five bucks") },
      { name: "X4", from: start("Sotto, go ahead"), to: end("Sotto, go ahead") },
      {
        name: "X5", from: start("50 tickets"), to: end("we'll read it after"),
        callouts: [[start("50 tickets"), "Called on, it reads out what it noticed."], [start("Sotto, hold on"), "It stops the moment anyone talks."]],
      },
    ],
  },
};
const CUT = CUTS[CUT_NAME];
if (!CUT) throw new Error(`no cut "${CUT_NAME}"; cuts: ${Object.keys(CUTS).join(", ")}`);
const SEGMENTS = CUT.segments;
const build = resolve(CUT.build);
const out = resolve(CUT.out);
mkdirSync(build, { recursive: true });
/** Picture and sound dissolve between take segments over this long. */
const CROSSFADE_S = 0.4;

const analysis = analyseTake({ take, session: TAKE.session });
const cut = resolveSegments(analysis, SEGMENTS, { crossfade: CROSSFADE_S });

const parts = [];

function slide(name, { fadeIn = 0, fadeOut = 0, tail = 0.9 } = {}) {
  const png = resolve(slides, `${name}.png`);
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
  for (const { at, text, seconds } of seg.callouts) vf.push(callout(text, at - seg.from, seconds, CUT.calloutY));
  if (CUT.captions) vf.push(...captions(seg, build));
  if (seg.fadeIn) vf.push(`fade=t=in:st=0:d=${seg.fadeIn}`);
  if (seg.fadeOut) vf.push(`fade=t=out:st=${(len - seg.fadeOut).toFixed(2)}:d=${seg.fadeOut}`);
  // 20 ms ramps at both ends so a cut never clicks.
  const af = [`afade=t=in:st=0:d=0.02`, `afade=t=out:st=${(len - (seg.fadeOut ?? 0.02)).toFixed(3)}:d=${seg.fadeOut ?? 0.02}`];
  ffmpeg([
    "-ss", seg.from.toFixed(3), "-to", seg.to.toFixed(3), "-i", take,
    "-vf", vf.join(","), "-af", af.join(","), ...VIDEO, ...AUDIO, file,
  ]);
  console.log(`segment ${seg.name}: ${len.toFixed(1)} s`);
  return file;
}

/** The take's segments as one piece, each dissolving into the next (picture and sound). */
function dissolve(files) {
  const file = resolve(build, "session.mp4");
  const lens = files.map(duration);
  const graph = [];
  let v = "0:v", a = "0:a", at = 0;
  for (let k = 1; k < files.length; k++) {
    const x = cut[k].crossfadeIn;
    at += lens[k - 1] - x;
    const last = k === files.length - 1;
    // xfade outputs yuv444p; the slides are yuv420p, and the concat demuxer
    // joins without re-encoding, so a mismatch leaves players showing black
    // (with sound) from the first segment on.
    graph.push(`[${v}][${k}:v]xfade=transition=fade:duration=${x}:offset=${at.toFixed(3)}${last ? ",format=yuv420p[v]" : `[v${k}]`}`);
    graph.push(`[${a}][${k}:a]acrossfade=d=${x}:c1=tri:c2=tri${last ? "[a]" : `[a${k}]`}`);
    v = `v${k}`;
    a = `a${k}`;
  }
  ffmpeg([...files.flatMap((f) => ["-i", f]), "-filter_complex", graph.join(";"), "-map", "[v]", "-map", "[a]", ...VIDEO, ...AUDIO, file]);
  parts.push(file);
  console.log(`session: ${duration(file).toFixed(1)} s, ${files.length - 1} crossfades`);
}

writeReview();
if (CHECK_ONLY) process.exit(0);

for (const [name, opts] of CUT.intro) slide(name, opts);
dissolve(cut.map(segment));
slide("03-end", { fadeIn: 0.5, fadeOut: 1.0, tail: 2.5 });

// The concat demuxer copies streams as they are, so every part must agree.
const formats = new Set(parts.map((p) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=pix_fmt,width,height,r_frame_rate,time_base,profile", "-of", "csv=p=0", p]).toString().trim()));
if (formats.size !== 1) throw new Error(`parts disagree on video format, so concat would break playback:\n  ${[...formats].join("\n  ")}`);
const list = resolve(build, "concat.txt");
writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n") + "\n");
const joined = resolve(build, "joined.mp4");
ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
// Loudness last, over the whole programme, video untouched.
// Two passes, applied linearly: single-pass loudnorm is dynamic (it rides the
// gain through the programme) and missed the target, −16.8 LUFS against −16;
// measured first and applied as one gain, the build lands on −16.1.
const LOUDNESS = "I=-16:TP=-1.5:LRA=11";
const probe = spawnSync("ffmpeg", ["-hide_banner", "-i", joined, "-af", `loudnorm=${LOUDNESS}:print_format=json`, "-f", "null", "-"]).stderr.toString();
const m = JSON.parse(probe.slice(probe.lastIndexOf("{"), probe.lastIndexOf("}") + 1));
const linear = `loudnorm=${LOUDNESS}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
ffmpeg(["-i", joined, "-c:v", "copy", "-af", linear, ...AUDIO, "-movflags", "+faststart", out]);
console.log(`\n${out}: ${duration(out).toFixed(1)} s`);

/**
 * demo/build/review.md: per segment, its edges (how each was found and who, if
 * anyone, is talking there), every line it contains — whole or cut — and the
 * first and last frame. Read this, not the MP4, to check a cut.
 */
function writeReview() {
  const slideLen = (name, tail = 0.9) => duration(resolve("demo/narration", `${name}.wav`)) + tail;
  let clock = CUT.intro.reduce((n, [name]) => n + slideLen(name), 0);
  const out = [
    `# Demo cut review: ${CUT_NAME}`,
    "",
    `Generated by \`npm run demo:check\` from \`${TAKE.video}\` (session \`${TAKE.session}\`, offset ${analysis.offset.toFixed(2)} s, r=${analysis.r.toFixed(2)}).`,
    `Lines are from \`${timelinePath()}\`. Times are take time; "programme" is time in the finished video.`,
    "",
  ];
  for (const [k, seg] of cut.entries()) {
    const len = seg.to - seg.from;
    out.push(`## ${seg.name}: ${formatTime(seg.from)} → ${formatTime(seg.to)} (${len.toFixed(1)} s, programme ${formatTime(clock)})`, "");
    for (const e of seg.edges) {
      const at = e.talking ? `**${[...e.talking].map(voiceName).join(" + ")} talking** (covered by a ${e.fade} s fade)` : "silence";
      out.push(`- ${e.side} ${formatTime(e.t)}: ${e.how}${e.line ? ` of "${e.line.text.slice(0, 50)}…"` : ""}; ${at}`);
    }
    if (seg.crossfadeIn || seg.crossfadeOut) out.push(`- crossfades: ${[seg.crossfadeIn && `in ${seg.crossfadeIn} s`, seg.crossfadeOut && `out ${seg.crossfadeOut} s`].filter(Boolean).join(", ")}, both over silence`);
    for (const c of seg.callouts) out.push(`- callout at ${formatTime(c.at)} (programme ${formatTime(clock + c.at - seg.from)}): "${c.text}"`);
    out.push("", "| | In | Out | Who | Line |", "|---|---|---|---|---|");
    for (const { line, whole } of linesIn(analysis, seg)) {
      const mark = whole ? "✓" : line.in < seg.from ? "⚠ starts before the cut" : "⚠ runs past the cut";
      out.push(`| ${mark} | ${formatTime(line.in)} | ${formatTime(line.out)} | ${voiceName(line.voice)} | ${line.text.replace(/\|/g, "\\|")} |`);
    }
    const shot = resolve(build, `review-${seg.name}.jpg`);
    ffmpeg([
      "-ss", seg.from.toFixed(3), "-i", take, "-ss", Math.max(0, seg.to - 0.05).toFixed(3), "-i", take,
      "-filter_complex", `[0:v]${FRAME},scale=640:-2[a];[1:v]${FRAME},scale=640:-2[b];[a][b]hstack`,
      "-frames:v", "1", "-q:v", "4", shot,
    ]);
    out.push("", `First and last frame: ![${seg.name}](review-${seg.name}.jpg)`, "");
    // What the cut drops before the next segment: dialogue the audience never
    // hears should be a decision someone made, not a surprise in the MP4.
    const next = cut[k + 1];
    if (next) {
      const dropped = analysis.lines.filter((l) => l.in >= seg.to - 0.05 && l.out <= next.from + 0.05 && l.out - l.in > 0.3);
      out.push(dropped.length === 0 ? `**Left out before ${next.name}:** nothing said.` : `**Left out before ${next.name}** (${(next.from - seg.to).toFixed(1)} s of take):`);
      for (const l of dropped) out.push(`- ${formatTime(l.in)} ${voiceName(l.voice)}: ${l.text}`);
      out.push("");
    }
    clock += len - (seg.crossfadeOut ?? 0);
  }
  clock += slideLen("03-end", 2.5);
  out.push(`**Total: ${formatTime(clock)}**`, "");
  writeFileSync(resolve(build, "review.md"), out.join("\n"));
  console.log(`${CUT.build}/review.md: ${cut.length} segments, ${formatTime(clock)} total`);
}
