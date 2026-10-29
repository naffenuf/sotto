/**
 * Browser check for typed questions (US-019).
 *
 * The "Ask Sotto…" box is the one part of the answer path a replay will never
 * exercise on its own, and the thing worth proving about it is that it is the
 * *same* path: Enter sends the question, an answer card appears on the stage
 * as `thinking` and finishes there, and the card says it was `typed`.
 *
 * It is checked twice, because the PRD asks for both: once while the
 * `no-wake` capture is replaying (that fixture says Sotto's name three times
 * without ever addressing it, so every card on the stage got there by being
 * typed), and once after Stop, against the conversation that just ended.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-ask.mjs /tmp/shot.png
 *
 * Writes the first answer to `<name>-running.png` and the one typed after
 * Stop to the path given as the first argument.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/ask.png";
const runningShot = shot.replace(/\.png$/, "-running.png");
const sessionsDir = fileURLToPath(new URL("../sessions/", import.meta.url));

/** An answer searches the web before it writes, which takes its time. */
const ANSWER_TIMEOUT_MS = 180_000;

const DURING = "What did we just say about the roadmap?";
const AFTER = "Summarise what this conversation decided.";

/** The newest session folder for `source`, by modification time. */
function newestSession(source) {
  return readdirSync(sessionsDir)
    .filter((name) => name.endsWith(source))
    .map((name) => ({ name, at: statSync(join(sessionsDir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]?.name;
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
// The first question is refused on purpose, and a 4xx on a `fetch` is logged
// as a console error whatever the page does with it.
const EXPECTED_ERROR = /status of 409/;
page.on(
  "console",
  (m) => m.type() === "error" && !EXPECTED_ERROR.test(m.text()) && consoleErrors.push(m.text()),
);
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const waitForDot = (channel, state, timeout = 20_000) =>
  page.waitForFunction(
    ({ channel, state }) =>
      document.querySelector(`[data-testid="status-${channel}"]`)?.dataset.state === state,
    { channel, state },
    { timeout },
  );

/** Every answer card on the stage, as the page renders it. */
const readAnswers = () =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-testid="stage-cards"] [data-testid="card"][data-variant="answer"]',
      ),
    ].map((node) => ({
      state: node.dataset.state,
      question: node.querySelector(".card__question")?.textContent?.trim() ?? "",
      asker: node.querySelector('[data-testid="card-asker"]')?.textContent?.trim() ?? "",
      headline: node.querySelector(".card__headline")?.textContent?.trim() ?? "",
      sources: node.querySelectorAll('[data-testid="card-source"]').length,
    })),
  );

/** Types a question and presses Enter — no button click, as the PRD asks. */
async function typeQuestion(question) {
  const input = page.getByTestId("ask-input");
  await input.fill(question);
  await input.press("Enter");
}

/** Waits until `count` answer cards are on the stage and all of them are done. */
const waitForAnswers = (count) =>
  page.waitForFunction(
    (count) => {
      const cards = [
        ...document.querySelectorAll(
          '[data-testid="stage-cards"] [data-testid="card"][data-variant="answer"]',
        ),
      ];
      return cards.length === count && cards.every((card) => card.dataset.state === "ready");
    },
    count,
    { timeout: ANSWER_TIMEOUT_MS },
  );

await page.goto(url, { waitUntil: "networkidle" });
await waitForDot("server", "active");

// Before anything has run there is no conversation to answer in, and the
// server says so rather than inventing one.
await typeQuestion("is anybody there?");
await page.waitForSelector('[data-testid="session-problem"]', { timeout: 10_000 });
const beforeSession = (await page.getByTestId("session-problem").textContent())?.trim();
// The box keeps what was typed when the server would not take it.
const keptText = await page.getByTestId("ask-input").inputValue();

// `no-wake` says "sotto voce" and "Soto's restaurant" but never addresses
// Sotto, so nothing on the stage can have come from the wake watcher.
await page.getByTestId("source-select").selectOption("events:no-wake");
await page.getByTestId("start-session").click();
await waitForDot("transcription", "active");
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="turn"]').length > 2,
  undefined,
  { timeout: 60_000 },
);

