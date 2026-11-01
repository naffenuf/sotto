/**
 * V2-010: the header's judgment dot.
 *
 * Starts an `events` replay through the API (the header's Start button is the
 * microphone now) and reads the dot back: "checking" before the health check
 * answers, then `local` or `cloud`. Which one depends on whether Glimmer is
 * running on this Mac, so both are a pass — what is being checked is that the
 * dot exists, says one of the two, and goes idle again when the session ends.
 */
import { chromium } from "playwright";

const shot = process.argv[2] ?? "/tmp/judgment.png";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
const problems = [];

try {
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
  const dot = page.getByTestId("status-judgment");
  await dot.waitFor({ timeout: 10_000 });
  const before = (await dot.textContent())?.trim();
  if (before !== "judgment: idle") problems.push(`dot before a session: ${before}`);

  await page.evaluate(async () => {
    const response = await fetch("/api/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { kind: "events", fixture: "moment-fact" } }),
    });
    if (!response.ok) throw new Error(`start: ${response.status} ${await response.text()}`);
  });

  // The check settles in milliseconds when Glimmer is there (a models
  // listing) and after one timeout when it is not.
  await page.waitForFunction(
    () => {
      const detail = document.querySelector('[data-testid="status-judgment"]')?.getAttribute("data-detail");
      return detail === "local" || detail === "cloud";
    },
    undefined,
    { timeout: 15_000 },
  );
  const where = await dot.getAttribute("data-detail");
  const text = (await dot.textContent())?.trim();
  const title = await dot.getAttribute("title");
  if (text !== `judgment: ${where}`) problems.push(`dot reads "${text}" for ${where}`);
  if (!title?.includes(where === "local" ? "this Mac" : "cloud")) {
    problems.push(`tooltip does not explain ${where}: ${title}`);
  }
  console.log(`judgment: ${where} — ${title}`);
  await page.screenshot({ path: shot });

  await page.evaluate(() => fetch("/api/session/stop", { method: "POST" }));
  await page.waitForFunction(
    () => document.querySelector('[data-testid="status-judgment"]')?.textContent?.includes("idle"),
    undefined,
    { timeout: 10_000 },
  );
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.error(`FAIL\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`PASS — screenshot at ${shot}`);
