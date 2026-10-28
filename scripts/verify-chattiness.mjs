/**
 * Browser check for the chattiness setting (US-014): that the header's
 * selector changes it live, that the *server* owns it — a reload shows what
 * the server holds, not what this tab clicked — and that a running session's
 * folder records it.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-chattiness.mjs /tmp/shot.png
 *
 * Writes a screenshot of the header mid-session to the path given as the
 * first argument.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/chattiness.png";
const sessionsDir = fileURLToPath(new URL("../sessions/", import.meta.url));

/** The newest session folder for `source`, by modification time. */
function newestSession(source) {
  const folders = readdirSync(sessionsDir)
    .filter((name) => name.endsWith(source))
    .map((name) => ({ name, at: statSync(join(sessionsDir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return folders[0]?.name;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const waitForDot = (channel, state, timeout = 15_000) =>
  page.waitForFunction(
    ({ channel, state }) =>
      document.querySelector(`[data-testid="status-${channel}"]`)?.dataset.state === state,
    { channel, state },
    { timeout },
  );

/** Waits for the selector to show `value`, which only the server can set. */
const waitForChattiness = (value) =>
  page.waitForFunction(
    (value) => document.querySelector('[data-testid="chattiness-select"]')?.value === value,
    value,
    { timeout: 10_000 },
  );

await page.goto(url, { waitUntil: "networkidle" });
await waitForDot("server", "active");

const select = page.getByTestId("chattiness-select");
const levels = await page
  .locator('[data-testid="chattiness-select"] option')
  .evaluateAll((nodes) => nodes.map((node) => node.value));
const startsAt = await select.inputValue();

// Turning it down with nothing running, and a reload to prove it stuck on the
// server rather than in this tab.
await select.selectOption("quiet");
await waitForChattiness("quiet");
await page.reload({ waitUntil: "networkidle" });
await waitForDot("server", "active");
const afterReload = await select.inputValue();

// And live, mid-conversation, into the session folder.
await page.getByTestId("source-select").selectOption("events:brainstorm");
await page.getByTestId("start-session").click();
await waitForDot("transcription", "active");
await select.selectOption("active");
await waitForChattiness("active");
const whileRunning = await select.inputValue();
await page.screenshot({ path: shot });
await page.getByTestId("stop-session").click();
await waitForDot("transcription", "idle");

await browser.close();

const folder = newestSession("-events-brainstorm");
const saved =
  folder === undefined
    ? undefined
    : JSON.parse(readFileSync(join(sessionsDir, folder, "session.json"), "utf8"));

console.log(
  JSON.stringify(
    { levels, startsAt, afterReload, whileRunning, folder, settings: saved?.settings },
    null,
    2,
  ),
);

const problems = [];
if (levels.join() !== "quiet,normal,active") problems.push(`the levels are ${levels.join()}`);
if (startsAt !== "normal") problems.push(`it starts at ${startsAt}, not normal`);
if (afterReload !== "quiet") problems.push(`a reload shows ${afterReload}, not quiet`);
if (whileRunning !== "active") problems.push(`mid-session it shows ${whileRunning}, not active`);
if (saved === undefined) problems.push("no session folder was written");
else if (saved.settings?.chattiness !== "active") {
  problems.push(`session.json recorded ${JSON.stringify(saved.settings)}`);
}
if (consoleErrors.length > 0) problems.push(`console errors: ${consoleErrors.join("; ")}`);
if (problems.length > 0) throw new Error(problems.join("\n"));

console.log(`\nOK — screenshot at ${shot}`);
