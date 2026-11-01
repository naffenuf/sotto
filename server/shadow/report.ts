/**
 * `tasks/shadow-<session>.md`: a shadow run written for a person to mark up
 * (PRD V3-016).
 *
 * Pure over a {@link ShadowRunRecord}, so the wording can be changed and the
 * report regenerated without replaying anything.
 *
 * The shape follows the one question it exists to ask. Every unprompted line
 * first, each with the turn that triggered it quoted and a **Verdict** blank
 * to write `welcome`, `not` or `wrong` into — a line Sotto decided *against*
 * saying is in the same list, with the reason, because "it stayed quiet here"
 * is an answer a reader has to be able to disagree with. Then every verdict
 * the question classifier reached, including the ones it gave nothing for:
 * that is the only place a question Sotto *missed* shows up at all. Then the
 * cards, and last the policy's silent decisions, which is the same list
 * `digest.md` ends with and the stage's tray shows.
 */
import { policySettingsLabel } from "../../shared/policy.js";
import type { ShadowQuestion, ShadowRunRecord, ShadowSpoken, ShadowTurn } from "./shadow.js";

/** The three words a reader writes beside a line. */
export const VERDICTS = "welcome / not / wrong";

/** What goes where a verdict has not been written yet. */
export const VERDICT_BLANK = `**Verdict:** _(${VERDICTS})_`;

/** The file a run is written to, relative to the repo root. */
export function shadowReportPath(session: string): string {
  return `tasks/shadow-${session}.md`;
}

/** The whole report. */
export function renderShadowReport(run: ShadowRunRecord): string {
  const blocks: string[] = [
    `# Shadow run: ${run.session}`,
    preamble(run),
  ];
  if (run.error !== undefined) {
    blocks.push(`## The replay failed`, `\`\`\`\n${run.error}\n\`\`\``);
    return `${blocks.join("\n\n")}\n`;
  }
  blocks.push(
    `## What Sotto would have said out loud`,
    spokenSection(run),
    `## Questions the classifier heard`,
    questionSection(run),
    `## What reached the stage`,
    cardSection(run),
    `## What Sotto almost said`,
    almostSaidSection(run),
  );
  return `${blocks.join("\n\n")}\n`;
}

/** Where the numbers came from, and how to mark the thing up. */
function preamble(run: ShadowRunRecord): string {
  const lines = [
    `A real conversation replayed through the v3 pipeline at \`max\` speed, with` +
      ` Sotto's voice on a sink and the hello suppressed, so that what it would have` +
      ` said can be read before anybody hears it say anything (V3-016). Nothing here` +
      ` was heard by the people in the room: they had this conversation before Sotto` +
      ` could speak.`,
    [
      `- Recorded: ${run.recordedAt ?? "unknown"} (source \`${run.source ?? "unknown"}\`)`,
      `- Replayed: ${run.runAt}${run.gitCommit === null ? "" : ` at commit \`${run.gitCommit}\``}`,
      `- Settings: ${policySettingsLabel(run.settings)}` +
        `${run.gate === null ? "" : `, interjection gate \`${run.gate}\``}, voice ${run.voice}`,
      `- Conversation: ${clock(run.durationMs)} and ${run.finalTurns} final turn(s);` +
        ` replay took ${seconds(run.elapsedMs)}`,
      `- Session folder for this replay: ${run.sessionDir ?? "none (it could not be opened)"}`,
    ].join("\n"),
    `**To mark this up:** replace each \`_(${VERDICTS})_\` with one of those three` +
      ` words, and add a sentence where it needs one. Offers (V3-005) and follow-ups` +
      ` without the wake word (V3-014) are built after the V3-011 checkpoint, so` +
      ` nothing of theirs can appear here.`,
    `**What a \`max\` replay cannot tell you.** Simulated time does not move inside a` +
      ` model call, so a line's "from the trigger turn" reads near zero where a room` +
      ` would have waited seconds, and whether the conversation was really quiet at` +
      ` that instant is not measurable — the room's next scripted turn always looks as` +
      ` though it started mid-sentence. Judge the *judgement* here (was this worth` +
      ` saying, about the right thing, at roughly the right point in the conversation?)` +
      ` and leave the timing to the live checkpoint, which is the only clock that` +
      ` charges for it.`,
  ];
  return lines.join("\n\n");
}

