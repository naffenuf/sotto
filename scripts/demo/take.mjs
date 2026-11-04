// What a demo take contains, measured rather than read off the video.
//
// Two sources, both exact (see tasks/demo-video.md, "Cutting by line"):
//
// 1. The session folder. `audio.wav` is what the API heard, so cross-correlating
//    it against the take's soundtrack gives one offset that puts every ASR frame
//    on the take's clock. The room's lines (text, speaker, and the audio position
//    each partial reached) come from `events.jsonl`; Sotto's lines, in order,
//    from `transcript.md`.
// 2. The take's stereo. The soundboard pans EJ hard left and Craig hard right and
//    Sotto plays centre, so per 10 ms frame the shared part of L and R is Sotto
//    (E[L·R] = S² when the three are uncorrelated) and what is left on each side
//    is a person. That gives exact word boundaries for all three voices, and it is
//    the only record of where Sotto *stopped* talking.
//
// A line's in/out is its own voice's first and last active frame inside the
// window the session gives it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sottoAsrPath, TAKE } from "./config.mjs";

export const FRAME_S = 0.01;
const RATE = 8000;
const FRAME = RATE * FRAME_S;
/** Below this RMS (int16) a voice is not talking: about −50 dBFS. */
const ACTIVE_RMS = 100;
/** Gaps shorter than this inside one voice's run are filled (stops, plosives). */
const FILL_GAP_FRAMES = 12;
/** Blips shorter than this are dropped. */
const MIN_RUN_FRAMES = 4;
/** A silence this long inside one room turn makes two utterances of it. */
const UTTERANCE_GAP_S = 1.0;
/** Quiet before a centre-channel onset for it to start a new Sotto line. */
const SOTTO_ONSET_GAP_S = 0.3;
/** A centre-channel silence this long ends a Sotto line (its sentence pauses are shorter). */
const SOTTO_LINE_GAP_S = 1.2;
/** A correlation below this means the session is not this take. */
const MIN_ALIGN_R = 0.3;

export const VOICES = /** @type {const} */ (["E", "C", "S"]);
const VOICE_NAMES = { E: "EJ", C: "Craig", S: "Sotto" };

function decode(file, channels) {
  const buf = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vn", "-ac", String(channels), "-ar", String(RATE), "-f", "s16le", "-"],
    { maxBuffer: 1 << 30 },
  );
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
}

/** Log-RMS envelope, mean-removed, one value per 10 ms. */
function envelope(mono) {
  const n = Math.floor(mono.length / FRAME);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * FRAME; j < (i + 1) * FRAME; j++) s += mono[j] * mono[j];
    e[i] = Math.log1p(Math.sqrt(s / FRAME));
  }
  const mean = e.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) e[i] -= mean;
  return e;
}

/** Best lag (frames) of `a` inside `b`, searched over every placement that overlaps by half. */
function bestLag(a, b) {
  let best = { lag: 0, r: -Infinity };
  const min = -Math.floor(a.length / 2);
  const max = b.length - Math.floor(a.length / 2);
  let aa = 0;
  for (const v of a) aa += v * v;
  for (let lag = min; lag <= max; lag++) {
    let ab = 0, bb = 0;
    const from = Math.max(0, -lag), to = Math.min(a.length, b.length - lag);
    for (let i = from; i < to; i++) {
      const y = b[i + lag];
      ab += a[i] * y;
      bb += y * y;
    }
    const r = ab / Math.sqrt(aa * bb || 1);
    if (r > best.r) best = { lag, r };
  }
  return best;
}

/** Per-frame activity of EJ (left), Craig (right) and Sotto (centre). */
function voiceTrack(stereo) {
  const n = Math.floor(stereo.length / 2 / FRAME);
  const raw = { E: new Uint8Array(n), C: new Uint8Array(n), S: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    let ll = 0, rr = 0, lr = 0;
    for (let j = i * FRAME; j < (i + 1) * FRAME; j++) {
      const l = stereo[2 * j], r = stereo[2 * j + 1];
      ll += l * l; rr += r * r; lr += l * r;
    }
    const s2 = Math.max(0, lr / FRAME);
    raw.S[i] = Math.sqrt(s2) > ACTIVE_RMS ? 1 : 0;
    raw.E[i] = Math.sqrt(Math.max(0, ll / FRAME - s2)) > ACTIVE_RMS ? 1 : 0;
    raw.C[i] = Math.sqrt(Math.max(0, rr / FRAME - s2)) > ACTIVE_RMS ? 1 : 0;
  }
  for (const v of VOICES) smooth(raw[v]);
  return raw;
}

