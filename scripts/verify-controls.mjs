/**
 * Browser check for the two contribution controls (V2-017).
 *
 * The one setting Sotto used to have ("chattiness") is now two — **how often**
 * it contributes and **how sure** it has to be — and this proves the pair the
 * way its predecessor proved the one: that each selector changes its own
 * setting and leaves the other alone, that the *server* owns both (a reload
 * shows what the server holds, not what this tab clicked), and that a running
 * session's folder records them.
 *
 * The session is started through `POST /api/session/start`, because since
 * V2-009 the header's Start button is the microphone and a real microphone is
 * not something an automated check may touch.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-controls.mjs /tmp/shot.png
 *
 * Writes a screenshot of the header mid-session to the path given as the
 * first argument.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/controls.png";
const sessionsDir = fileURLToPath(new URL("../sessions/", import.meta.url));
const FIXTURE = "brainstorm";

/** The newest session folder for `source`, by modification time. */
function newestSession(source) {
  const folders = readdirSync(sessionsDir)
    .filter((name) => name.endsWith(source))
    .map((name) => ({ name, at: statSync(join(sessionsDir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return folders[0]?.name;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

/** Waits for one selector to show `value`, which only the server can set. */
const waitForSetting = (which, value) =>
  page.waitForFunction(
    ({ which, value }) =>
      document.querySelector(`[data-testid="${which}-select"]`)?.value === value,
    { which, value },
    { timeout: 10_000 },
  );

const options = (which) =>
  page
    .locator(`[data-testid="${which}-select"] option`)
    .evaluateAll((nodes) => nodes.map((node) => node.value));

const values = async () => ({
  frequency: await page.getByTestId("frequency-select").inputValue(),
  boldness: await page.getByTestId("boldness-select").inputValue(),
});

await page.goto(url, { waitUntil: "networkidle" });
await waitForDot("server", "active");

const frequencyLevels = await options("frequency");
const boldnessLevels = await options("boldness");
const startsAt = await values();

// Turning the frequency down with nothing running, and a reload to prove it
// stuck on the server rather than in this tab. The boldness is untouched.
await page.getByTestId("frequency-select").selectOption("rare");
await waitForSetting("frequency", "rare");
await page.reload({ waitUntil: "networkidle" });
await waitForDot("server", "active");
const afterReload = await values();

// And the other one, live, mid-conversation, into the session folder.
const started = await page.evaluate(async (fixture) => {
  const response = await fetch("/api/session/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { kind: "events", fixture } }),
  });
  return response.status;
}, FIXTURE);
await waitForDot("transcription", "active");
await page.getByTestId("boldness-select").selectOption("bold");
await waitForSetting("boldness", "bold");
const whileRunning = await values();
await page.screenshot({ path: shot });
await page.screenshot({ path: shot.replace(/\.png$/, "-header.png"), clip: { x: 0, y: 0, width: 1440, height: 90 } });

await page.evaluate(() => fetch("/api/session/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
await waitForDot("transcription", "idle");
await browser.close();

const folder = newestSession(`-events-${FIXTURE}`);
const saved =
  folder === undefined
    ? undefined
    : JSON.parse(readFileSync(join(sessionsDir, folder, "session.json"), "utf8"));

console.log(
  JSON.stringify(
    { frequencyLevels, boldnessLevels, startsAt, afterReload, whileRunning, started, folder, settings: saved?.settings },
    null,
    2,
  ),
);

const problems = [];
if (frequencyLevels.join() !== "rare,normal,often") {
  problems.push(`the frequencies are ${frequencyLevels.join()}`);
}
if (boldnessLevels.join() !== "cautious,normal,bold") {
  problems.push(`the boldnesses are ${boldnessLevels.join()}`);
}
if (startsAt.frequency !== "normal" || startsAt.boldness !== "normal") {
  problems.push(`it starts at ${JSON.stringify(startsAt)}, not normal/normal`);
}
if (started !== 200) problems.push(`the session would not start (${started})`);
// One selector changed, the other did not: the two settings are separate.
if (afterReload.frequency !== "rare") {
  problems.push(`a reload shows frequency ${afterReload.frequency}, not rare`);
}
if (afterReload.boldness !== "normal") {
  problems.push(`changing the frequency also moved the boldness to ${afterReload.boldness}`);
}
// Starting a session resets both to normal, so mid-session only the
// boldness set *during* it is on: normal/bold, not rare/bold.
if (whileRunning.frequency !== "normal" || whileRunning.boldness !== "bold") {
  problems.push(`mid-session it shows ${JSON.stringify(whileRunning)}, not normal/bold`);
}
if (saved === undefined) problems.push("no session folder was written");
else if (saved.settings?.frequency !== "normal" || saved.settings?.boldness !== "bold") {
  problems.push(`session.json recorded ${JSON.stringify(saved.settings)}`);
}
if (consoleErrors.length > 0) problems.push(`console errors: ${consoleErrors.join("; ")}`);
if (problems.length > 0) throw new Error(problems.join("\n"));

console.log(`\nOK — screenshot at ${shot}`);
