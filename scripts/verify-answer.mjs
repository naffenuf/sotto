/**
 * Browser check for the answer agent (US-018).
 *
 * One real session, no mocks: the `ask-search` capture is replayed at 1x, so
 * somebody says "Sotto, what do the main competitors charge per month?" out
 * loud 26 s in and the server does the rest — wake detection, the searching
 * call, the card. What this watches is the part only a browser can show: that
 * the card goes up as `thinking` the moment the question is heard, that the
 * headline and then the detail and sources arrive *into the same card*, and
 * that the answer is readable at a glance when it lands.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-answer.mjs /tmp/shot.png
 *
 * Writes the thinking card to `<name>-thinking.png` and the finished answer,
 * with its details open, to the path given as the first argument.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/answer.png";
const thinkingShot = shot.replace(/\.png$/, "-thinking.png");
const sessionsDir = fileURLToPath(new URL("../sessions/", import.meta.url));

/** The wake line is 26 s into a 48 s capture; the call then searches. */
const ANSWER_TIMEOUT_MS = 240_000;

/** How long a headline may take once the question has been heard. */
const HEADLINE_TIMEOUT_MS = 180_000;

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

const waitForDot = (channel, state, timeout = 20_000) =>
  page.waitForFunction(
    ({ channel, state }) =>
      document.querySelector(`[data-testid="status-${channel}"]`)?.dataset.state === state,
    { channel, state },
    { timeout },
  );

/** The answer card on the stage, as the page renders it. */
const readAnswer = () =>
  page.evaluate(() => {
    const node = document.querySelector(
      '[data-testid="stage-cards"] [data-testid="card"][data-variant="answer"]',
    );
    if (node === null) return null;
    // `.card__headline` only: while the card is thinking with nothing to
    // show, `card-headline` is the "thinking…" placeholder instead.
    const headline = node.querySelector(".card__headline");
    return {
      state: node.dataset.state,
      question: node.querySelector('[data-testid="card-question"]')?.textContent?.trim() ?? "",
      asker: node.querySelector('[data-testid="card-asker"]')?.textContent?.trim() ?? "",
      headline: headline?.textContent?.trim() ?? "",
      headlinePx:
        headline === null ? 0 : Math.round(parseFloat(getComputedStyle(headline).fontSize)),
      thinking: node.querySelector('[data-testid="card-thinking"]') !== null,
      hasDetails: node.querySelector('[data-testid="card-details-toggle"]') !== null,
      sources: [...node.querySelectorAll('[data-testid="card-source"]')].map((one) => ({
        text: one.textContent.trim(),
        href: one.querySelector("a")?.getAttribute("href") ?? null,
      })),
      // A verdict on an answer has nothing to file: US-015's buttons are
      // about an interjection call.
      feedback: node.querySelectorAll('[data-testid="card-feedback"] button').length,
    };
  });

await page.goto(url, { waitUntil: "networkidle" });
await waitForDot("server", "active");

await page.getByTestId("source-select").selectOption("events:ask-search");
const startedAt = Date.now();
await page.getByTestId("start-session").click();
await waitForDot("transcription", "active");

// The card goes up the moment the question is heard, before any of it is known.
await page.waitForSelector('[data-testid="card"][data-variant="answer"]', {
  timeout: ANSWER_TIMEOUT_MS,
});
const askedAfterMs = Date.now() - startedAt;
const thinking = await readAnswer();
await page.screenshot({ path: thinkingShot });

// Then the headline, into the same card.
await page.waitForFunction(
  () =>
    (document
      .querySelector('[data-testid="card"][data-variant="answer"] .card__headline')
      ?.textContent?.trim() ?? "") !== "",
  undefined,
  { timeout: HEADLINE_TIMEOUT_MS },
);
const headlineAfterMs = Date.now() - startedAt;
const headlined = await readAnswer();