/** Every unprompted line, said or not, newest last. */
function spokenSection(run: ShadowRunRecord): string {
  if (run.spoken.length === 0) {
    return (
      `_Sotto would have said nothing out loud in this conversation._\n\n` +
      `That is the designed answer at ${policySettingsLabel(run.settings)} rather than` +
      ` a gap: it speaks unasked only to answer something the room wondered aloud and` +
      ` it could look up (V3-002, V3-004), to read back a decision at frequency` +
      ` \`often\` (V3-013), or to correct a verified factual error at boldness \`bold\`` +
      ` (V3-008). Everything else it noticed is in the two sections below. Run it again` +
      ` with \`--frequency often --boldness bold\` to read what the most forward` +
      ` settings would have produced.`
    );
  }
  const said = run.spoken.filter((one) => one.record.spoken).length;
  const blocks = [
    `${run.spoken.length} unprompted line(s) reached a decision; ${said} would have been said.`,
  ];
  run.spoken.forEach((one, index) => {
    blocks.push(spokenBlock(one, index + 1));
  });
  return blocks.join("\n\n");
}

function spokenBlock(one: ShadowSpoken, index: number): string {
  const record = one.record;
  const heading =
    `### ${index}. ${record.kind} — “${record.topic}” — ` +
    (record.spoken ? `**said** at ${clock(record.atMs)}` : `**not said** (${record.reason ?? "no reason recorded"})`);
  const lines = [heading];
  if (one.trigger !== null) lines.push(quote(one.trigger));
  lines.push(`> **Sotto:** ${record.text}`);
  if (record.heard !== undefined && record.heard !== record.text) {
    lines.push(`_Heard only this far: ${record.heard}_`);
  }
  lines.push(details(one));
  lines.push(VERDICT_BLANK);
  return lines.join("\n\n");
}

/** The numbers under one line: timing, the pause, and the cached verdict. */
function details(one: ShadowSpoken): string {
  const record = one.record;
  const bullets: string[] = [];
  bullets.push(
    one.sinceTriggerMs === null
      ? `- From the trigger turn: unknown (its turn is not in the kept transcript)`
      : `- From the trigger turn: ${seconds(one.sinceTriggerMs)}`,
  );
  bullets.push(
    record.pauseWaitMs === undefined
      ? `- Pause: none was found${record.reason === undefined ? "" : ` (${record.reason})`}`
      : `- Pause: found after waiting ${seconds(record.pauseWaitMs)}` +
        `; the conversation was ${one.inPause ? "really quiet" : "NOT quiet"} at that moment`,
  );
  const current = record.stillCurrent;
  bullets.push(
    current === undefined
      ? `- Still current: not checked`
      : `- Still current: ${current.verdict}` +
        `${current.verdict === "answered" ? (current.agrees ? " (and the search agrees)" : " (and the search disagrees)") : ""}` +
        `, over ${current.turns} turn(s), ` +
        (current.latencyMs === 0 ? "no call made" : `${seconds(current.latencyMs)} call`) +
        `${current.fallback ? ", fallback" : ""}`,
  );
  if (record.attached !== undefined && record.attached !== null) {
    bullets.push(`- Attached: the ${record.attached === "group" ? "group's own" : "its own"} open question`);
  }
  if (record.decision !== undefined) bullets.push(`- Decision read back: ${record.decision}`);
  if ((record.yields ?? 0) > 0) {
    bullets.push(`- Talked over ${record.yields} time(s)${record.retrying === true ? ", retrying" : ""}`);
  }
  if (record.bargedIn === true) bullets.push(`- Stopped by a barge-in`);
  return bullets.join("\n");
}

