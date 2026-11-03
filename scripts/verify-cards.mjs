/**
 * Browser check for the stage and the card component (US-011).
 *
 * Two pages: `/dev/cards`, which shows every variant and state with sample
 * data, and `/`, where the layout split and the header are measured. The dev
 * page is the only place an error card, a thinking card and a two-minute-old
 * glow all exist at once, which is why the check drives it rather than a
 * replay.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-cards.mjs /tmp/shot.png
 *
 * Writes the dev page to the path given as the first argument, the opened
 * states and the tray alongside it as `<name>-open.png` and `<name>-tray.png`,
 * and the app's layout as `<name>-layout.png`.
 */
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/cards.png";
const openShot = shot.replace(/\.png$/, "-open.png");
const trayShot = shot.replace(/\.png$/, "-tray.png");
const layoutShot = shot.replace(/\.png$/, "-layout.png");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(`${url}/dev/cards`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="dev-case"]');

/** Every sample card: its variant, state, and what is on it. */
const cases = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="dev-case"]')].map((box) => {
    const card = box.querySelector('[data-testid="card"]');
    const headline = card.querySelector('[data-testid="card-headline"]');
    const pick = (name) => card.querySelector(`[data-testid="${name}"]`);
    return {
      id: box.dataset.case,
      variant: card.dataset.variant,
      state: card.dataset.state,
      expanded: card.dataset.expanded ?? null,
      tag: card.tagName.toLowerCase(),
      headline: (headline?.textContent ?? "").trim(),
      headlinePx: headline === null ? 0 : parseFloat(getComputedStyle(headline).fontSize),
      borderLeft: getComputedStyle(card).borderLeftWidth,
      thinking: pick("card-thinking") !== null,
      error: (pick("card-error")?.textContent ?? "").trim(),
      question: (pick("card-question")?.textContent ?? "").trim(),
      asker: (pick("card-asker")?.textContent ?? "").trim(),
      label: pick("card-kind")?.textContent?.trim() ?? "",
      why: (pick("card-why")?.textContent ?? "").trim(),
      quotes: [...card.querySelectorAll('[data-testid="card-quote"]')].map((q) =>
        q.textContent.trim(),
      ),
      sources: [...card.querySelectorAll('[data-testid="card-source"]')].map((s) => ({
        text: s.textContent.trim(),
        href: s.querySelector("a")?.getAttribute("href") ?? "",
      })),
      detailsToggle: (pick("card-details-toggle")?.textContent ?? "").trim(),
      detailsOpen: pick("card-details") !== null,
      lineCount: Math.round(card.getBoundingClientRect().height),
    };
  }),
);

/** The dots in a thinking indicator are animated, not static. */
const thinkingAnimation = await page
  .locator('[data-testid="card-thinking"] .card__dot')
  .first()
  .evaluate((node) => {
    const style = getComputedStyle(node);
    return { name: style.animationName, duration: style.animationDuration };
  });

const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

// The stage sample: three cards on it, two glows already in the tray.
const stageIds = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="stage-cards"] [data-testid="card"]')].map(
    (card) => card.querySelector('[data-testid="card-headline"]').textContent.trim(),
  ),
);
const trayToggle = (await page.getByTestId("stage-tray-toggle").textContent())?.trim();
const trayOpenBefore = await page.getByTestId("stage-tray-cards").count();
await page.screenshot({ path: shot, fullPage: true });

// Open the tray: the quiet thoughts are still there, still one line each.
await page.getByTestId("stage-tray-toggle").click();
await page.waitForSelector('[data-testid="stage-tray-cards"]');
const trayed = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="stage-tray-cards"] [data-testid="card"]')].map(
    (card) => ({
      variant: card.dataset.variant,
      expanded: card.dataset.expanded ?? "false",
      headline: card.querySelector('[data-testid="card-headline"]').textContent.trim(),
    }),
  ),
);
await page.screenshot({ path: trayShot, fullPage: true });

