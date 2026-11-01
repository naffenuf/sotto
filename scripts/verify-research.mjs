/**
 * Browser check for research-ready cards (V2-014).
 *
 * A real `research-business-idea` events replay against the real model, which
 * is the only honest way to see one: the card exists because the observer
 * noticed a hook, the gate approved it and a grounded search came back with
 * sources. The check waits for the first card, reads it closed, clicks it and
 * reads it open, then stops the session.
 *
 * It also reads the session folder's `research.jsonl` back, because the half
 * of the criterion the DOM cannot show is *when* the card went out: the `card`
 * line records how long the packet waited for a pause.
 *
 * One thing a replay will not reliably produce is a packet whose search drew a
 * visual — none of the three in the V2-013 measurement did — so the opened
 * card *with* a frame in it is checked on `/dev/cards`, where it exists on
 * demand, before the replay starts.
 *
 * The session is started through `POST /api/session/start` — the header's
 * Start button is the microphone now — and the replay runs at 1x, so the whole
 * thing takes several minutes of wall clock and a few searches' worth of model
 * calls.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-research.mjs /tmp/shot.png
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shotPrefix = (process.argv[2] ?? "/tmp/sotto-shots/research.png").replace(/\.png$/, "");
const FIXTURE = "research-business-idea";
/** The searches have to be gated, started and answered first. */
const CARD_TIMEOUT_MS = 8 * 60_000;
const SESSIONS = new URL("../sessions/", import.meta.url).pathname;

const problems = [];
const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // ---- /dev/cards: the open card, visual and all ------------------------
  await page.goto(`${base}/dev/cards`, { waitUntil: "networkidle" });
  const sample = page.locator('[data-case="r-open"] [data-testid="card"]');
  await sample.waitFor({ timeout: 15_000 });
  await sample.locator('[data-testid="card-artifact-frame"]').waitFor({ timeout: 15_000 });
  const dev = await sample.evaluate((element) => ({
    expanded: element.getAttribute("data-expanded"),
    keyPoints: element.querySelectorAll('[data-testid="card-details"] li').length,
    sources: element.querySelectorAll('[data-testid="card-source"]').length,
    visuals: element.querySelectorAll('[data-testid="card-artifact-frame"]').length,
  }));
  await page.locator('[data-case="r-open"]').screenshot({ path: `${shotPrefix}-dev.png` });
  if (dev.visuals !== 1) problems.push("the sample research card shows no visual");
  if (dev.keyPoints === 0) problems.push("the sample research card shows no key points");
  if (dev.sources === 0) problems.push("the sample research card shows no sources");

  // ---- the real thing ---------------------------------------------------
  await page.goto(base, { waitUntil: "networkidle" });

  const started = await page.evaluate(async (fixture) => {
    const response = await fetch("/api/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { kind: "events", fixture } }),
    });
    return { status: response.status, body: await response.json() };
  }, FIXTURE);
  if (started.status !== 200) throw new Error(`could not start: ${JSON.stringify(started)}`);
  const sessionId = started.body.session.id;
  console.log(`replaying ${FIXTURE} as ${sessionId}; waiting for a research card…`);

  // ---- closed: one quiet line ------------------------------------------
  const card = page.locator('[data-testid="card"][data-variant="research"]').first();
  await card.waitFor({ timeout: CARD_TIMEOUT_MS });
  const closed = await card.evaluate((element) => ({
    expanded: element.getAttribute("data-expanded"),
    headline: element.querySelector('[data-testid="card-headline"]')?.textContent?.trim() ?? "",
    teaser: element.querySelector('[data-testid="card-teaser"]')?.textContent?.trim() ?? "",
    feedback: element.querySelectorAll('[data-testid="card-feedback"]').length,
    sources: element.querySelectorAll('[data-testid="card-source"]').length,
    height: Math.round(element.getBoundingClientRect().height),
  }));
  await page.screenshot({ path: `${shotPrefix}-closed.png` });
  if (closed.expanded !== "false") problems.push("the research card did not arrive closed");
  if (!closed.headline.startsWith("Research ready:")) {
    problems.push(`the card does not read "Research ready: …": ${closed.headline}`);
  }
  if (closed.teaser === "") problems.push("the closed card shows no teaser");
  if (closed.feedback !== 0) problems.push("the research card offers feedback buttons");
  if (closed.sources !== 0) problems.push("the closed card already lists its sources");
  if (closed.height > 140) problems.push(`the closed card is ${closed.height} px tall, not compact`);

  // ---- open: key points, sources, and the visual if there is one ---------
  await card.click();
  // By its open state, not its position: a second packet landing meanwhile
  // would otherwise take over `.first()`.
  const open = page
    .locator('[data-testid="card"][data-variant="research"][data-expanded="true"]')
    .first();
  await open.locator('[data-testid="card-details"]').waitFor({ timeout: 10_000 });
  const opened = await open.evaluate((element) => ({
    expanded: element.getAttribute("data-expanded"),
    headline: element.querySelector('[data-testid="card-headline"]')?.textContent?.trim() ?? "",
    teaser: element.querySelector('[data-testid="card-teaser"]')?.textContent?.trim() ?? "",
    keyPoints: element.querySelectorAll('[data-testid="card-details"] li').length,
    sources: [...element.querySelectorAll('[data-testid="card-source"] a')].map((a) => a.href),
    visuals: element.querySelectorAll('[data-testid="card-artifact-frame"]').length,
    toggles: element.querySelectorAll('[data-testid="card-details-toggle"]').length,
    feedback: element.querySelectorAll('[data-testid="card-feedback"]').length,
  }));
  await page.screenshot({ path: `${shotPrefix}-open.png`, fullPage: true });
  if (opened.expanded !== "true") problems.push("clicking the card did not open it");
  if (opened.keyPoints === 0) problems.push("the open card shows no key points");
  if (opened.toggles !== 0) problems.push("the key points are behind a second toggle");
  if (opened.sources.length === 0) problems.push("the open card lists no sources");
  if (opened.feedback !== 0) problems.push("the opened research card offers feedback buttons");

  await page.evaluate(() => fetch("/api/session/stop", { method: "POST" }));
  await page.waitForFunction(
    () => document.querySelector('[data-testid="start-session"]')?.disabled === false,
    undefined,
    { timeout: 120_000 },
  );

  // ---- the record: it went out in a pause, after waiting for one ---------
  const folder = readdirSync(SESSIONS)
    .filter((name) => name.endsWith(`events-${FIXTURE}`))
    .sort()
    .at(-1);
  const log =
    folder === undefined
      ? []
      : readFileSync(join(SESSIONS, folder, "research.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line));
  const cardLines = log.filter((line) => line.kind === "card");
  const packets = log.filter((line) => line.kind === "packet" && line.outcome === "ready");
  if (cardLines.length === 0) problems.push("research.jsonl records no card");
  if (cardLines.length > packets.length) {
    problems.push(`${cardLines.length} card(s) for ${packets.length} packet(s)`);
  }

  if (errors.length > 0) problems.push(`page errors: ${errors.join(" | ")}`);
  console.log(
    JSON.stringify(
      {
        sessionId,
        folder,
        dev,
        closed,
        opened,
        packets: packets.length,
        cards: cardLines.map((line) => ({
          packetId: line.packetId,
          atMs: line.atMs,
          heldForMs: line.heldForMs,
          atSessionEnd: line.atSessionEnd ?? false,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.error(`\nFAIL\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("\nPASS: research arrives as a compact card and opens into points, sources and visual.");
