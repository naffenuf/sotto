/**
 * Browser check for interjection delivery and feedback (US-015).
 *
 * Two pages, because the two halves need different things:
 *
 *  1. The real one. A `moment-contradiction` events replay, with the real
 *     board, observer and policy behind it, until a card reaches the stage.
 *     Then the three things only a real session can show: that an evidence
 *     quote scrolls the transcript to the turn it came from and marks it,
 *     that a feedback click lands in the session folder's `feedback.jsonl`,
 *     and that nothing about delivery plays a sound or opens a modal.
 *  2. A mocked `/ws/events`, for the variants a conversation will not reliably
 *     produce on demand: an `interject` card with citations beside a `glow`
 *     that opens into the same card. The components are the real ones; only
 *     the server is not.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-delivery.mjs /tmp/shot.png
 *
 * Writes the delivered card to the path given as the first argument, the
 * cited transcript turn to `<name>-cited.png` and the mocked pair to
 * `<name>-mock.png`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/delivery.png";
const citedShot = shot.replace(/\.png$/, "-cited.png");
const mockShot = shot.replace(/\.png$/, "-mock.png");
const sessionsDir = fileURLToPath(new URL("../sessions/", import.meta.url));

/** How long a card may take to arrive: the whole replay, plus the drain. */
const DELIVERY_TIMEOUT_MS = 360_000;

