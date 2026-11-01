/**
 * The research card as the room sees it when somebody asks for it (V2-015).
 *
 * `/dev/cards` is the only place a *brought-forward* card exists on demand: in
 * a real session it is a card the stage has already shown, re-pushed with
 * `forward` while Sotto briefs the room from the packet — which costs a
 * replay, a gate, a search and a wake question to reach (that is what
 * `npm run verify:research` and `briefing.integration.test.ts` are for). What
 * is checked here is the half of the story that is pure rendering: it is open
 * without being clicked, it shows the key points and the sources the group
 * asked to see, it is accented, and it can still be collapsed again.
 *
 * No API calls and no session: this is the cheap check to run after touching
 * the card.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-briefing.mjs /tmp/shot.png
 */
import { chromium } from "playwright";

const base = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/briefing.png";

const problems = [];
const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(`${base}/dev/cards`, { waitUntil: "networkidle" });
  const asked = page.locator('[data-case="r-forward"] [data-testid="card"]');
  await asked.waitFor({ timeout: 15_000 });
  const state = await asked.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    expanded: element.getAttribute("data-expanded"),
    accented: element.classList.contains("card--forward"),
    keyPoints: element.querySelectorAll('[data-testid="card-details"] li').length,
    sources: element.querySelectorAll('[data-testid="card-source"]').length,
    teaser: element.querySelector('[data-testid="card-teaser"]')?.textContent?.trim() ?? "",
    feedback: element.querySelectorAll('[data-testid="card-feedback"]').length,
    height: Math.round(element.getBoundingClientRect().height),
  }));
  await page.locator('[data-case="r-forward"]').screenshot({ path: shot });

  if (state.tag !== "article") problems.push("the card somebody asked for is still collapsed");
  if (state.expanded !== "true") problems.push("the card is not marked open");
  if (!state.accented) problems.push("the card is not accented while Sotto briefs from it");
  if (state.keyPoints === 0) problems.push("no key points are shown");
  if (state.sources === 0) problems.push("no sources are shown");
  if (state.teaser === "") problems.push("the teaser is missing");
  // Research is never a policy delivery, so there is nothing to file a verdict
  // against — the same rule V2-014 shipped.
  if (state.feedback !== 0) problems.push("a brought-forward card offers feedback buttons");

  // The reader keeps the last word: an open card still folds away.
  await asked.locator('[data-testid="card-collapse"]').click();
  const collapsed = await page
    .locator('[data-case="r-forward"] [data-testid="card"]')
    .getAttribute("data-expanded");
  if (collapsed !== "false") problems.push("the card could not be collapsed again");

  console.log(JSON.stringify({ ...state, collapsedAfterClick: collapsed === "false" }, null, 2));
  console.log(`screenshot: ${shot}`);
  if (errors.length > 0) problems.push(`console errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.error(`\nFAIL\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("\nPASS: the research somebody asked for comes forward open, accented and foldable");
