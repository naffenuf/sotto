/**
 * Browser check for the Sotto UI: the header's source selector and dots, and
 * a brainstorm events replay started and stopped (US-009).
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-ui.mjs /tmp/shot.png
 *
 * Writes the running state to the path given as the first argument, and the
 * state after Stop alongside it as `<name>-idle.png`.
 */
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/ui.png";
const idleShot = shot.replace(/\.png$/, "-idle.png");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

/** The three dots, as `{ server: "active", … }`. */
const dots = () =>
  page.evaluate(() =>
    Object.fromEntries(
      ["server", "transcription", "model"].map((channel) => [
        channel,
        document.querySelector(`[data-testid="status-${channel}"]`)?.dataset.state,
      ]),
    ),
  );

/** Waits until every named dot is in `state`. */
const waitForDots = (channels, state) =>
  page.waitForFunction(
    ({ channels, state }) =>
      channels.every(
        (channel) =>
          document.querySelector(`[data-testid="status-${channel}"]`)?.dataset.state === state,
      ),
    { channels, state },
    { timeout: 15_000 },
  );

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="status-server"]');
await waitForDots(["server"], "active");

const brand = (await page.locator("h1.brand").textContent())?.trim();
const serverDot = (await page.getByTestId("status-server").textContent())?.trim();
const health = await page.evaluate(() => fetch("/api/health").then((r) => r.json()));
const options = await page.locator('[data-testid="source-select"] option').evaluateAll((nodes) =>
  nodes.map((node) => ({ value: node.value, label: node.textContent, disabled: node.disabled })),
);
const idleDots = await dots();

// Start the brainstorm replay and watch the dots come up.
await page.selectOption('[data-testid="source-select"]', "events:brainstorm");
await page.getByTestId("start-session").click();
await waitForDots(["transcription", "model"], "active");
// Turns reach the browser over /ws/events; the first one lands about a
// second into the capture.
await page.waitForFunction(
  () => /— [1-9]\d* turns so far/.test(document.querySelector('[data-testid="session-state"]')?.textContent ?? ""),
  undefined,
  { timeout: 20_000 },
);
const runningDots = await dots();
const runningState = (await page.getByTestId("session-state").textContent())?.trim();
await page.screenshot({ path: shot });

// Stop, and watch them go back down.
await page.getByTestId("stop-session").click();
await waitForDots(["transcription", "model"], "idle");
const stoppedDots = await dots();
const stoppedState = (await page.getByTestId("session-state").textContent())?.trim();
await page.screenshot({ path: idleShot });

await browser.close();

const report = {
  brand,
  serverDot,
  health,
  options,
  idleDots,
  runningDots,
  runningState,
  stoppedDots,
  stoppedState,
  consoleErrors,
};
console.log(JSON.stringify(report, null, 2));

const problems = [];
if (brand !== "Sotto") problems.push(`brand is ${JSON.stringify(brand)}`);
if (serverDot !== "server: connected") problems.push(`server dot reads ${JSON.stringify(serverDot)}`);
if (health?.ok !== true) problems.push(`/api/health returned ${JSON.stringify(health)}`);
if (!options.some((o) => o.value === "wav:brainstorm")) problems.push("no WAV fixture option");
if (!options.some((o) => o.label?.includes("Replay events: brainstorm"))) {
  problems.push("no events replay option");
}
if (!options.some((o) => o.value === "mic" && o.disabled)) {
  problems.push("microphone option is missing or not disabled");
}
if (idleDots.transcription !== "idle" || idleDots.model !== "idle") {
  problems.push(`dots were not idle before Start: ${JSON.stringify(idleDots)}`);
}
if (runningDots.transcription !== "active" || runningDots.model !== "active") {
  problems.push(`dots did not go active: ${JSON.stringify(runningDots)}`);
}
if (!runningState?.startsWith("Listening to Replay events: brainstorm")) {
  problems.push(`running state reads ${JSON.stringify(runningState)}`);
}
if (consoleErrors.length > 0) problems.push(`console errors: ${consoleErrors.join("; ")}`);
if (problems.length > 0) throw new Error(problems.join("\n"));

console.log(`\nOK — screenshots at ${shot} and ${idleShot}`);
