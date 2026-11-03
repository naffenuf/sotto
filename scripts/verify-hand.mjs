/**
 * Browser check for the raised hand (PRD V3-017), which is the stage's
 * Holding zone: the cards Sotto has not said, one line each, between what it
 * is doing now and what it has already said.
 *
 * Two pages, because the two halves need different things:
 *
 *  1. `/dev/cards`, where three of the stage's cards are held and two more
 *     have aged into the tray. That is the one place the count, the tooltip
 *     and the "opened" rule all exist at once, and no conversation produces
 *     them on demand.
 *  2. A mocked `/ws/events`, which is the only way to see the server take a
 *     hand down: a card published again without `raised` is what happens when
 *     Sotto says it out loud, or when the room calls on it — it leaves
 *     Holding for Said.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-hand.mjs /tmp/shot.png
 *
 * Writes the dev page to the path given as the first argument and the mocked
 * app to `<name>-mock.png`.
 */
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/hand.png";
const mockShot = shot.replace(/\.png$/, "-mock.png");

/** What Holding says it is holding, and where it sits on the stage. */
async function readHand(page) {
  return page.evaluate(() => {
    const hand = document.querySelector('[data-testid="raised-hand"]');
    if (hand === null) return null;
    const now = document.querySelector('[data-testid="zone-now"]');
    const said = document.querySelector('[data-testid="zone-said"]');
    const box = hand.getBoundingClientRect();
    return {
      count: Number(hand.dataset.count),
      text: (hand.querySelector('[data-testid="raised-hand-count"]')?.textContent ?? "").trim(),
      title: hand.getAttribute("title") ?? "",
      rows: hand.querySelectorAll('[data-testid="held-card"]').length,
      // Between Now and Said, on the stage.
      belowNow: now === null ? false : box.top >= now.getBoundingClientRect().bottom - 1,
      aboveSaid: said === null ? true : box.bottom <= said.getBoundingClientRect().top + 1,
      onStage: hand.closest('[data-testid="stage"]') !== null,
    };
  });
}

const browser = await chromium.launch({ headless: true });

/* ---- 1. the dev page: the count, and what opening a card does ---- */
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

// Nothing about a raised hand may make a sound or open a modal (US-011).
const noise = [];
await page.addInitScript(() => {
  window.__noise = [];
  const note = (what) => window.__noise.push(what);
  const audio = window.Audio;
  window.Audio = function (...args) { note("new Audio"); return new audio(...args); };
  const context = window.AudioContext;
  if (context !== undefined) {
    window.AudioContext = function (...args) { note("new AudioContext"); return new context(...args); };
  }
  HTMLMediaElement.prototype.play = function () { note("play"); return Promise.resolve(); };
  HTMLDialogElement.prototype.showModal = function () { note("showModal"); };
  window.alert = () => note("alert");
});

await page.goto(`${url}/dev/cards`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="raised-hand"]');
const onLoad = await readHand(page);
await page.screenshot({ path: shot, fullPage: false });

// Opening one of the held lines takes it out of Holding: the reader has
// heard what Sotto had, and the card is read in full in Said, open.
const glow = page.locator('[data-testid="held-card"][data-variant="glow"]').first();
await glow.click();
await page.waitForTimeout(200);
const afterOpen = await readHand(page);
const openedInSaid = await page.evaluate(
  () =>
    document.querySelector('[data-testid="stage-cards"] [data-testid="card"][data-variant="glow"]')
      ?.dataset.expanded,
);

// And "seen" clears the rest, which is the only way to clear a card that
// would be shown in full and so can never be "opened".
await page.locator('[data-testid="raised-hand-clear"]').click();
await page.waitForTimeout(200);
const afterClick = await readHand(page);
noise.push(...(await page.evaluate(() => window.__noise)));

