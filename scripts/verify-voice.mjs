import { chromium } from "playwright";

const base = process.env.SOTTO_TEST_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true, args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Sotto" }).click();
  const mute = page.getByLabel("Mute voice");
  if (await mute.isChecked()) { await mute.click(); await page.waitForFunction(() => document.querySelector('input[type="checkbox"]')?.checked === false); }
  await page.waitForTimeout(300);
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/voice/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello, I'm Sotto. This is a longer test of the voice playback system. We are checking that the stage shows when I am speaking and that a person can stop me at any time. This extra sentence gives the test enough time to click the stop control." }) });
    return { status: response.status, body: await response.json() };
  });
  if (result.status !== 200) throw new Error(`voice test failed: ${JSON.stringify(result)}`);
  await page.getByTestId("voice-speaking").waitFor({ timeout: 15000 });
  await page.locator('[data-testid="voice-speaking"][data-playing="true"]').waitFor({ timeout: 15000 });
  await page.screenshot({ path: "/tmp/sotto-v2-004-speaking.png" });
  await page.getByRole("button", { name: "Stop speaking" }).click();
  await page.getByTestId("voice-speaking").waitFor({ state: "hidden" });
  await mute.click();
  await page.waitForFunction(() => document.querySelector('input[type="checkbox"]')?.checked === true);
  await page.reload({ waitUntil: "networkidle" });
  if (!await mute.isChecked()) throw new Error("mute setting did not survive reload");
  await mute.click();
  await page.waitForFunction(() => document.querySelector('input[type="checkbox"]')?.checked === false);
  const second = await page.evaluate(async () => {
    const response = await fetch("/api/voice/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Playback finished normally." }) });
    return response.status;
  });
  if (second !== 200) throw new Error(`second voice test failed: ${second}`);
  await page.locator('[data-testid="voice-speaking"][data-playing="true"]').waitFor({ timeout: 15000 });
  await page.getByTestId("voice-speaking").waitFor({ state: "hidden", timeout: 15000 });
  if (errors.length) throw new Error(errors.join("; "));
  console.log("Voice test utterance, speaking indicator, Stop, and mute persistence verified.");
} finally { await browser.close(); }