/** The newest session folder for `source`, by modification time. */
function newestSession(source) {
  const folders = readdirSync(sessionsDir)
    .filter((name) => name.endsWith(source))
    .map((name) => ({ name, at: statSync(join(sessionsDir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return folders[0]?.name;
}

/** Every line of a session folder's `.jsonl`, or `[]` if it was never opened. */
function readLog(folder, file) {
  try {
    return readFileSync(join(sessionsDir, folder, file), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

/**
 * Nothing about a delivery may make a noise, so every way the page could
 * start one is counted before any of its own code runs. A count of zero at
 * the end is the criterion; a browser that is simply muted is not.
 */
await page.addInitScript(() => {
  window.__sounds = [];
  const note = (what) => window.__sounds.push(what);
  const RealAudio = window.Audio;
  window.Audio = function (...args) {
    note("new Audio");
    return new RealAudio(...args);
  };
  for (const name of ["AudioContext", "webkitAudioContext"]) {
    const Real = window[name];
    if (Real === undefined) continue;
    window[name] = function (...args) {
      note(`new ${name}`);
      return new Real(...args);
    };
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    note("play()");
    return play.apply(this, args);
  };
  // A modal would be one of these; the stage is meant to be glanceable.
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function (...args) {
    note("showModal()");
    return showModal.apply(this, args);
  };
  window.alert = () => note("alert()");
});

const waitForDot = (channel, state, timeout = 20_000) =>
  page.waitForFunction(
    ({ channel, state }) =>
      document.querySelector(`[data-testid="status-${channel}"]`)?.dataset.state === state,
    { channel, state },
    { timeout },
  );

await page.goto(url, { waitUntil: "networkidle" });
await waitForDot("server", "active");

// The hint the stage shows until there is a card to show instead.
const emptyStage = (await page.getByTestId("session-state").textContent())?.trim();

// ---- The real thing: a replay, until Sotto says something ----

await page.getByTestId("source-select").selectOption("events:moment-contradiction");
const startedAt = Date.now();
await page.getByTestId("start-session").click();
await waitForDot("transcription", "active");

await page.waitForSelector('[data-testid="card"]', {
  timeout: DELIVERY_TIMEOUT_MS,
});
const deliveredAfterMs = Date.now() - startedAt;

/** Every card on the stage, as the page renders it. */
const readCards = (target) =>
  target.evaluate(() =>
    [...document.querySelectorAll('[data-testid="stage-cards"] [data-testid="card"]')].map(
      (node) => ({
        variant: node.dataset.variant,
        state: node.dataset.state,
        headline: node.querySelector('[data-testid="card-headline"]')?.textContent?.trim() ?? "",
        why: node.querySelector('[data-testid="card-why"]')?.textContent?.trim() ?? null,
        quotes: [...node.querySelectorAll('[data-testid="card-quote"]')].map((quote) => ({
          turnId: quote.dataset.turnId,
          text: quote.textContent.trim(),
          clickable: quote.querySelector('[data-testid="card-quote-link"]') !== null,
        })),
        sources: [...node.querySelectorAll('[data-testid="card-source"]')].map((one) =>
          one.textContent.trim(),
        ),
        feedback: [...node.querySelectorAll('[data-testid="card-feedback"] button')].map(
          (button) => button.title,
        ),
        hasDetails: node.querySelector('[data-testid="card-details-toggle"]') !== null,
      }),
    ),
  );

const liveCards = await readCards(page);
await page.screenshot({ path: shot });

// The quote goes back to the transcript: the cited turn is marked and in view.
const quoted = page.locator('[data-testid="card"] [data-testid="card-quote-link"]').first();
const citedTurnId = await page
  .locator('[data-testid="card"] [data-testid="card-quote"]')
  .first()
  .getAttribute("data-turn-id");
await quoted.click();
await page.waitForSelector('[data-testid="turn"][data-cited="true"]', {
  timeout: 5_000,
});
const citedRow = await page.evaluate(() => {
  const row = document.querySelector('[data-testid="turn"][data-cited="true"]');
  const list = document.querySelector(".transcript__list");
  if (row === null || list === null) return null;
  const rowBox = row.getBoundingClientRect();
  const listBox = list.getBoundingClientRect();
  return {
    turnId: row.dataset.turnId,
    text: row.querySelector(".turn__text")?.textContent?.trim() ?? "",
    // Whether the row the card pointed at is actually on screen in the panel.
    inView: rowBox.top >= listBox.top - 1 && rowBox.bottom <= listBox.bottom + 1,
    // Reading an old line is the opposite of following the live edge.
    jumpToLive: document.querySelector('[data-testid="jump-to-live"]') !== null,
  };
});
await page.screenshot({ path: citedShot });

// And the verdict: one click, into the session folder.
// The folder is named `<when>-<source slug>`, so the slug is the whole
// `events-moment-contradiction`, not just the kind.
const folder = newestSession("events-moment-contradiction");
await page.getByTestId("card-feedback-wrong_moment").first().click();
await page.waitForSelector('[data-testid="card-feedback-wrong_moment"][data-chosen="true"]', {
  timeout: 5_000,
});
// The POST has to reach the server and the line reach the disk.
await page.waitForTimeout(1_000);
const feedbackLines = readLog(folder, "feedback.jsonl");
const problem = (await page.getByTestId("session-problem").count())
  ? (await page.getByTestId("session-problem").textContent())?.trim()
  : null;

// Nothing on this page has made a noise or opened a modal.
const sounds = await page.evaluate(() => window.__sounds);
const dialogs = await page.locator("dialog").count();

// The decisions the policy actually took, so the card on screen can be read
// against the session's own record of it.
const decisions = readLog(folder, "candidates.jsonl")
  .filter((line) => line.kind === "decision")
  .map((line) => `${line.candidateId} ${line.decision}/${line.reason}`);

// A card arrives at the end of this capture, so by now the replay has
// usually finished on its own and Stop is already disabled.
const stopWasEnabled = await page.getByTestId("stop-session").isEnabled();
if (stopWasEnabled) {
  await page.getByTestId("stop-session").click();
  await waitForDot("transcription", "idle", 90_000).catch(() => {});
}

// ---- The variants, on a mocked `/ws/events` ----
//
// A replay shows whatever the conversation happens to produce; this is where
// an interject with citations and a glow that opens are both on screen at
// once, drawn by the real components.

const CARDS = [
  {
    id: "card-cand-1",
    variant: "interject",
    state: "ready",
    createdAtMs: 118_000,
    headline: "A $20,000 studio does not fit the $4,000 first-version budget",
    whyNow: "the studio is about to be booked",
    detailMd:
      "The budget was set at **four thousand dollars for the whole first version**, and\nevery decision was agreed to fit inside it.",
    evidence: [
      {
        turnId: "mock:3",
        quote: "We have four thousand dollars for the whole first version.",
        speaker: "Craig",
      },
      {
        turnId: "mock:20",
        quote: "Twenty thousand, roughly.",
        speaker: "Dana",
      },
    ],
    citations: [
      {
        url: "https://example.com/unit-economics",
        title: "Unit economics sheet",
      },
    ],
  },
  {
    id: "card-cand-2",
    variant: "glow",
    state: "ready",
    createdAtMs: 120_000,
    headline: "Nobody has said who owns the brand work",
    whyNow: "the studio quote includes it",
    detailMd: "It has come up twice and been dropped twice, both times near a decision.",
    evidence: [
      {
        turnId: "mock:22",
        quote: "The full set, plus a style guide.",
        speaker: "Dana",
      },
    ],
  },
];

const mockPage = await browser.newPage({
  viewport: { width: 1200, height: 900 },
});
mockPage.on("console", (m) => m.type() === "error" && consoleErrors.push(`[mock] ${m.text()}`));
mockPage.on("pageerror", (e) => consoleErrors.push(`[mock] ${e}`));

// React's StrictMode runs the socket effect twice in dev and the first
// socket's close schedules a reconnect, so the live ones are tracked rather
// than assumed to be one. No `connectToServer`: nothing reaches the server.
const sockets = [];
await mockPage.routeWebSocket(/\/ws\/events/, (ws) => {
  sockets.push(ws);
  ws.onClose(() => {
    const at = sockets.indexOf(ws);
    if (at !== -1) sockets.splice(at, 1);
  });
});
await mockPage.goto(url, { waitUntil: "networkidle" });
await mockPage.waitForTimeout(3_000);
if (sockets.length === 0) throw new Error("the mocked /ws/events socket never settled");
const push = (event) => {
  for (const ws of [...sockets]) ws.send(JSON.stringify(event));
};

push({
  type: "session",
  session: {
    id: "mock-1",
    source: { kind: "events", fixture: "moment-contradiction" },
    startedAtMs: 0,
  },
});
push({ type: "status", status: { channel: "transcription", state: "active" } });
for (const card of CARDS) push({ type: "card", card });
await mockPage.waitForFunction(
  () => document.querySelectorAll('[data-testid="card"]').length === 2,
  undefined,
  { timeout: 10_000 },
);

const mockCards = await readCards(mockPage);
const glow = mockPage.locator('[data-testid="card"][data-variant="glow"]');
const glowCollapsed = {
  expanded: await glow.getAttribute("data-expanded"),
  line: (await glow.getByTestId("card-headline").textContent())?.trim(),
  // A collapsed glow is one line: no quotes, no buttons, nothing to answer.
  quotes: await glow.getByTestId("card-quote").count(),
  feedback: await glow.getByTestId("card-feedback").count(),
};
await glow.click();
await mockPage.waitForSelector(
  '[data-testid="card"][data-variant="glow"] [data-testid="card-feedback"]',
  { timeout: 5_000 },
);
const glowOpened = await readCards(mockPage);
await mockPage.screenshot({ path: mockShot });

await browser.close();

const report = {
  emptyStage,
  deliveredAfterMs,
  decisions,
  liveCards,
  citedTurnId,
  citedRow,
  feedbackLines,
  problem,
  sounds,
  dialogs,
  stopWasEnabled,
  mockCards,
  glowCollapsed,
  glowOpened: glowOpened.find((card) => card.variant === "glow"),
  consoleErrors,
};
console.log(JSON.stringify(report, null, 2));

const failures = [];
if (liveCards.length === 0) failures.push("the replay put no card on the stage");
if (!liveCards.some((card) => card.variant === "interject" || card.variant === "glow")) {
  failures.push("no card on the stage is an interjection or a glow");
}
for (const card of liveCards) {
  if (card.headline === "") failures.push("a delivered card has no headline");
  if (card.feedback.length !== 3)
    failures.push(`card has ${card.feedback.length} feedback buttons`);
}
if (citedRow === null) failures.push("clicking a quote marked no turn");
if (citedRow !== null && citedRow.turnId !== citedTurnId) {
  failures.push(`the quote cited ${citedTurnId} and the transcript marked ${citedRow.turnId}`);
}
if (citedRow !== null && !citedRow.inView)
  failures.push("the cited turn was not scrolled into view");
if (decisions.length === 0) failures.push(`no decisions in ${folder}/candidates.jsonl`);
if (feedbackLines.length !== 1) {
  failures.push(`feedback.jsonl has ${feedbackLines.length} lines, expected 1`);
} else if (feedbackLines[0].verdict !== "wrong_moment") {
  failures.push(`feedback.jsonl recorded ${feedbackLines[0].verdict}`);
}
if (problem !== null) failures.push(`the page reported a problem: ${problem}`);
if (sounds.length > 0) failures.push(`delivery made a noise: ${sounds.join(", ")}`);
if (dialogs > 0) failures.push(`delivery opened ${dialogs} dialog(s)`);
if (glowCollapsed.expanded !== "false") failures.push("the glow did not start collapsed");
if (glowCollapsed.quotes !== 0 || glowCollapsed.feedback !== 0) {
  failures.push("a collapsed glow is showing more than one line");
}
const opened = glowOpened.find((card) => card.variant === "glow");
if (opened === undefined || opened.quotes.length === 0 || opened.feedback.length !== 3) {
  failures.push("the opened glow is not the card an interjection would have been");
}
if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.join(" | ")}`);

if (failures.length > 0) {
  console.error(`\nFAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nOK");
