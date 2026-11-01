/**
 * Browser check for the end-of-session digest (V2-018).
 *
 * Three things, against the real server:
 *
 *   - a replayed conversation is stopped after a board update, so `digest.md`
 *     is really written by the pipeline rather than planted;
 *   - the Backstage view for that past discussion shows it, all seven
 *     sections of it;
 *   - "wrap us up", typed into the Ask box while the session is running, is
 *     answered from the digest rather than by the model — with the voice
 *     muted, so it arrives as a `notice` card on the stage and no ElevenLabs
 *     call is made.
 *
 * The session is started through `POST /api/session/start`: the header's
 * Start button is the microphone (V2-009), which an automated check may not
 * touch. It is stopped as soon as the board has something on it, so this
 * costs one or two model calls.
 *
 * A replayed session is only in the "Previous discussions" list when the
 * server has `SOTTO_DEV=1`, which `npm run dev:server` sets.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-digest.mjs /tmp/shot.png
 */
import { chromium } from "playwright";

const base = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shotPrefix = (process.argv[2] ?? "/tmp/sotto-shots/digest.png").replace(/\.png$/, "");
const FIXTURE = "moment-fact";
const SECTIONS = [
  "Summary",
  "Decisions",
  "Open questions",
  "What Sotto said",
  "On-screen interjections",
  "What Sotto almost said",
  "Research produced",
];

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
  await page.getByRole("heading", { name: "Sotto" }).click();

  // Muted, so the wrap-up is shown rather than synthesized.
  const mute = page.getByLabel("Mute voice");
  if (!(await mute.isChecked())) await mute.click();

  const started = await page.evaluate(async (fixture) => {
    const response = await fetch("/api/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { kind: "events", fixture } }),
    });
    return { status: response.status, body: await response.json() };
  }, FIXTURE);
  if (started.status !== 200) throw new Error(`could not start: ${JSON.stringify(started)}`);

  // Wait for the board to have a summary: a digest of nothing proves nothing.
  await page.locator('[data-testid="board-summary"]').waitFor({ timeout: 120_000 });

  // ---- "wrap us up", typed, while it is running --------------------------
  await page.getByPlaceholder("Ask Sotto…").fill("Sotto, wrap us up");
  await page.getByPlaceholder("Ask Sotto…").press("Enter");
  const notice = page.locator('[data-testid="card"][data-variant="notice"]');
  await notice.first().waitFor({ timeout: 30_000 });
  const wrapUp = await notice.first().evaluate((card) => ({
    headline: card.querySelector('[data-testid="card-headline"]')?.textContent?.trim() ?? "",
    body: card.textContent?.trim() ?? "",
  }));
  await page.screenshot({ path: `${shotPrefix}-wrapup.png` });
  if (wrapUp.headline !== "Where we got to") {
    problems.push(`the wrap-up card reads "${wrapUp.headline}"`);
  }
  if (!wrapUp.body.includes("Here's where we got to")) {
    problems.push(`the wrap-up said nothing from the board: ${wrapUp.body.slice(0, 120)}`);
  }

  // The POST resolves once the session has drained, which is after the
  // digest and `endedAt` are on disk — and `endedAt` is what makes a folder a
  // past discussion. The page's own refresh runs on the `session: null`
  // event, which goes out before any of that, so the list is re-fetched here.
  await page.evaluate(async () => {
    await fetch("/api/session/stop", { method: "POST" });
  });
  await page.reload({ waitUntil: "networkidle" });

  // ---- the digest, in Backstage -----------------------------------------
  const item = page.locator(".history-item").first();
  await item.waitFor({ timeout: 30_000 });
  const title = (await item.textContent())?.trim() ?? "";
  await item.click();
  if (!title.toLowerCase().includes("photo") && !title.includes(FIXTURE)) {
    problems.push(`the newest discussion is not the replay just made: ${title}`);
  }
  await page.getByText("PREVIOUS DISCUSSION").waitFor();
  await page.getByRole("button", { name: "Backstage" }).click();
  const digest = page.locator('[data-testid="digest"]');
  await digest.waitFor({ timeout: 30_000 });
  const text = (await digest.textContent()) ?? "";
  await page.screenshot({ path: `${shotPrefix}.png` });
  for (const section of SECTIONS) {
    if (!text.includes(`## ${section}`)) problems.push(`the digest has no ${section} section`);
  }
  if (text.startsWith("# Digest")) problems.push("the digest repeats its own title");
  if (!text.includes("Where we got to")) {
    problems.push("the digest does not record the wrap-up Sotto said");
  }
  const visible = await digest.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { height: Math.round(box.height), width: Math.round(box.width) };
  });
  if (visible.height < 50) problems.push(`the digest is ${visible.height}px tall`);

  if (errors.length > 0) problems.push(`page errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({ title, wrapUp: wrapUp.body.slice(0, 120), visible, digestChars: text.length }, null, 2));
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.error(`\nFAIL\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("\nPASS: the digest is written on Stop, shown in Backstage, and spoken when asked for.");
