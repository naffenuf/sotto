// Cut points named by what is said, resolved against a take's measured lines
// (scripts/demo/take.mjs), and checked so that no cut lands inside a word.
//
//   start("Venue's easy")        the moment those words begin being said
//   end("not a soft one")        the moment they finish
//   start("Venue's easy", -1)    a second earlier (a shift is applied after padding)
//   end("…", { who: "Sotto" })   when the words occur in more than one line
//
// A fragment that opens (or closes) its line resolves to that line's measured
// edge, exact to 10 ms. One inside a line is estimated — from the partial that
// first contained it for the room, from its share of the characters for Sotto —
// and snapped to the nearest pause in that voice; the review says so.
import { FRAME_S, formatTime, gaps, talkingAt, tokens, voiceName } from "./take.mjs";

/** Lead-in before the first word, and tail after the last, when the pause allows. */
export const PAD_IN_S = 0.3;
export const PAD_OUT_S = 0.4;
/** Silence kept beyond a crossfade on each side of a join, so speakers do not run into the dissolve. */
export const JOIN_BREATH_S = 0.25;
/** A pause shorter than this inside a line is not a place to cut. */
const SNAP_GAP_S = 0.12;
/** How far an estimate may be moved to reach a pause. */
const SNAP_RANGE_S = 1.5;

export const start = (fragment, shift = 0, opts = {}) => ref("start", fragment, shift, opts);
export const end = (fragment, shift = 0, opts = {}) => ref("end", fragment, shift, opts);
function ref(edge, fragment, shift, opts) {
  if (typeof shift === "object") return { edge, fragment, shift: 0, ...shift };
  return { edge, fragment, shift, ...opts };
}

const norm = (s) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[—–]/g, "-").replace(/\s+/g, " ").trim();

function findLine(analysis, r) {
  const f = norm(r.fragment);
  const hits = analysis.lines.filter(
    (l) => !l.unlisted && norm(l.text).includes(f) && (!r.who || l.who === r.who || voiceName(l.voice) === r.who),
  );
  if (hits.length !== 1) {
    const list = hits.map((l) => `  ${formatTime(l.in)} ${voiceName(l.voice)}: ${l.text.slice(0, 80)}`).join("\n");
    throw new Error(
      hits.length === 0
        ? `no line says "${r.fragment}"${r.who ? ` (${r.who})` : ""}: check the timeline`
        : `"${r.fragment}" is in ${hits.length} lines; make it longer or pass { who }:\n${list}`,
    );
  }
  return hits[0];
}

/** Pauses inside one voice, as [start, end] seconds. */
function voiceGaps(analysis, voice, from, to) {
  const track = analysis.voices[voice];
  const out = [];
  let g = -1;
  for (let i = Math.floor(from / FRAME_S); i < Math.ceil(to / FRAME_S); i++) {
    if (!track[i] && g < 0) g = i;
    if (track[i] && g >= 0) {
      if ((i - g) * FRAME_S >= SNAP_GAP_S) out.push([g * FRAME_S, i * FRAME_S]);
      g = -1;
    }
  }
  return out;
}

/** The time a ref names, before padding: { t, line, how }. */
export function locate(analysis, r) {
  if (typeof r === "number") return { t: r, line: null, how: "hand-timed" };
  const line = findLine(analysis, r);
  const text = norm(line.text);
  const f = norm(r.fragment);
  const at = text.indexOf(f);
  if (r.edge === "start" && at === 0) return { t: line.in, line, how: "line start" };
  if (r.edge === "end" && at + f.length >= text.replace(/[.?!]+$/, "").length) return { t: line.out, line, how: "line end" };

  // Inside the line. The cut goes between word j (the fragment's last word for
  // an end, the word before it for a start) and word j+1, in a pause in this
  // voice. With word positions (each word's time is the partial that first
  // contained it, so the word had *ended* by then) that pause must begin by
  // word j's time and end before word j+1's: the longest such pause wins,
  // since a sentence break is usually longer than a comma. Without them the
  // position is estimated by share of characters and the review says so.
  const pauses = voiceGaps(analysis, line.voice, line.in, line.out);
  const before = text.slice(0, at);
  const j = tokens(r.edge === "start" ? before : before + f).length - 1;
  const words = line.words ?? [];
  const aligned = words.length > 0 ? alignWords(tokens(line.text), words) : null;
  if (aligned && aligned[j] != null && aligned[j + 1] != null) {
    const [tj, tk] = [words[aligned[j]].at, words[aligned[j + 1]].at];
    const fits = pauses.filter(([a, b]) => a <= tj + 0.1 && a >= tj - SNAP_RANGE_S && b <= tk + 0.05);
    if (fits.length > 0) {
      const [a, b] = fits.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x));
      return { t: r.edge === "start" ? b : a, line, how: `inside the line: between "${words[aligned[j]].w}" and "${words[aligned[j + 1]].w}"` };
    }
  }
  const charAt = r.edge === "start" ? at : at + f.length;
  const estimate = line.in + (line.out - line.in) * (charAt / text.length);
  const candidates = pauses.map(([a, b]) => (r.edge === "start" ? b : a)).filter((t) => Math.abs(t - estimate) <= SNAP_RANGE_S);
  if (candidates.length === 0) {
    throw new Error(`no pause near ${formatTime(estimate)} in "${line.text.slice(0, 60)}…" to cut ${r.edge === "start" ? "before" : "after"} "${r.fragment}"`);
  }
  const t = candidates.reduce((x, y) => (Math.abs(y - estimate) < Math.abs(x - estimate) ? y : x));
  const why = words.length === 0 ? (line.voice === "S" ? "no word positions: run npm run demo:transcribe-sotto" : "no word positions") : "words did not align";
  return { t, line, how: `inside the line: ⚠ ESTIMATED by length (${why}), snapped to a pause` };
}

