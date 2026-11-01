import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  // The current discussion stacks the transcript over the notes; both are up from the start.
  await page.locator('[data-testid="transcript"]').waitFor();
  await page.locator('[data-testid="board"]').waitFor();
  if (await page.locator('[data-testid="source-select"]').count()) throw new Error("source selector still visible");
  await page.getByTestId("notes-toggle").click();
  if (await page.locator('[data-testid="board"]').count()) throw new Error("notes should fold away");
  await page.getByTestId("notes-toggle").click();
  await page.locator('[data-testid="board"]').waitFor();
  // Nothing running, so the history list is open.
  const item = page.locator(".history-item").first();
  await item.waitFor();
  await item.click();
  await page.getByText("PREVIOUS DISCUSSION").waitFor();
  await page.getByRole("button", { name: "Backstage" }).click();
  await page.getByRole("region", { name: "Backstage candidates" }).waitFor();
  if (await page.locator(".backstage__candidate").count()) {
    await page.locator(".backstage__candidate").first().getByText("Decision history").click();
    await page.locator(".backstage__candidate ol").first().waitFor();
  }
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await page.locator(".history-transcript pre").waitFor();
  await page.getByRole("button", { name: "Back to current" }).click();
  await page.getByText("CURRENT DISCUSSION").waitFor();
  await page.screenshot({ path: "/tmp/sotto-history-ui.png" });
  console.log("Summary, transcript toggle, history selection, and return to current verified.");
} finally { await browser.close(); }