// A glow opens into the full card, with the why-now line and the evidence
// that a collapsed one only hints at — and closes again.
const glow = page.locator('[data-testid="dev-case"][data-case="g-ready"] [data-testid="card"]');
const collapsedHeight = await glow.evaluate((node) =>
  Math.round(node.getBoundingClientRect().height),
);
await glow.click();
await page.waitForSelector(
  '[data-testid="dev-case"][data-case="g-ready"] [data-testid="card-why"]',
);
const openedGlow = await page
  .locator('[data-testid="dev-case"][data-case="g-ready"] [data-testid="card"]')
  .evaluate((node) => ({
    tag: node.tagName.toLowerCase(),
    expanded: node.dataset.expanded,
    borderLeft: getComputedStyle(node).borderLeftWidth,
    headlinePx: parseFloat(
      getComputedStyle(node.querySelector('[data-testid="card-headline"]')).fontSize,
    ),
    quotes: node.querySelectorAll('[data-testid="card-quote"]').length,
    height: Math.round(node.getBoundingClientRect().height),
    collapse: node.querySelector('[data-testid="card-kind"]')?.textContent.trim() ?? "",
  }));

// "details ▾" on the answer card opens the markdown: a paragraph, a list, a
// bold run, inline code and a link.
const answer = page.locator('[data-testid="dev-case"][data-case="a-ready"]');
await answer.getByTestId("card-details-toggle").click();
await page.waitForSelector(
  '[data-testid="dev-case"][data-case="a-ready"] [data-testid="card-details"]',
);
const details = await answer.getByTestId("card-details").evaluate((node) => ({
  paragraphs: node.querySelectorAll(".md__p").length,
  bullets: node.querySelectorAll(".md__ul li").length,
  strong: [...node.querySelectorAll("strong")].map((one) => one.textContent),
  em: [...node.querySelectorAll("em")].map((one) => one.textContent),
  code: [...node.querySelectorAll("code")].map((one) => one.textContent),
  links: [...node.querySelectorAll("a")].map((one) => one.getAttribute("href")),
  html: node.innerHTML.includes("<script"),
}));
const detailsToggleAfter = (await answer.getByTestId("card-details-toggle").textContent())?.trim();