/**
 * For each script word, the index of the ASR word it was heard as (or null),
 * by longest common subsequence: the ASR spells some words its own way
 * ("Soto", "Ben") and drops or adds the odd one, and the cut only needs the
 * words around it to line up.
 */
export function alignWords(script, heard) {
  const h = heard.map((x) => x.w);
  const n = script.length, m = h.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let k = m - 1; k >= 0; k--) L[i][k] = script[i] === h[k] ? L[i + 1][k + 1] + 1 : Math.max(L[i + 1][k], L[i][k + 1]);
  const map = new Array(n).fill(null);
  for (let i = 0, k = 0; i < n && k < m; ) {
    if (script[i] === h[k]) { map[i] = k; i++; k++; }
    else if (L[i + 1][k] >= L[i][k + 1]) i++;
    else k++;
  }
  // A script word the ASR missed takes the next heard word's time: it was said by then.
  for (let i = n - 2; i >= 0; i--) if (map[i] == null && map[i + 1] != null) map[i] = map[i + 1];
  return map;
}

/**
 * A cut point: the located time, padded out into the surrounding silence (but
 * never past half of it, so the neighbouring line keeps its own lead-in), then
 * shifted.
 */
export function cutPoint(analysis, r, side, minPad = 0) {
  const loc = locate(analysis, r);
  let t = loc.t;
  if (loc.line) {
    const silent = gaps(analysis, 0).find(([a, b]) => (side === "in" ? b >= t - 0.02 && a < t : a <= t + 0.02 && b > t));
    if (side === "in") t = silent ? Math.max(t - Math.max(PAD_IN_S, minPad), (silent[0] + t) / 2) : t;
    else t = silent ? Math.min(t + Math.max(PAD_OUT_S, minPad), (t + silent[1]) / 2) : t;
  }
  return { ...loc, t: t + (r.shift ?? 0) };
}

/** The voices heard anywhere in [a, b] of the take. */
function voicesIn(analysis, a, b) {
  const heard = new Set();
  for (let t = a; t < b; t += FRAME_S) for (const v of talkingAt(analysis, t)) heard.add(v);
  return [...heard].join("");
}

/**
 * Resolves a segment list. Consecutive segments are joined by a crossfade of
 * `crossfade` seconds, so the overlapping ends of both must be silent: those
 * edges are padded at least that far into the pause, and checked over the
 * whole overlap. Throws, naming every problem, when an edge without a fade
 * lands on a voice.
 */
export function resolveSegments(analysis, segments, { crossfade = 0 } = {}) {
  const problems = [];
  const overlap = (x) => (x > 0 ? x + JOIN_BREATH_S : 0);
  const resolved = segments.map((seg, i) => {
    // A segment's `crossfade` sets the join into it (a short pause can only
    // hide a short dissolve); otherwise the cut's default.
    const joinInto = (s) => s.crossfade ?? crossfade;
    const xIn = i > 0 ? joinInto(seg) : 0, xOut = i < segments.length - 1 ? joinInto(segments[i + 1]) : 0;
    const from = cutPoint(analysis, seg.from, "in", overlap(xIn));
    const to = cutPoint(analysis, seg.to, "out", overlap(xOut));
    if (xIn) {
      const v = voicesIn(analysis, from.t, from.t + xIn);
      if (v) problems.push(`${seg.name}: the crossfade in (${formatTime(from.t)} + ${xIn} s) has ${[...v].map(voiceName).join(" and ")} talking; the pause before "${seg.from.fragment}" is too short`);
    }
    if (xOut) {
      const v = voicesIn(analysis, to.t - xOut, to.t);
      if (v) problems.push(`${seg.name}: the crossfade out (${formatTime(to.t)} − ${xOut} s) has ${[...v].map(voiceName).join(" and ")} talking; the pause after "${seg.to.fragment}" is too short`);
    }
    const callouts = (seg.callouts ?? []).map(([at, text, seconds]) => ({ at: locate(analysis, at).t, text, seconds }));
    const edges = [
      ["in", from, seg.fadeIn],
      ["out", to, seg.fadeOut],
    ].map(([side, p, fade]) => {
      // Who is talking within 40 ms of the cut, on the side that is kept.
      const probe = side === "in" ? [p.t, p.t + 0.04] : [p.t - 0.04, p.t];
      const who = [...new Set([talkingAt(analysis, probe[0]), talkingAt(analysis, probe[1])].join(""))].join("");
      if (who && !fade) problems.push(`${seg.name} ${side} at ${formatTime(p.t)} cuts ${[...who].map(voiceName).join(" and ")} mid-word`);
      return { side, ...p, talking: who, fade: fade ?? 0 };
    });
    if (to.t <= from.t) problems.push(`${seg.name}: out (${formatTime(to.t)}) is not after in (${formatTime(from.t)})`);
    for (const c of callouts) {
      if (c.at < from.t || c.at > to.t) problems.push(`${seg.name}: callout "${c.text}" at ${formatTime(c.at)} is outside the segment`);
    }
    return { ...seg, from: from.t, to: to.t, edges, callouts, crossfadeIn: xIn, crossfadeOut: xOut };
  });
  if (problems.length) throw new Error(`the cut does not hold:\n  ${problems.join("\n  ")}`);
  return resolved;
}

/** Every line a segment touches, and whether it is whole. */
export function linesIn(analysis, seg) {
  return analysis.lines
    .filter((l) => l.out > seg.from && l.in < seg.to && l.out - l.in > 0.05)
    .map((l) => ({ line: l, whole: l.in >= seg.from - 0.005 && l.out <= seg.to + 0.005 }));
}