const askedAt = Date.now();
await typeQuestion(DURING);
// The card goes up before any of the answer is known.
await page.waitForSelector('[data-testid="card"][data-variant="answer"][data-state="thinking"]', {
  timeout: 30_000,
});
const thinking = (await readAnswers())[0];
// And the box empties, ready for the next one.
const clearedText = await page.getByTestId("ask-input").inputValue();
await waitForAnswers(1);
const duringMs = Date.now() - askedAt;
const during = (await readAnswers())[0];
await page.screenshot({ path: runningShot });

// Then the same thing with nothing running.
if (await page.getByTestId("stop-session").isEnabled()) {
  await page.getByTestId("stop-session").click();
}
await waitForDot("transcription", "idle", 90_000);
const stoppedAt = Date.now();
await typeQuestion(AFTER);
await waitForAnswers(2);
const afterMs = Date.now() - stoppedAt;
// `POST /api/session/stop` drains the answer queue, so a question typed into
// that window holds the reply — and the controls stay disabled until it
// comes back. They must not stay that way.
await page
  .getByTestId("start-session")
  .waitFor({ state: "attached", timeout: 10_000 })
  .catch(() => {});
const controlsFreed = await page
  .waitForFunction(
    () => document.querySelector('[data-testid="start-session"]')?.disabled === false,
    undefined,
    { timeout: 15_000 },
  )
  .then(() => true)
  .catch(() => false);
const answers = await readAnswers();
await page.screenshot({ path: shot });

const folder = newestSession("events-no-wake");
const logged = readLog(folder, "answers.jsonl");
const problem = (await page.getByTestId("session-problem").count())
  ? (await page.getByTestId("session-problem").textContent())?.trim()
  : null;

console.log(
  JSON.stringify(
    {
      beforeSession,
      keptText,
      clearedText,
      thinking,
      during,
      duringMs,
      afterMs,
      controlsFreed,
      answers,
      folder,
      logged: logged.map((one) => ({
        id: one.id,
        status: one.status,
        askedBy: one.askedBy,
        turnId: one.turnId,
        question: one.question,
        headline: one.headline,
      })),
      problem,
      consoleErrors,
    },
    null,
    2,
  ),
);

const failures = [];
if (!/start a session first/i.test(beforeSession ?? ""))
  failures.push(`asking before any session said ${JSON.stringify(beforeSession)}`);
if (keptText !== "is anybody there?") failures.push("a refused question was lost from the box");

if (thinking === undefined) failures.push("no card appeared for the question typed during a session");
if (thinking?.asker !== "typed") failures.push(`the card says ${JSON.stringify(thinking?.asker)} asked`);
if (thinking?.question !== DURING)
  failures.push(`the card asks ${JSON.stringify(thinking?.question)}`);
if (clearedText !== "") failures.push("the box kept the question after it was sent");
if ((during?.headline ?? "") === "") failures.push("the answer never got a headline");
if ((during?.headline ?? "").length > 90)
  failures.push(`the headline is ${during?.headline.length} characters`);

if (answers.length !== 2) failures.push(`the stage has ${answers.length} answers, expected 2`);
const afterCard = answers.find((card) => card.question === AFTER);
if (afterCard === undefined) failures.push("the question typed after Stop produced no card");
if (afterCard !== undefined && afterCard.state !== "ready")
  failures.push(`the answer typed after Stop is ${afterCard.state}`);
if (afterCard !== undefined && afterCard.asker !== "typed")
  failures.push(`the second card says ${JSON.stringify(afterCard.asker)} asked`);

if (logged.length !== 2) failures.push(`answers.jsonl has ${logged.length} lines, expected 2`);
for (const one of logged) {
  if (one.askedBy !== "typed") failures.push(`${one.id} was filed as ${one.askedBy}`);
  if (one.turnId !== null) failures.push(`${one.id} was filed against turn ${one.turnId}`);
  if (one.status !== "done") failures.push(`${one.id} is ${one.status}`);
}

if (!controlsFreed) failures.push("Start never came back after the session was stopped");
if (problem !== null) failures.push(`the page showed a problem: ${problem}`);
if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.join(" | ")}`);

await browser.close();

if (failures.length > 0) {
  console.error(`\nFAIL\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nOK — typed questions verified; screenshots at ${runningShot} and ${shot}`);