function smooth(track) {
  // Fill short gaps, then drop short blips.
  let last = -1;
  for (let i = 0; i < track.length; i++) {
    if (!track[i]) continue;
    if (last >= 0 && i - last - 1 <= FILL_GAP_FRAMES) track.fill(1, last + 1, i);
    last = i;
  }
  for (let i = 0; i < track.length; ) {
    if (!track[i]) { i++; continue; }
    let j = i;
    while (j < track.length && track[j]) j++;
    if (j - i < MIN_RUN_FRAMES) track.fill(0, i, j);
    i = j;
  }
}

/** Room turns from the raw ASR frames, on the audio's clock (seconds into audio.wav). */
function roomTurns(sessionDir, speakers) {
  const frames = readFileSync(join(sessionDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).frame);
  return asrTurns(frames, (ms) => ms / 1000).map((t) => ({ ...t, name: speakers[t.label]?.name ?? t.label ?? "?" }));
}

/** Turns, with every partial, from a list of ASR frames; `toTime` maps audioProcessedMs to seconds. */
function asrTurns(frames, toTime) {
  const turns = [];
  let open = null;
  for (const f of frames) {
    if (!f || f.type === "audioProgress") continue;
    const at = toTime(f.audioProcessedMs ?? 0);
    if (f.type === "speechStart") {
      open = { asrStart: at, asrEnd: null, label: null, text: "", partials: [] };
      turns.push(open);
    } else if (f.type === "transcript" && open) {
      const text = f.transcript.trim();
      const prev = open.partials.at(-1);
      if (text && (!prev || prev.text !== text)) open.partials.push({ at, text });
    } else if (f.type === "speaker" && open) {
      open.label = f.label;
    } else if (f.type === "speechEnd" && open) {
      open.asrEnd = at;
    } else if (f.type === "speechComplete" && open) {
      open.text = (f.transcript ?? "").trim() || open.partials.at(-1)?.text || "";
      open = null;
    }
  }
  return turns.filter((t) => t.text);
}