/* ---- 2. a mocked /ws/events: the server taking the hand down ---- */
const held = {
  id: "card-cand-1",
  variant: "interject",
  state: "ready",
  createdAtMs: 4_000,
  headline: "Before six sheds: what if only one association signs up?",
  whyNow: "the number is about to be written down",
  detailMd: "Six sheds at £240 each is £1,440, against the £1,400 ceiling you set.",
  raised: true,
};
const packet = {
  id: "research-packet-1",
  variant: "research",
  state: "ready",
  createdAtMs: 9_000,
  headline: "Research ready: a shed costs £180–£320 delivered",
  teaser: "Three suppliers publish delivered prices, and two charge extra for a base.",
  detailMd: "- Tiger is £199 delivered\n- Waltons is £229 with a base",
  raised: true,
};

const mockPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
mockPage.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
mockPage.on("pageerror", (e) => consoleErrors.push(String(e)));
// React's StrictMode means several sockets in dev; keep the live ones.
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
  session: { id: "mock-1", source: { kind: "events", fixture: "decision-closings" }, startedAtMs: 0 },
});
push({ type: "status", status: { channel: "transcription", state: "active" } });
const noHand = await readHand(mockPage);
push({ type: "card", card: held });
push({ type: "card", card: packet });
await mockPage.waitForFunction(
  () => document.querySelector('[data-testid="raised-hand"]')?.dataset.count === "2",
  undefined,
  { timeout: 10_000 },
);
const twoHeld = await readHand(mockPage);
await mockPage.screenshot({ path: mockShot, fullPage: false });

// Sotto said the research one out loud (V3-004), so the server republishes it
// without the flag — and the card stays on the stage either way.
push({ type: "card", card: { ...packet, raised: false } });
await mockPage.waitForFunction(
  () => document.querySelector('[data-testid="raised-hand"]')?.dataset.count === "1",
  undefined,
  { timeout: 10_000 },
);
const afterSpoken = await readHand(mockPage);
// The research card has moved from Holding to Said; the held one is still a line in Holding.
const stillShown =
  (await mockPage.locator('[data-testid="card"]').count()) +
  (await mockPage.locator('[data-testid="held-card"]').count());

// And the room called on the last one, so the hand goes away entirely.
push({ type: "card", card: { ...held, raised: false } });
await mockPage.waitForFunction(
  () => document.querySelector('[data-testid="raised-hand"]') === null,
  undefined,
  { timeout: 10_000 },
);
const cleared = await readHand(mockPage);

await browser.close();

const checks = [
  ["Holding sits on the stage between Now and Said", twoHeld?.onStage === true && twoHeld?.belowNow === true && twoHeld?.aboveSaid === true],
  ["it holds the three cards Sotto is holding, one line each", onLoad?.count === 3 && onLoad?.rows === 3],
  ["the count is on screen as a number", onLoad?.text === "3"],
  ["the tooltip says how to hear it", /Sotto, go ahead/.test(onLoad?.title ?? "")],
  ["two glows in the tray are not counted", onLoad?.count === 3],
  ["opening a held card stops it counting", afterOpen?.count === 2],
  ["and it is read in full in Said", openedInSaid === "true"],
  ["\"seen\" clears the rest", afterClick === null],
  ["no sound and no modal", noise.length === 0],
  ["no hand before any card arrives", noHand === null],
  ["a mocked pair of raised cards puts it up", twoHeld?.count === 2],
  ["a card republished without the flag lowers it", afterSpoken?.count === 1],
  ["the card itself stays on the stage", stillShown === 2],
  ["the hand goes away when nothing is held", cleared === null],
  ["no console errors", consoleErrors.length === 0],
];

console.log(`[hand] on load: ${JSON.stringify(onLoad)}`);
console.log(`[hand] after opening a card: ${JSON.stringify(afterOpen)}`);
console.log(`[hand] mocked: 2 -> ${afterSpoken?.count} -> ${cleared === null ? "none" : "?"}`);
console.log(`[hand] noise: ${noise.length === 0 ? "none" : noise.join(", ")}`);
if (consoleErrors.length > 0) console.log(`[hand] console: ${consoleErrors.join(" | ")}`);
for (const [what, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
console.log(`[hand] screenshots: ${shot}, ${mockShot}`);

if (checks.some(([, ok]) => !ok)) process.exit(1);
