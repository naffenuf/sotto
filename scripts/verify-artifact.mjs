/**
 * Browser check for HTML artifacts on the stage (US-020).
 *
 * `ask-diagram` is the capture where somebody asks Sotto out loud to sketch
 * the user flow they just described, so replaying it at 1x drives the real
 * path: wake phrase, answer agent, `show_html`, a file in the session folder,
 * a frame on the card. What is worth proving in a browser rather than in a
 * test is the sandbox — that the frame really is `allow-scripts` with no
 * `allow-same-origin`, that the document is served with the restrictive CSP,
 * that it rendered something, and that "open full screen" does.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-artifact.mjs /tmp/shot.png
 *
 * Writes the card to the path given as the first argument, and the frame full
 * screen to `<name>-fullscreen.png`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/artifact.png";
const fullShot = shot.replace(/\.png$/, "-fullscreen.png");
const sessionsDir = fileURLToPath(new URL("../sessions/", import.meta.url));

/** The spoken question is 31 s into the capture, and the answer draws first. */
const ANSWER_TIMEOUT_MS = 240_000;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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

await page.goto(url, { waitUntil: "networkidle" });
await waitForDot("server", "active");

await page.getByTestId("source-select").selectOption("events:ask-diagram");
await page.getByTestId("start-session").click();
await waitForDot("transcription", "active");

// The spoken question lands ~31 s in; then the model reasons, draws and writes.
await page.waitForSelector('[data-testid="card-artifact"]', { timeout: ANSWER_TIMEOUT_MS });
await page.waitForFunction(
  () =>
    document.querySelector('[data-testid="card"][data-variant="answer"]')?.dataset.state ===
    "ready",
  undefined,
  { timeout: ANSWER_TIMEOUT_MS },
);

const card = await page.evaluate(() => {
  const node = document.querySelector('[data-testid="card"][data-variant="answer"]');
  const frame = node?.querySelector('[data-testid="card-artifact-frame"]');
  return {
    state: node?.dataset.state,
    headline: node?.querySelector(".card__headline")?.textContent?.trim() ?? "",
    asker: node?.querySelector('[data-testid="card-asker"]')?.textContent?.trim() ?? "",
    artifacts: node?.querySelectorAll('[data-testid="card-artifact"]').length ?? 0,
    title: node?.querySelector('[data-testid="card-artifact-title"]')?.textContent?.trim() ?? "",
    sandbox: frame?.getAttribute("sandbox"),
    src: frame?.getAttribute("src"),
    // Rendered at a size somebody can read, not collapsed to nothing.
    box: frame === undefined || frame === null ? null : frame.getBoundingClientRect().height,
    fullScreenButton: (node?.querySelectorAll('[data-testid="card-artifact-fullscreen"]').length ?? 0) > 0,
  };
});

// The headers are half the sandbox, so they are read off the real response.
const served = await page.request.get(new URL(card.src, url).href);
const headers = served.headers();
const body = await served.text();

// The document rendered: ask the frame itself, which Playwright can reach
// even though the page cannot.
const inside = await page
  .frameLocator('[data-testid="card-artifact-frame"]')
  .locator("body")
  .evaluate((node) => ({
    children: node.children.length,
    height: node.scrollHeight,
    text: node.innerText.replace(/\s+/g, " ").trim().slice(0, 120),
  }))
  .catch((error) => ({ error: String(error) }));

await page.screenshot({ path: shot });

// "Open full screen" is a real button on a real gesture.
await page.getByTestId("card-artifact-fullscreen").click();
const fullScreened = await page
  .waitForFunction(
    () =>
      document.fullscreenElement?.getAttribute("data-testid") === "card-artifact",
    undefined,
    { timeout: 5_000 },
  )
  .then(() => true)
  .catch(() => false);
await page.screenshot({ path: fullShot });
if (fullScreened) await page.getByTestId("card-artifact-fullscreen").click();

if (await page.getByTestId("stop-session").isEnabled()) {
  await page.getByTestId("stop-session").click();
}

const folder = newestSession("events-ask-diagram");
const logged = readLog(folder, "answers.jsonl");
const files = (() => {
  try {
    return readdirSync(join(sessionsDir, folder, "artifacts"));
  } catch {
    return [];
  }
})();
const problem = (await page.getByTestId("session-problem").count())
  ? (await page.getByTestId("session-problem").textContent())?.trim()
  : null;

console.log(
  JSON.stringify(
    {
      card,
      status: served.status(),
      contentType: headers["content-type"],
      csp: headers["content-security-policy"],
      nosniff: headers["x-content-type-options"],
      bytes: body.length,
      inside,
      fullScreened,
      folder,
      files,
      logged: logged.map((one) => ({
        id: one.id,
        status: one.status,
        askedBy: one.askedBy,
        headline: one.headline,
        artifacts: one.artifacts,
      })),
      problem,
      consoleErrors,
    },
    null,
    2,
  ),
);

const failures = [];
if (card.artifacts !== 1) failures.push(`the card has ${card.artifacts} artifacts, expected 1`);
if (card.state !== "ready") failures.push(`the answer card is ${card.state}`);
if ((card.headline ?? "") === "") failures.push("the answer has no headline beside the diagram");
if ((card.title ?? "") === "") failures.push("the frame has no title");
// The one thing that must not drift: scripts yes, same origin never.
if (card.sandbox !== "allow-scripts") failures.push(`the frame's sandbox is ${JSON.stringify(card.sandbox)}`);
if (!card.fullScreenButton) failures.push("there is no 'open full screen' button");
if ((card.box ?? 0) < 120) failures.push(`the frame is ${card.box} px tall`);

if (served.status() !== 200) failures.push(`the artifact URL answered ${served.status()}`);
if (headers["content-security-policy"] !== CSP)
  failures.push(`the CSP is ${JSON.stringify(headers["content-security-policy"])}`);
if (!(headers["content-type"] ?? "").startsWith("text/html"))
  failures.push(`the artifact is served as ${headers["content-type"]}`);
if (headers["x-content-type-options"] !== "nosniff") failures.push("no nosniff header");
if (!body.includes("<svg") && !body.includes("<div"))
  failures.push("the document contains neither <svg nor <div");

if (inside.error !== undefined) failures.push(`could not read the frame: ${inside.error}`);
if ((inside.children ?? 0) === 0) failures.push("the frame rendered an empty document");
if (!fullScreened) failures.push("'open full screen' did not put the frame full screen");

if (logged.length !== 1) failures.push(`answers.jsonl has ${logged.length} lines, expected 1`);
if ((logged[0]?.artifacts ?? []).length !== 1)
  failures.push(`the record names ${(logged[0]?.artifacts ?? []).length} artifacts`);
if (files.length !== 1) failures.push(`artifacts/ holds ${files.length} files: ${files.join(", ")}`);
if (problem !== null) failures.push(`the page showed a problem: ${problem}`);
if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.join(" | ")}`);

await browser.close();

if (failures.length > 0) {
  console.error(`\nFAIL\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nOK — artifact verified; screenshots at ${shot} and ${fullShot}`);
