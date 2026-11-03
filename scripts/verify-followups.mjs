/**
 * Browser check for follow-ups without the wake word (V3-014).
 *
 * A real `followups` events replay against the real model, because the
 * indicator this is about only exists after Sotto has really answered
 * something: the wake watcher reads line 3, the answer agent answers it, and
 * only then does the window open and the follow-up classifier start reading
 * every turn.
 *
 * What it reads off the page, in order:
 *
 *   1. nothing before the answer — the indicator is not up at the start;
 *   2. the "in conversation" indicator after the answer, in its own style
 *      (`data-in-conversation="true"`);
 *   3. it clears when the pair go back to talking to each other, which in
 *      this script is "Okay, EJ, what do you actually want to do here" — a
 *      turn the window closes on the name alone.
 *
 * The session is stopped as soon as that has been seen rather than at the end
 * of the conversation: everything after it is two more answers and another
 * window, which `timing.jsonl` and the eval already cover. Even so the replay
 * runs at 1x and stalls on every model call, so this takes a few minutes and
 * a couple of answers' worth of model calls.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-followups.mjs /tmp/shot.png
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shotPrefix = (process.argv[2] ?? "/tmp/sotto-shots/followups.png").replace(/\.png$/, "");
const FIXTURE = "followups";
/** The question is at 0:18 of the audio, and the answer searches behind it. */
const ANSWER_TIMEOUT_MS = 5 * 60_000;
/** The pair resume four lines later, with two more answers in between. */
const RESUME_TIMEOUT_MS = 6 * 60_000;
const SESSIONS = new URL("../sessions/", import.meta.url).pathname;

const problems = [];
const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(base, { waitUntil: "networkidle" });

  const indicator = page.locator('[data-testid="wake-listening"]');
  if ((await indicator.count()) !== 0) problems.push("the indicator was up before anything happened");

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
  console.log(`replaying ${FIXTURE} as ${sessionId}; waiting for the first answer…`);

  // ---- the answer, then the window --------------------------------------
  await page
    .locator('[data-testid="card"][data-variant="answer"][data-state="ready"]')
    .first()
    .waitFor({ timeout: ANSWER_TIMEOUT_MS });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="wake-listening"]')
        ?.getAttribute("data-in-conversation") === "true",
    undefined,
    { timeout: 60_000 },
  );
  const open = await indicator.evaluate((element) => ({
    text: element.textContent?.trim() ?? "",
    inConversation: element.getAttribute("data-in-conversation"),
    conversationStyle: element.className.includes("now__state--conversation"),
  }));
  await page.screenshot({ path: `${shotPrefix}-in-conversation.png` });
  if (open.inConversation !== "true") problems.push("the indicator is not in its conversation state");
  if (!open.conversationStyle) problems.push("the indicator does not carry the conversation style");
  if (!open.text.startsWith("Sotto is listening")) {
    problems.push(`the indicator does not say Sotto is listening: ${open.text}`);
  }
  console.log("in conversation; waiting for the pair to resume…");

  // ---- and it clears when the humans resume ------------------------------
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="wake-listening"]')
        ?.getAttribute("data-in-conversation") !== "true",
    undefined,
    { timeout: RESUME_TIMEOUT_MS },
  );
  await page.screenshot({ path: `${shotPrefix}-cleared.png` });
  const cleared = await indicator.count();

  await page.evaluate(() => fetch("/api/session/stop", { method: "POST" }));
  await page.waitForFunction(
    () => document.querySelector('[data-testid="start-session"]')?.disabled === false,
    undefined,
    { timeout: 180_000 },
  );

  // ---- the record: windows opened and closed, and why -------------------
  const folder = readdirSync(SESSIONS)
    .filter((name) => name.endsWith(`events-${FIXTURE}`))
    .sort()
    .at(-1);
  const timing =
    folder === undefined
      ? []
      : readFileSync(join(SESSIONS, folder, "timing.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line));
  const windows = timing.filter((line) => line.stage === "followup_window");
  const verdicts = timing.filter((line) => line.stage === "followup");
  const followUps = timing.filter((line) => line.stage === "followup_question");
  if (windows.filter((line) => line.event === "opened").length === 0) {
    problems.push("timing.jsonl records no follow-up window");
  }
  if (windows.filter((line) => line.event === "closed").length === 0) {
    problems.push("timing.jsonl records no window closing");
  }
  if (errors.length > 0) problems.push(`page errors: ${errors.join(" | ")}`);
  console.log(
    JSON.stringify(
      {
        sessionId,
        folder,
        open,
        indicatorsAfterResume: cleared,
        followUpsAnswered: followUps.length,
        verdicts: verdicts.map((line) => ({
          turnId: line.turnId,
          kind: line.kind,
          named: line.named ?? null,
          latencyMs: line.latencyMs ?? null,
        })),
        windows: windows.map((line) => ({
          event: line.event,
          atMs: Math.round(line.atMs),
          reason: line.reason ?? null,
          openMs: line.openMs === undefined ? null : Math.round(line.openMs),
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
console.log("\nPASS: the in-conversation indicator comes up after an answer and clears when the humans resume.");