// "transcript of answer ▾" opens what Sotto said out loud (V2-005): plain
// speech, with none of the markdown or links the detail carries.
await answer.getByTestId("card-spoken-toggle").click();
await page.waitForSelector(
  '[data-testid="dev-case"][data-case="a-ready"] [data-testid="card-spoken"]',
);
const spoken = await answer.getByTestId("card-spoken").evaluate((node) => ({
  words: node.textContent.trim().split(/\s+/).length,
  markdown: /[*_`#]|https?:/.test(node.textContent),
  links: node.querySelectorAll("a").length,
}));
await page.screenshot({ path: openShot, fullPage: true });

// ---- The app's layout (US-011's first criterion) ----
const app = await browser.newPage({ viewport: { width: 1400, height: 900 } });
app.on("console", (m) => m.type() === "error" && consoleErrors.push(`[app] ${m.text()}`));
app.on("pageerror", (e) => consoleErrors.push(`[app] ${e}`));
await app.goto(url, { waitUntil: "networkidle" });
await app.waitForSelector('[data-testid="stage"]');
// The sidebar stacks the transcript over the notes, so both can be measured.
const boardBox = await app
  .locator('[data-testid="board"]')
  .evaluate((node) => node.getBoundingClientRect().toJSON());
await app.waitForSelector('[data-testid="transcript"]');
const layout = await app.evaluate((board) => {
  const width = document.querySelector(".layout").getBoundingClientRect().width;
  const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
  const stage = document.querySelector('[data-testid="stage"]').getBoundingClientRect();
  const transcript = document.querySelector(".transcript").getBoundingClientRect();
  return {
    sidebarPct: Math.round((sidebar.width / width) * 100),
    stagePct: Math.round((stage.width / width) * 100),
    // Both panels live in the sidebar, one tab each.
    panelsInSidebar:
      transcript.left >= sidebar.left - 1 &&
      transcript.right <= sidebar.right + 1 &&
      board.left >= sidebar.left - 1 &&
      board.right <= sidebar.right + 1,
    stageRightOfSidebar: stage.left >= sidebar.right - 1,
    header: {
      source: document.querySelector('[data-testid="source-select"]') !== null,
      start: document.querySelector('[data-testid="start-session"]') !== null,
      dots: ["server", "transcription", "model"].filter(
        (channel) => document.querySelector(`[data-testid="status-${channel}"]`) !== null,
      ),
    },
    placeholder: document.querySelector('[data-testid="session-state"]')?.textContent?.trim(),
  };
}, boardBox);
await app.screenshot({ path: layoutShot });

await browser.close();

const report = {
  bodyBackground,
  cases,
  thinkingAnimation,
  stageIds,
  trayToggle,
  trayOpenBefore,
  trayed,
  collapsedHeight,
  openedGlow,
  details,
  detailsToggleAfter,
  spoken,
  layout,
  consoleErrors,
};
console.log(JSON.stringify(report, null, 2));

const problems = [];
const byId = Object.fromEntries(cases.map((one) => [one.id, one]));

// Every variant and every state is on the page.
for (const id of [
  "a-ready",
  "a-thinking",
  "a-streaming",
  "a-error",
  "i-ready",
  "i-thinking",
  "i-error",
  "g-ready",
  "g-thinking",
  "g-error",
]) {
  if (byId[id] === undefined) problems.push(`/dev/cards is missing the ${id} sample`);
}
const variants = new Set(cases.map((one) => one.variant));
for (const variant of ["answer", "interject", "glow"]) {
  if (!variants.has(variant)) problems.push(`no ${variant} card on /dev/cards`);
}
const states = new Set(cases.map((one) => one.state));
for (const state of ["ready", "thinking", "error"]) {
  if (!states.has(state)) problems.push(`no card in the ${state} state`);
}

// Dark theme.
if (bodyBackground !== "rgb(17, 16, 14)") problems.push(`body background is ${bodyBackground}`);

// The answer card.
const ready = byId["a-ready"];
if (ready?.headlinePx < 28) problems.push(`answer headline is ${ready?.headlinePx}px, under 28`);
if (!ready?.question.includes("competitors charge")) {
  problems.push(`answer question reads ${JSON.stringify(ready?.question)}`);
}
if (ready?.asker !== "Craig") problems.push(`answer asker reads ${JSON.stringify(ready?.asker)}`);
if (ready?.detailsToggle !== "details ▾") {
  problems.push(`details toggle reads ${JSON.stringify(ready?.detailsToggle)}`);
}
if (ready?.detailsOpen) problems.push("the answer's details were open before anyone asked");
if (ready?.sources.length !== 3) problems.push(`answer had ${ready?.sources.length} sources`);
if (!ready?.sources[0]?.text.startsWith("[1]")) {
  problems.push(`sources are not numbered: ${JSON.stringify(ready?.sources[0]?.text)}`);
}
if (!ready?.sources.every((one) => one.href.startsWith("https://"))) {
  problems.push("a source did not link to its URL");
}

// The interjection card: answer-sized headline, accent border, why now, evidence.
const interject = byId["i-ready"];
if (interject?.headlinePx !== ready?.headlinePx) {
  problems.push(`interject headline is ${interject?.headlinePx}px, answer is ${ready?.headlinePx}px`);
}
if (interject?.label !== "Noticed") {
  problems.push(`interject label reads ${JSON.stringify(interject?.label)}`);
}
if (parseFloat(interject?.borderLeft ?? "0") < 2) {
  problems.push(`interject border is ${interject?.borderLeft}, not an accent edge`);
}
if (!interject?.why.startsWith("why now")) {
  problems.push(`interject why-now reads ${JSON.stringify(interject?.why)}`);
}
if (interject?.quotes.length !== 2) {
  problems.push(`interject showed ${interject?.quotes.length} evidence quotes`);
}
if (!interject?.quotes[0]?.includes("four thousand")) {
  problems.push(`the first quote reads ${JSON.stringify(interject?.quotes[0])}`);
}

// The glow: one compact line, a button, no evidence until it is opened.
const glowCase = byId["g-ready"];
if (glowCase?.tag !== "button") problems.push(`a collapsed glow is a <${glowCase?.tag}>`);
if (glowCase?.quotes.length !== 0) problems.push("a collapsed glow showed its evidence");
if (glowCase?.why !== "") problems.push("a collapsed glow showed its why-now line");
if (collapsedHeight > 60) problems.push(`a collapsed glow is ${collapsedHeight}px tall`);
if (openedGlow.tag !== "article" || openedGlow.expanded !== "true") {
  problems.push(`clicking the glow left a <${openedGlow.tag}> expanded=${openedGlow.expanded}`);
}
if (openedGlow.quotes !== 1) problems.push(`the opened glow showed ${openedGlow.quotes} quotes`);
if (openedGlow.headlinePx < 28) {
  problems.push(`the opened glow's headline is ${openedGlow.headlinePx}px`);
}
if (openedGlow.height <= collapsedHeight) problems.push("the glow did not grow when opened");
if (openedGlow.collapse !== "Quiet note") {
  problems.push(`the opened glow's label reads ${JSON.stringify(openedGlow.collapse)}`);
}

// Thinking and error states.
for (const id of ["a-thinking", "a-streaming", "i-thinking", "g-thinking"]) {
  if (!byId[id]?.thinking) problems.push(`${id} has no thinking indicator`);
}
if (byId["a-streaming"]?.headline === "") problems.push("the streaming card lost its headline");
if (thinkingAnimation.name !== "card-thinking") {
  problems.push(`the thinking dots animate with ${thinkingAnimation.name}`);
}
for (const id of ["a-error", "i-error", "g-error"]) {
  if (byId[id]?.error === "") problems.push(`${id} shows no error message`);
  if (byId[id]?.thinking) problems.push(`${id} is both thinking and broken`);
}
if (byId["a-error"]?.sources.length !== 0) problems.push("an error card still showed sources");
// A broken card with no headline shows none — the message is the whole card.
if (byId["a-error"]?.headline !== "") {
  problems.push(`the headline-less error card reads ${JSON.stringify(byId["a-error"]?.headline)}`);
}
if (byId["i-error"]?.headline === "") problems.push("the interject error card lost its headline");

// The stack and the tray.
if (stageIds.length !== 3) problems.push(`the sample stage has ${stageIds.length} cards, not 3`);
// Newest on top: the glow arrived 1 s ago, the interjection 4 s, the answer 20 s.
const STAGE_ORDER = ["Nobody has said", "A $12 solo tier", "Competitors sit between"];
STAGE_ORDER.forEach((prefix, at) => {
  if (!stageIds[at]?.startsWith(prefix)) {
    problems.push(`stage card ${at + 1} is ${JSON.stringify(stageIds[at])}, expected ${prefix}…`);
  }
});
if (trayOpenBefore !== 0) problems.push("the tray was open before anyone clicked it");
if (trayToggle !== "2 quiet thoughts ▾") {
  problems.push(`the tray reads ${JSON.stringify(trayToggle)}`);
}
if (trayed.length !== 2) problems.push(`the tray holds ${trayed.length} cards`);
if (!trayed.every((one) => one.variant === "glow" && one.expanded === "false")) {
  problems.push(`the tray holds ${JSON.stringify(trayed)}`);
}

// The markdown behind "details ▾".
if (detailsToggleAfter !== "details ▴") {
  problems.push(`the open toggle reads ${JSON.stringify(detailsToggleAfter)}`);
}
if (details.paragraphs < 2) problems.push(`details rendered ${details.paragraphs} paragraphs`);
if (details.bullets !== 3) problems.push(`details rendered ${details.bullets} bullets`);
if (details.strong[0] !== "per-seat") problems.push(`bold came out as ${details.strong[0]}`);
if (details.em[0] !== "comparable") problems.push(`italics came out as ${details.em[0]}`);
if (details.code[0] !== "npm run pricing") problems.push(`code came out as ${details.code[0]}`);
if (details.links[0] !== "https://example.com/pricing") {
  problems.push(`the detail link is ${details.links[0]}`);
}
if (details.html) problems.push("the markdown renderer let a <script> through");

// What Sotto said out loud (V2-005): the words, and nothing meant for the eye.
if (spoken.words < 20) problems.push(`the transcript of the answer is ${spoken.words} words`);
if (spoken.markdown) problems.push("the spoken half carries markdown or a URL");
if (spoken.links !== 0) problems.push(`the spoken half rendered ${spoken.links} links`);

// The layout.
if (layout.sidebarPct < 20 || layout.sidebarPct > 30) {
  problems.push(`the sidebar is ${layout.sidebarPct}% wide, not about 25`);
}
if (layout.stagePct < 70 || layout.stagePct > 80) {
  problems.push(`the stage is ${layout.stagePct}% wide, not about 75`);
}
if (!layout.panelsInSidebar) problems.push("the transcript and the notes are not both in the sidebar");
if (!layout.stageRightOfSidebar) problems.push("the stage is not to the right of the sidebar");
if (!layout.header.source || !layout.header.start) problems.push("the header lost its controls");
if (layout.header.dots.length !== 3) {
  problems.push(`the header has dots ${JSON.stringify(layout.header.dots)}`);
}
if (!layout.placeholder?.startsWith("Sotto listens")) {
  problems.push(`the empty stage reads ${JSON.stringify(layout.placeholder)}`);
}

if (consoleErrors.length > 0) problems.push(`console errors: ${consoleErrors.join("; ")}`);
if (problems.length > 0) throw new Error(problems.join("\n"));

console.log(`\nOK — screenshots at ${shot}, ${trayShot}, ${openShot} and ${layoutShot}`);
