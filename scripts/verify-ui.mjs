/**
 * Browser check for the Sotto UI: the header's source selector and dots, a
 * brainstorm events replay started and stopped (US-009), and the transcript
 * panel it fills — first text, partial and final rows, naming a speaker, and
 * jump-to-live (US-007).
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
const scrolledShot = shot.replace(/\.png$/, "-scrolled.png");

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

const emptyTranscript = (await page.getByTestId("transcript-empty").textContent())?.trim();

// Start the brainstorm replay and watch the dots come up.
await page.selectOption('[data-testid="source-select"]', "events:brainstorm");
const startedAt = Date.now();
await page.getByTestId("start-session").click();
await waitForDots(["transcription", "model"], "active");

// The first words have to be on screen within 3 s of the first spoken one,
// which in this capture is the moment the replay starts.
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('[data-testid="turn"] .turn__text')].some(
      (node) => (node.textContent ?? "").trim() !== "",
    ),
  undefined,
  { timeout: 10_000 },
);
const firstTextMs = Date.now() - startedAt;

// A turn shows up as a gray italic partial before it goes final, so both
// states should be visible while the replay runs.
const sawPartial = await page
  .waitForSelector('[data-testid="turn"][data-final="false"]', { timeout: 15_000 })
  .then(() => true)
  .catch(() => false);
await page.waitForSelector('[data-testid="turn"][data-final="true"]', { timeout: 15_000 });

// Wait for a second speaker, so the colours can be compared.
await page.waitForFunction(
  () =>
    new Set(
      [...document.querySelectorAll('[data-testid="turn"]')]
        .map((node) => node.dataset.speaker)
        .filter((label) => label !== ""),
    ).size >= 2,
  undefined,
  { timeout: 30_000 },
);

/** The chip colour and text of the first row of each speaker label. */
const chipsBySpeaker = () =>
  page.evaluate(() => {
    const seen = {};
    for (const row of document.querySelectorAll('[data-testid="turn"]')) {
      const label = row.dataset.speaker;
      const chip = row.querySelector('[data-testid="speaker-chip"]');
      if (label === "" || chip === null) continue;
      const colour = getComputedStyle(chip).backgroundColor;
      seen[label] ??= { colours: new Set(), texts: new Set() };
      seen[label].colours.add(colour);
      seen[label].texts.add(chip.textContent.trim());
    }
    return Object.fromEntries(
      Object.entries(seen).map(([label, { colours, texts }]) => [
        label,
        { colours: [...colours], texts: [...texts] },
      ]),
    );
  });

const chips = await chipsBySpeaker();

// Name speaker A, which every row of A's should pick up.
await page.locator('[data-testid="turn"][data-speaker="A"] [data-testid="speaker-chip"]').first().click();
await page.getByTestId("speaker-name-input").fill("Craig");
await page.getByTestId("speaker-name-save").click();
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('[data-testid="turn"][data-speaker="A"] [data-testid="speaker-chip"]')]
      .every((chip) => chip.textContent.trim() === "Craig"),
  undefined,
  { timeout: 5_000 },
);
const namedChips = await chipsBySpeaker();

// Scrolling up stops the panel following the conversation and offers a way
// back — which needs more conversation than fits the panel first, so this
// waits for the list to overflow (about a minute into the capture).
await page.waitForFunction(
  () => {
    const list = document.querySelector('.transcript__list');
    return list !== null && list.scrollHeight > list.clientHeight + 48;
  },
  undefined,
  { timeout: 120_000 },
);
await page.locator('.transcript__list').evaluate((node) => {
  node.scrollTop = 0;
});
await page.waitForSelector('[data-testid="jump-to-live"]', { timeout: 5_000 });
const jumpAppeared = true;
await page.screenshot({ path: scrolledShot });
await page.getByTestId("jump-to-live").click();
await page.waitForSelector('[data-testid="jump-to-live"]', { state: "detached", timeout: 5_000 });
const atLive = await page.locator('.transcript__list').evaluate((node) => {
  return node.scrollHeight - node.scrollTop - node.clientHeight;
});

const runningDots = await dots();
const runningState = (await page.getByTestId("session-state").textContent())?.trim();
const turnRows = await page.locator('[data-testid="turn"]').count();
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
  emptyTranscript,
  firstTextMs,
  sawPartial,
  turnRows,
  chips,
  namedChips,
  jumpAppeared,
  atLive,
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
if (!options.some((o) => o.value === "mic" && !o.disabled)) {
  problems.push("microphone option is missing or disabled");
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
if (firstTextMs > 3_000) problems.push(`first text took ${firstTextMs} ms, over the 3 s budget`);
if (!sawPartial) problems.push("no partial turn was ever on screen");
if (turnRows < 2) problems.push(`only ${turnRows} transcript rows`);
for (const [label, { colours, texts }] of Object.entries(chips)) {
  if (colours.length !== 1) problems.push(`speaker ${label} had colours ${colours.join(", ")}`);
  if (texts.length !== 1) problems.push(`speaker ${label} had chips ${texts.join(", ")}`);
}
const palette = Object.values(chips).map(({ colours }) => colours[0]);
if (new Set(palette).size !== palette.length) {
  problems.push(`two speakers share a colour: ${palette.join(", ")}`);
}
if (namedChips.A?.texts?.[0] !== "Craig") {
  problems.push(`renaming A left chips ${JSON.stringify(namedChips.A?.texts)}`);
}
if (namedChips.B?.texts?.[0] === "Craig") problems.push("renaming A also renamed B");
if (atLive > 48) problems.push(`jump to live left ${atLive}px of scroll below`);
if (consoleErrors.length > 0) problems.push(`console errors: ${consoleErrors.join("; ")}`);
if (problems.length > 0) throw new Error(problems.join("\n"));

console.log(`\nOK — screenshots at ${shot}, ${scrolledShot} and ${idleShot}`);