// And the rest of it when the model stops.
await page.waitForSelector('[data-testid="card"][data-variant="answer"][data-state="ready"]', {
  timeout: HEADLINE_TIMEOUT_MS,
});
const readyAfterMs = Date.now() - startedAt;
// The detail is behind "details ▾", as it is for every card.
const toggle = page.locator(
  '[data-testid="card"][data-variant="answer"] [data-testid="card-details-toggle"]',
);
if (await toggle.count()) await toggle.first().click();
const ready = await readAnswer();
const details = (await page
  .locator('[data-testid="card"][data-variant="answer"] [data-testid="card-details"]')
  .count())
  ? await page
      .locator('[data-testid="card"][data-variant="answer"] [data-testid="card-details"]')
      .first()
      .evaluate((node) => ({
        text: node.textContent.trim(),
        lists: node.querySelectorAll("ul,ol").length,
      }))
  : null;
const cards = await page.locator('[data-testid="card"]').count();
await page.screenshot({ path: shot });

const folder = newestSession("events-ask-search");
const answers = readLog(folder, "answers.jsonl");

const problem = (await page.getByTestId("session-problem").count())
  ? (await page.getByTestId("session-problem").textContent())?.trim()
  : null;

// The capture may still be running; a finished replay leaves Stop disabled.
if (await page.getByTestId("stop-session").isEnabled()) {
  await page.getByTestId("stop-session").click();
  await waitForDot("transcription", "idle", 90_000).catch(() => {});
}

console.log(
  JSON.stringify(
    {
      askedAfterMs,
      headlineAfterMs,
      readyAfterMs,
      thinking,
      headlined,
      ready,
      details,
      cards,
      folder,
      answers: answers.map((one) => ({
        id: one.id,
        status: one.status,
        headline: one.headline,
        citations: one.citations?.length ?? 0,
        latencyMs: one.latencyMs,
      })),
      problem,
      consoleErrors,
    },
    null,
    2,
  ),
);

const failures = [];
if (thinking === null) failures.push("no answer card appeared");
if (thinking?.state !== "thinking") failures.push(`the card arrived as ${thinking?.state}`);
if (thinking?.headline !== "") failures.push("the card arrived with a headline already");
if (thinking?.thinking !== true) failures.push("the thinking card has no thinking indicator");
if (!/competitors charge/i.test(thinking?.question ?? ""))
  failures.push(`the card asks ${JSON.stringify(thinking?.question)}`);
if ((thinking?.asker ?? "") === "") failures.push("the card does not say who asked");

if ((headlined?.headline ?? "").length === 0) failures.push("the headline never arrived");
if ((headlined?.headline ?? "").length > 90)
  failures.push(`the headline is ${headlined?.headline.length} characters`);
if (ready?.state !== "ready") failures.push(`the card finished as ${ready?.state}`);
if (ready?.headlinePx < 28) failures.push(`the headline is ${ready?.headlinePx}px, under 28`);
if (ready?.sources.length === 0) failures.push("the answer shows no sources");
for (const source of ready?.sources ?? []) {
  if (!/^https?:\/\//.test(source.href ?? "")) failures.push(`a source links to ${source.href}`);
}
if (ready?.feedback !== 0) failures.push(`the answer card has ${ready?.feedback} feedback buttons`);
if (details === null || details.text === "") failures.push("the detail is empty");
// One card, pushed three times: the stage must not have stacked them.
if (cards !== 1) failures.push(`the stage has ${cards} cards, expected 1`);

if (answers.length !== 1) failures.push(`answers.jsonl has ${answers.length} lines, expected 1`);
else if (answers[0].status !== "done") failures.push(`the answer is ${answers[0].status}`);
else if (answers[0].headline !== ready?.headline)
  failures.push("answers.jsonl disagrees with the card about the headline");

if (problem !== null) failures.push(`the page showed a problem: ${problem}`);
if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.join(" | ")}`);

await browser.close();

if (failures.length > 0) {
  console.error(`\nFAIL\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nOK — answer card verified; screenshots at ${thinkingShot} and ${shot}`);