/** Lower-case words with the punctuation off, for matching ASR text to script text. */
export const tokens = (text) =>
  text.toLowerCase().replace(/[‘’]/g, "'").replace(/\$(\d)/g, "$1").split(/[^a-z0-9']+/).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);

/**
 * Word positions from a turn's partials: each word gets the audio position of
 * the first partial that contained it, which is shortly *after* it was said
 * (measured 0.3–0.6 s after the word ends). A later partial may respell a
 * word; it keeps its time.
 */
function wordsOf(turn) {
  const words = [];
  for (const p of [...turn.partials, { at: turn.partials.at(-1)?.at ?? turn.asrStart, text: turn.text }]) {
    const ws = tokens(p.text);
    ws.forEach((w, i) => {
      if (i < words.length) words[i].w = w;
      else words.push({ w, at: p.at });
    });
  }
  return words;
}

/** Sotto's channel transcribed by npm run demo:transcribe-sotto, as turns on the take's clock. */
function sottoAsrTurns() {
  const path = sottoAsrPath(TAKE);
  if (!existsSync(path)) return null;
  const { stretches, frames } = JSON.parse(readFileSync(path, "utf8"));
  const toTake = (ms) => {
    const s = ms / 1000;
    const st = [...stretches].reverse().find((x) => x.wavStart <= s) ?? stretches[0];
    return Math.min(st.takeEnd, st.takeStart + (s - st.wavStart));
  };
  return asrTurns(frames.map((r) => r.frame), toTake);
}

/** Sotto's lines from transcript.md, in order, with their whole-second stream offset. */
function sottoLines(sessionDir) {
  const out = [];
  const md = readFileSync(join(sessionDir, "transcript.md"), "utf8");
  for (const m of md.matchAll(/^\*\*\[(\d+):(\d+)\] Sotto:\*\* (.*)$/gm)) {
    const interrupted = m[3].includes("_(interrupted)_");
    out.push({ approx: Number(m[1]) * 60 + Number(m[2]), text: m[3].replace(/\s*_\(interrupted\)_\s*$/, ""), interrupted });
  }
  return out;
}

const firstActive = (track, from, to) => {
  for (let i = Math.max(0, from); i < Math.min(track.length, to); i++) if (track[i]) return i;
  return -1;
};
const lastActive = (track, from, to) => {
  for (let i = Math.min(track.length, to) - 1; i >= Math.max(0, from); i--) if (track[i]) return i;
  return -1;
};

/**
 * Measures a take against its session. Returns the offset, the voice track and
 * every line with exact in/out on the take's clock.
 */
export function analyseTake({ take, session, sottoAsr = true }) {
  const meta = JSON.parse(readFileSync(join(session, "session.json"), "utf8"));
  const stereo = decode(take, 2);
  const mono = new Int16Array(stereo.length / 2);
  for (let i = 0; i < mono.length; i++) mono[i] = (stereo[2 * i] + stereo[2 * i + 1]) >> 1;
  const sess = envelope(decode(join(session, "audio.wav"), 1));
  const { lag, r } = bestLag(sess, envelope(mono));
  if (r < MIN_ALIGN_R) {
    throw new Error(`session ${session} does not line up with ${take} (best r=${r.toFixed(2)} < ${MIN_ALIGN_R})`);
  }
  const offset = lag * FRAME_S;
  const voices = voiceTrack(stereo);
  const toFrame = (s) => Math.round(s / FRAME_S);
  const lines = [];

  // The room. The ASR window is generous at the start (speechStart lands at or
  // just after the first word) and ends at speechEnd, which the endpointer
  // reports ~0.5–1 s after the words stop. A turn the API held open across a
  // long silence ("Sotto, go ahead." … 16 s … "Sotto, what does Eventbrite…")
  // is split into utterances at gaps of UTTERANCE_GAP_S in that speaker's
  // channel, and each utterance gets the words whose partials reached the
  // audio inside it. An utterance that added no words is a noise blip and is
  // dropped.
  const turns = roomTurns(session, meta.speakers ?? {});
  turns.forEach((t, k) => {
    const lo = toFrame(t.asrStart + offset - 0.6);
    const hi = toFrame((t.asrEnd ?? t.partials.at(-1)?.at ?? t.asrStart) + offset + 0.3);
    // Which side said it: the side with more activity in the window.
    let e = 0, c = 0;
    for (let i = lo; i < hi; i++) { e += voices.E[i] ?? 0; c += voices.C[i] ?? 0; }
    const voice = e >= c ? "E" : "C";
    const partials = t.partials.map((p) => ({ at: p.at + offset, text: p.text }));
    const turnWords = wordsOf(t).map((w) => ({ w: w.w, at: w.at + offset }));
    const base = { voice, who: t.name, turn: k, sideMatchesLabel: VOICE_NAMES[voice] === t.name };
    const utterances = runsOf(voices[voice].subarray(lo, hi), Math.round(UTTERANCE_GAP_S / FRAME_S))
      .map((r) => ({ in: (lo + r.start) * FRAME_S, out: (lo + r.end) * FRAME_S }));
    if (utterances.length === 0) {
      lines.push({ ...base, id: `t${k}`, text: t.text, in: t.asrStart + offset, out: (t.asrEnd ?? t.asrStart) + offset, measured: false, words: turnWords });
      return;
    }
    // Words said by the start of each later utterance belong to the ones before.
    let said = "";
    const parts = [];
    utterances.forEach((u, j) => {
      const until = j + 1 < utterances.length ? utterances[j + 1].in : Infinity;
      const upTo = j + 1 < utterances.length ? partials.filter((p) => p.at < until).at(-1)?.text ?? said : t.text;
      const text = upTo.startsWith(said) ? upTo.slice(said.length).trim() : upTo.trim();
      said = upTo;
      const from = j === 0 ? -Infinity : u.in;
      if (text) parts.push({ ...u, text, words: turnWords.filter((w) => w.at >= from && w.at < until) });
    });
    if (parts.length === 0) parts.push({ ...utterances[0], text: t.text, words: turnWords });
    parts.forEach((p, j) => {
      lines.push({ ...base, id: parts.length > 1 ? `t${k}${"abcdefgh"[j]}` : `t${k}`, measured: true, ...p });
    });
  });

  // Sotto: transcript.md gives the order and the whole second playback began;
  // the centre channel gives where each line really starts (the first onset
  // after at least SOTTO_ONSET_GAP_S of quiet, near that second) and ends
  // (its last active frame before the next line's onset).
  const onsets = runsOf(voices.S, Math.round(SOTTO_ONSET_GAP_S / FRAME_S)).map((r) => r.start);
  const lineRuns = runsOf(voices.S, Math.round(SOTTO_LINE_GAP_S / FRAME_S));
  const sotto = sottoLines(session);
  const starts = [];
  let after = 0;
  for (const s of sotto) {
    const approx = s.approx + offset;
    const lo = Math.max(after, toFrame(approx - 1.5));
    const pick = onsets.find((o) => o >= lo && o <= toFrame(approx + 3)) ?? -1;
    starts.push(pick);
    if (pick >= 0) after = pick + 1;
  }
  sotto.forEach((s, k) => {
    const base = { id: `s${k}`, voice: "S", who: "Sotto", text: s.text, interrupted: s.interrupted, words: [] };
    const a = starts[k];
    if (a < 0) {
      lines.push({ ...base, in: s.approx + offset, out: s.approx + offset, measured: false });
      return;
    }
    const nextStart = starts.slice(k + 1).find((x) => x >= 0) ?? voices.S.length;
    const run = lineRuns.find((r) => r.start <= a && a < r.end);
    const b = lastActive(voices.S, a, Math.min(nextStart, run ? run.end : nextStart));
    lines.push({ ...base, in: a * FRAME_S, out: (b + 1) * FRAME_S, measured: true });
  });
  // Centre audio no transcript line accounts for: the acknowledgments ("One
  // sec.", "Mm-hm."), which V2-008a deliberately never writes down.
  const sottoSpans = lines.filter((l) => l.voice === "S" && l.measured);
  for (const r of lineRuns) {
    let a = r.start;
    for (const l of sottoSpans) if (toFrame(l.in) <= a && a < toFrame(l.out)) a = toFrame(l.out);
    const b = lastActive(voices.S, a, r.end);
    if (b - a + 1 < 20 || sottoSpans.some((l) => toFrame(l.in) >= a && toFrame(l.in) <= b)) continue;
    const s = firstActive(voices.S, a, r.end);
    lines.push({ id: `s-ack${lines.length}`, voice: "S", who: "Sotto", text: "(not in transcript: an acknowledgment)", unlisted: true, in: s * FRAME_S, out: (b + 1) * FRAME_S, measured: true, words: [] });
  }

  // Sotto's words, when its channel has been transcribed: every ASR turn that
  // starts inside a Sotto line belongs to it, in order.
  const asr = sottoAsr ? sottoAsrTurns() : null;
  for (const l of lines.filter((x) => x.voice === "S" && x.measured)) {
    if (!asr) continue;
    l.words = asr.filter((t) => t.asrStart >= l.in - 0.5 && t.asrStart < l.out).flatMap(wordsOf);
  }

  lines.sort((x, y) => x.in - y.in);
  return { take, session, offset, r, voices, lines, sottoWords: asr !== null, duration: stereo.length / 2 / RATE };
}

/** Runs of activity, merging gaps up to `gapFrames`. */
export function runsOf(track, gapFrames = 0) {
  const runs = [];
  for (let i = 0; i < track.length; ) {
    if (!track[i]) { i++; continue; }
    let j = i;
    while (j < track.length && track[j]) j++;
    const prev = runs.at(-1);
    if (prev && i - prev.end <= gapFrames) prev.end = j;
    else runs.push({ start: i, end: j });
    i = j;
  }
  return runs;
}

/** Who is talking at take time `t` ("" for nobody). */
export function talkingAt(analysis, t) {
  const i = Math.floor(t / FRAME_S);
  return VOICES.filter((v) => analysis.voices[v][i]).join("");
}

/** Silent gaps (no voice at all) of at least `minS`, as [start, end] in seconds. */
export function gaps(analysis, minS = 0.15) {
  const { voices } = analysis;
  const n = voices.S.length;
  const out = [];
  let from = -1;
  for (let i = 0; i <= n; i++) {
    const busy = i < n && (voices.E[i] || voices.C[i] || voices.S[i]);
    if (!busy && from < 0) from = i;
    if (busy || i === n) {
      if (from >= 0 && (i - from) * FRAME_S >= minS) out.push([from * FRAME_S, i * FRAME_S]);
      if (busy) from = -1;
    }
  }
  return out;
}

export const voiceName = (v) => VOICE_NAMES[v];

const fmt = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
};
export { fmt as formatTime };

/** The timeline as markdown: every line, on the take's clock. */
export function timelineMarkdown(analysis, { title }) {
  const rows = analysis.lines.map((l) => {
    const flag = !l.measured ? " ⚠ not found in audio" : l.voice !== "S" && !l.sideMatchesLabel ? ` (ASR said ${l.who})` : "";
    const who = l.voice === "S" ? "Sotto" : voiceName(l.voice);
    const text = l.text.replace(/\|/g, "\\|") + (l.interrupted ? " _(interrupted)_" : "");
    return `| ${fmt(l.in)} | ${fmt(l.out)} | ${(l.out - l.in).toFixed(1)} | ${who}${flag} | ${text} |`;
  });
  return [
    `# ${title}`,
    "",
    `Generated by \`npm run demo:timeline\` from \`${analysis.take}\` and \`${analysis.session}\`.`,
    `Do not edit: rerun it. The take's clock is the session's audio plus **${analysis.offset.toFixed(2)} s**`,
    `(cross-correlation r = ${analysis.r.toFixed(2)}). In/out are each voice's first and last word, read off`,
    "the take's stereo (EJ left, Craig right, Sotto centre), so a cut placed at them clips nothing.",
    "",
    "| In | Out | s | Who | Line |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
