/**
 * Browser check for the opening hello (V2-009).
 *
 * Both halves of the criterion, against the real server:
 *
 *   - **muted**: a `wav` session is started with the voice muted, and the hello
 *     arrives on the stage as a `notice` card — plain, no "Sotto noticed…"
 *     label, no feedback buttons.
 *   - **spoken**: the same session with the voice on, where the hello goes out
 *     through real ElevenLabs: the speaking indicator comes up and goes down,
 *     and the words land in the transcript as Sotto's own line (V2-008a).
 *
 * The session is started through `POST /api/session/start`, because the
 * header's Start button is the microphone and a real microphone is not
 * something an automated check may touch. The fixture is the shortest one
 * there is and the session is stopped as soon as each half is proved, so this
 * costs a few seconds of transcription and one short utterance.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-hello.mjs /tmp/shot.png
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shotPrefix = (process.argv[2] ?? "/tmp/sotto-shots/hello.png").replace(/\.png$/, "");
const HELLO = readFileSync(new URL("../server/prompts/hello.md", import.meta.url), "utf8").trim();
const FIXTURE = "ask-diagram";

const problems = [];
const browser = await chromium.launch({
  headless: true,
  args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(base, { waitUntil: "networkidle" });
  // Chrome will not start an AudioContext without one of these.
  await page.getByRole("heading", { name: "Sotto" }).click();

  const mute = page.getByLabel("Mute voice");
  const setMuted = async (muted) => {
    if ((await mute.isChecked()) !== muted) await mute.click();
    await page.waitForFunction(
      (want) => document.querySelector('input[type="checkbox"]')?.checked === want,
      muted,
    );
  };
  const start = async () => {
    const result = await page.evaluate(async (fixture) => {
      const response = await fetch("/api/session/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "wav", fixture } }),
      });
      return { status: response.status, body: await response.json() };
    }, FIXTURE);
    if (result.status !== 200) throw new Error(`could not start: ${JSON.stringify(result)}`);
    return result.body.session.id;
  };
  const stop = () => page.evaluate(() => fetch("/api/session/stop", { method: "POST" }));

  // ---- muted: the hello is shown, not said -------------------------------
  await setMuted(true);
  await start();
  const notice = page.locator('[data-testid="card"][data-variant="notice"]');
  await notice.waitFor({ timeout: 20_000 });
  const shown = await notice.evaluate((card) => ({
    headline: card.querySelector('[data-testid="card-headline"]')?.textContent?.trim() ?? "",
    label: card.querySelector('[data-testid="card-label"]')?.textContent?.trim() ?? "",
    feedback: card.querySelectorAll('[data-testid="card-feedback"]').length,
    fontSize: getComputedStyle(card.querySelector('[data-testid="card-headline"]')).fontSize,
  }));
  await page.screenshot({ path: `${shotPrefix}-muted.png` });
  if (shown.headline !== HELLO) problems.push(`the card does not read hello.md: ${shown.headline}`);
  if (shown.label !== "") problems.push(`the hello card is labeled "${shown.label}"`);
  if (shown.feedback !== 0) problems.push("the hello card offers feedback buttons");
  // Nothing was said, so nothing is written down.
  if ((await page.locator('[data-testid="turn"][data-sotto="true"]').count()) !== 0) {
    problems.push("a muted hello wrote a transcript line");
  }
  await stop();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="start-session"]')?.disabled === false,
    undefined,
    { timeout: 30_000 },
  );

  // ---- unmuted: the hello is said out loud -------------------------------
  await setMuted(false);
  await start();
  const speaking = page.locator('[data-testid="voice-speaking"]');
  await speaking.waitFor({ timeout: 30_000 });
  const spokenText = await speaking.textContent();
  await page.locator('[data-testid="voice-speaking"][data-playing="true"]').waitFor({ timeout: 30_000 });
  await page.screenshot({ path: `${shotPrefix}-speaking.png` });
  // Nothing on the stage this time: it was heard, not read.
  if ((await notice.count()) !== 0) problems.push("a spoken hello also put a card on the stage");
  await speaking.waitFor({ state: "hidden", timeout: 60_000 });

  // And it is in the transcript as Sotto's own line (V2-008a).
  await page.locator('.discussion-tabs button:text-is("Transcript")').click();
  const mine = page.locator('[data-testid="turn"][data-sotto="true"]');
  await mine.first().waitFor({ timeout: 30_000 });
  const line = (await mine.first().locator(".turn__text").textContent())?.trim() ?? "";
  await page.screenshot({ path: `${shotPrefix}-transcript.png` });
  if (line !== HELLO) problems.push(`the transcript line is not the hello: ${line}`);
  await stop();

  if (errors.length > 0) problems.push(`page errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({ shown, spokenText, line: line.slice(0, 60) }, null, 2));
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.error(`\nFAIL\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("\nPASS: the hello is said out loud, shown when muted, and written down.");
