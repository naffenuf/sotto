/**
 * Browser check for Sotto's own speech in the transcript (V2-008a).
 *
 * `/ws/events` is mocked, because the thing being checked is a *pair* of rows
 * a conversation will not reliably produce side by side: a complete line of
 * Sotto's speech and one the room only heard part of, each placed where
 * playback started rather than where it arrived. The server is never asked for
 * a session, so this costs no model call and no synthesis.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-sotto-transcript.mjs /tmp/shot.png
 */
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/sotto-transcript.png";

/**
 * One conversation, out of order on purpose: Sotto's line is sent last and
 * belongs in the middle, because an utterance is written down when it is over
 * and placed where it began.
 */
const TURNS = [
  {
    turnId: "0:1", speaker: "A", final: true, startMs: 2_000, endMs: 7_000,
    speakerMappingUncertain: false,
    text: "Sotto, what do the main competitors charge per month?",
  },
  {
    turnId: "0:2", speaker: "B", final: true, startMs: 31_000, endMs: 33_500,
    speakerMappingUncertain: false,
    text: "Sotto, stop — we only need the cheap one.",
  },
  {
    turnId: "0:3", speaker: "B", final: true, startMs: 46_000, endMs: 49_000,
    speakerMappingUncertain: false,
    text: "So twelve dollars is the number to beat.",
  },
  // Complete: every word of it was heard.
  {
    turnId: "sotto:ans-1", speaker: "Sotto", final: true, startMs: 12_000, endMs: 12_000,
    speakerMappingUncertain: false, sotto: true,
    text: "They charge five to twenty-five dollars a seat, and Notion is twelve.",
  },
  // Cut off: only the part before the barge-in at 00:31.
  {
    turnId: "sotto:ans-2", speaker: "Sotto", final: true, startMs: 38_000, endMs: 38_000,
    speakerMappingUncertain: false, sotto: true, interrupted: true,
    text: "The cheapest of those is",
  },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

// React's StrictMode runs the socket effect twice in dev and the first
// socket's close schedules a reconnect, so the live ones are tracked rather
// than assumed to be one (`CLAUDE.md`).
const sockets = [];
await page.routeWebSocket(/\/ws\/events/, (ws) => {
  sockets.push(ws);
  ws.onClose(() => {
    const at = sockets.indexOf(ws);
    if (at !== -1) sockets.splice(at, 1);
  });
});
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(3_000);
if (sockets.length === 0) throw new Error("the mocked /ws/events socket never settled");
const push = (event) => {
  for (const ws of [...sockets]) ws.send(JSON.stringify(event));
};

push({
  type: "session",
  session: { id: "mock-1", source: { kind: "mic" }, startedAtMs: 0 },
});
push({ type: "status", status: { channel: "transcription", state: "active" } });
push({ type: "speakers", speakers: { A: "Craig", B: "EJ" } });
for (const turn of TURNS) push({ type: "turn", turn });

// The transcript is behind its own tab; the board is what the sidebar opens on.
await page.locator('.discussion-tabs button:text-is("Transcript")').click();
await page.waitForFunction(
  (count) => document.querySelectorAll('[data-testid="turn"]').length === count,
  TURNS.length,
  { timeout: 10_000 },
);

const rows = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="turn"]')].map((row) => {
    const chip = row.querySelector('[data-testid="speaker-chip"]');
    const text = row.querySelector(".turn__text");
    const style = getComputedStyle(row);
    return {
      turnId: row.dataset.turnId,
      sotto: row.dataset.sotto === "true",
      interrupted: row.dataset.interrupted === "true",
      chip: chip.textContent.trim(),
      chipDisabled: chip.disabled,
      chipBackground: getComputedStyle(chip).backgroundColor,
      text: (text?.textContent ?? "").trim(),
      marker: (row.querySelector('[data-testid="turn-interrupted"]')?.textContent ?? "").trim(),
      borderLeft: style.borderLeftWidth,
      marginLeft: style.marginLeft,
      italic: getComputedStyle(text).fontStyle,
    };
  }),
);

await page.screenshot({ path: shot });

const problems = [];
const order = rows.map((row) => row.turnId);
// Placed where playback started, so Sotto's first line sits between the
// question at 00:02 and the barge-in at 00:31.
const expected = ["0:1", "sotto:ans-1", "0:2", "sotto:ans-2", "0:3"];
if (order.join(",") !== expected.join(",")) {
  problems.push(`rows are in the wrong order: ${order.join(", ")}`);
}

const mine = rows.filter((row) => row.sotto);
if (mine.length !== 2) problems.push(`expected two Sotto rows, found ${mine.length}`);
for (const row of mine) {
  if (row.chip !== "Sotto") problems.push(`${row.turnId} chip reads "${row.chip}"`);
  if (!row.chipDisabled) problems.push(`${row.turnId} offers to rename Sotto`);
  // The distinct style: an accent rule down the left, indented, italic text.
  if (row.borderLeft === "0px") problems.push(`${row.turnId} has no Sotto rule`);
  if (row.italic !== "italic") problems.push(`${row.turnId} is not set apart`);
  if (parseFloat(row.marginLeft) <= 0) problems.push(`${row.turnId} is not indented`);
}

const human = rows.filter((row) => !row.sotto);
for (const row of human) {
  if (row.borderLeft !== "0px") problems.push(`${row.turnId} picked up the Sotto rule`);
  if (row.marker !== "") problems.push(`${row.turnId} is marked interrupted`);
}

const whole = rows.find((row) => row.turnId === "sotto:ans-1");
if (whole?.text !== TURNS[3].text) problems.push("the complete line is not Sotto's own text");
if (whole?.interrupted) problems.push("the complete line is marked interrupted");
if (whole?.marker !== "") problems.push(`the complete line reads "${whole?.marker}"`);

const cut = rows.find((row) => row.turnId === "sotto:ans-2");
// Only the heard part, and said to be only the heard part.
if (cut?.text !== "The cheapest of those is") problems.push("the stopped line shows more than was heard");
if (!cut?.interrupted) problems.push("the stopped line is not marked interrupted");
if (!/interrupted/.test(cut?.marker ?? "")) problems.push("the stopped line has no marker");

if (consoleErrors.length > 0) problems.push(`console errors: ${consoleErrors.join(" | ")}`);

console.log(JSON.stringify({ shot, rows }, null, 2));
await browser.close();

if (problems.length > 0) {
  console.error(`\nFAIL\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("\nPASS: Sotto's speech reads as Sotto's, in conversation order.");
