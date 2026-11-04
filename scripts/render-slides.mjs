#!/usr/bin/env node
// Renders demo/slides/*.html to 1920x1080 PNGs in demo/build/ with Playwright.
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve("demo/slides");
const out = resolve("demo/build");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
for (const file of readdirSync(dir).filter((f) => f.endsWith(".html")).sort()) {
  await page.goto(`file://${resolve(dir, file)}`);
  await page.waitForTimeout(300);
  const png = resolve(out, file.replace(/\.html$/, ".png"));
  await page.screenshot({ path: png, fullPage: false });
  console.log(`${file} -> ${png}`);
}
await browser.close();
