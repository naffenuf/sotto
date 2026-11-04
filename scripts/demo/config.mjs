// The take the demo video is cut from, and the session it recorded.
// sessions/ and demo/takes/ are git-ignored; demo/<name>.timeline.md is the
// committed record of what the take contains.
export const TAKE = {
  name: "take4",
  video: "demo/takes/take4.mov",
  session: "sessions/2026-11-04_1106-mic",
};

export const timelinePath = (take = TAKE) => `demo/${take.name}.timeline.md`;
/** Sotto's channel transcribed (npm run demo:transcribe-sotto); lives beside the take. */
export const sottoAsrPath = (take = TAKE) => take.video.replace(/\.[^.]+$/, ".sotto-asr.json");
