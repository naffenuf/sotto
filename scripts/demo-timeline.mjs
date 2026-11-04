#!/usr/bin/env node
// Writes demo/<take>.timeline.md: every line of the take, with the exact
// in/out on the take's clock. Pick cuts from this file, never from the video.
//
//   npm run demo:timeline
import { writeFileSync } from "node:fs";
import { TAKE, timelinePath } from "./demo/config.mjs";
import { analyseTake, timelineMarkdown } from "./demo/take.mjs";

const analysis = analyseTake({ take: TAKE.video, session: TAKE.session });
const out = timelinePath();
writeFileSync(out, timelineMarkdown(analysis, { title: `${TAKE.name}: what was said, and when` }));
const unmeasured = analysis.lines.filter((l) => !l.measured).length;
console.log(`${out}: ${analysis.lines.length} lines, offset ${analysis.offset.toFixed(2)} s (r=${analysis.r.toFixed(2)})`);
if (unmeasured) console.log(`${unmeasured} line(s) not found in the audio: their times are the session's estimate`);
