/**
 * Browser check for the Sotto UI. Run with `npm run dev` already serving, e.g.
 *   npm run dev & node scripts/verify-ui.mjs
 * Writes a screenshot to the path given as the first argument.
 */
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/ui.png";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="server-status"]');
await page.waitForFunction(
  () => document.querySelector('[data-testid="server-status"]')?.textContent?.includes("connected"),
  undefined,
  { timeout: 10_000 },
);

const brand = (await page.locator("h1.brand").textContent())?.trim();
const status = (await page.getByTestId("server-status").textContent())?.trim();
const health = await page.evaluate(() => fetch("/api/health").then((r) => r.json()));

await page.screenshot({ path: shot });
await browser.close();

console.log(JSON.stringify({ brand, status, health, consoleErrors }, null, 2));
if (brand !== "Sotto") throw new Error(`expected brand "Sotto", got ${JSON.stringify(brand)}`);
if (status !== "server: connected") throw new Error(`expected connected, got ${JSON.stringify(status)}`);
if (health?.ok !== true) throw new Error(`/api/health returned ${JSON.stringify(health)}`);
if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join("; ")}`);
console.log(`\nOK — screenshot at ${shot}`);