/** Every classification, so a question Sotto never acted on is visible. */
function questionSection(run: ShadowRunRecord): string {
  if (run.questions.length === 0) {
    return (
      `_No turn in this conversation was question-shaped enough to classify._` +
      (run.addressedTurns === 0
        ? ""
        : ` ${run.addressedTurns} turn(s) addressed Sotto by name and went to the address path instead.`)
    );
  }
  const counts = new Map<string, number>();
  for (const one of run.questions) counts.set(one.kind, (counts.get(one.kind) ?? 0) + 1);
  const summary =
    `${run.questions.length} classification(s): ` +
    [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ") +
    (run.addressedTurns === 0
      ? ""
      : `. ${run.addressedTurns} further turn(s) addressed Sotto by name and went to the address path.`);
  return [
    summary,
    `A verdict a reader disagrees with is as much a finding as a line Sotto said:` +
      ` an \`open_question\` that was really rhetorical is a false positive, and a` +
      ` \`rhetorical\` or \`none\` that the room genuinely wanted looked up is the` +
      ` miss this section exists to show. Write one of ${VERDICTS} in the last column.`,
    table(
      ["At", "Classified as", "Who", "What was said", "Call", `Verdict (${VERDICTS})`],
      run.questions.map(questionRow),
    ),
  ].join("\n\n");
}

function questionRow(one: ShadowQuestion): string[] {
  return [
    clock(one.atMs),
    one.closing === true ? `${one.kind} + closing` : one.kind,
    one.turn?.speaker ?? "?",
    one.turn === null ? "_(turn not kept)_" : one.turn.text,
    `${seconds(one.latencyMs)}${one.fallback ? " (fallback)" : ""}`,
    "",
  ];
}

/** The cards: what the room would have seen without anything being said. */
function cardSection(run: ShadowRunRecord): string {
  if (run.cards.length === 0) return `_Nothing reached the stage._`;
  return [
    `${run.cards.length} card(s). A ✋ is one Sotto was still holding and had not said` +
      ` (V3-017): at the default settings that is how almost everything it notices` +
      ` reaches the room.`,
    table(
      ["At", "Card", "Headline", `Verdict (${VERDICTS})`],
      run.cards.map((card) => [
        clock(card.createdAtMs),
        `${card.variant}${card.raised ? " ✋" : ""}`,
        card.headline,
        "",
      ]),
    ),
  ].join("\n\n");
}

/** The policy's silent decisions, as the digest and the stage's tray have them. */
function almostSaidSection(run: ShadowRunRecord): string {
  if (run.suppressed.length === 0) return `_The policy held nothing back._`;
  const items = run.suppressed
    .map(
      (held) =>
        `- **${held.headline}** — ${held.reason} _(${words(held.type)}, score ${held.score.toFixed(2)})_`,
    )
    .join("\n");
  return [
    `What the policy noticed and decided against, with its own reason and score —` +
      ` the same list \`digest.md\` ends with and the stage's "almost said" tray shows.`,
    items,
    VERDICT_BLANK,
  ].join("\n\n");
}

/**
 * One markdown table, header and all, as a single block — the rows have to be
 * adjacent lines, which is the one thing joining the report's blocks with
 * blank lines would break.
 */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

/** `mm:ss` into the conversation. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** One duration, in the seconds a reader thinks in. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One turn as a block quote, which is how the trigger is shown. */
function quote(turn: ShadowTurn): string {
  return `> **${turn.speaker}** (${clock(turn.startMs)}): ${turn.text}`;
}

/** Text safe to put in a markdown table cell. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

/** A type as a person reads it: `untested_assumption` → untested assumption. */
function words(value: string): string {
  return value.replaceAll("_", " ");
}
