/**
 * Browser check for the "Sotto is listening…" indicator (US-017).
 *
 * The indicator is up for exactly as long as the partial turn that said
 * Sotto's name — a second or two of a real replay, which is not something to
 * race a browser against — so `/ws/events` is mocked and the two `wake`
 * events the server would send are sent by hand. What the real pipeline makes
 * of the real captures is covered by `server/wake.integration.test.ts`.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-wake.mjs /tmp/shot.png
 *
 * Writes the listening state to the path given as the first argument.
 */
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/wake.png";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

// React's StrictMode mounts the socket twice in dev, and the first one's
// `close` schedules a reconnect after the second has mounted. Collect them
// all, drop them as they close, and send to whatever is left.
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
  session: { id: "mock-1", source: { kind: "events", fixture: "ask-search" }, startedAtMs: 0 },
});
push({ type: "status", status: { channel: "transcription", state: "active" } });

const indicator = page.locator('[data-testid="wake-listening"]');
if ((await indicator.count()) !== 0) {
  throw new Error("the indicator is up before anybody has said Sotto's name");
}

// The partial that first matches: "Sotto what do…" is still being said.
push({ type: "wake", listening: true });
await indicator.waitFor({ state: "visible", timeout: 5_000 });

const shown = await page.evaluate(() => {
  const node = document.querySelector('[data-testid="wake-listening"]');
  const box = node.getBoundingClientRect();
  const stage = document.querySelector('[data-testid="stage"]').getBoundingClientRect();
  return {
    text: node.textContent.trim(),
    role: node.getAttribute("role"),
    dots: node.querySelectorAll('[aria-hidden="true"] > *').length,
    insideStage:
      box.top >= stage.top && box.bottom <= stage.bottom && box.left >= stage.left,
    // No sound, no modal: the same promise the rest of the stage makes.
    dialogs: document.querySelectorAll("dialog[open]").length,
  };
});
await page.screenshot({ path: shot, fullPage: false });

if (shown.text !== "Sotto is listening") {
  throw new Error(`the indicator reads ${JSON.stringify(shown.text)}`);
}
if (shown.role !== "status") throw new Error(`the indicator has role ${shown.role}`);
if (shown.dots !== 3) throw new Error(`expected three breathing dots, saw ${shown.dots}`);
if (!shown.insideStage) throw new Error("the indicator is not on the stage");
if (shown.dialogs !== 0) throw new Error("a dialog opened");

// The turn goes final: the question has been asked, so the indicator drops.
push({ type: "wake", listening: false });
await indicator.waitFor({ state: "detached", timeout: 5_000 });

// And a session ending takes it down even if the turn never closed.
push({ type: "wake", listening: true });
await indicator.waitFor({ state: "visible", timeout: 5_000 });
push({ type: "session", session: null });
await indicator.waitFor({ state: "detached", timeout: 5_000 });

await browser.close();

if (consoleErrors.length > 0) {
  throw new Error(`console errors:\n${consoleErrors.join("\n")}`);
}

console.log(`wake indicator: ${JSON.stringify(shown)}`);
console.log(`screenshot: ${shot}`);
