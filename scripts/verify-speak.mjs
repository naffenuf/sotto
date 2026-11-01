/**
 * Browser check for speaking the answer to the room (V3-004).
 *
 * The whole fast path, live: an `offsite-plan` events replay at 1x against the
 * real model and real ElevenLabs, where somebody wonders aloud how long the
 * drive is (line 12), Sotto claims it (V3-015), searches (V3-003) and says what
 * it found at a real pause. The check reads the three things the criterion
 * names off the page:
 *
 *   - the claim and the answer are in the transcript as **Sotto's** lines
 *     (V2-008a, `data-sotto="true"`),
 *   - the research card is still there, and lists its sources,
 *   - and `timing.jsonl` says what the decision to speak was made on: the
 *     cached still-current verdict, the pause wait, and the latency from the
 *     question going final.
 *
 * The voice is real but the browser is muted (`--mute-audio`), so nothing comes
 * out of a speaker and the playback page still reports what it played — which
 * is what writes Sotto's line into the transcript at all.
 *
 * It is stopped as soon as the answer is said rather than running the whole
 * conversation, so it costs one search and two short utterances.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-speak.mjs /tmp/shot.png
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shotPrefix = (process.argv[2] ?? "/tmp/sotto-shots/speak.png").replace(/\.png$/, "");
const FIXTURE = "offsite-plan";
/** The question is at 57 s of the replay, and the search takes 15–25 s. */
const ANSWER_TIMEOUT_MS = 6 * 60_000;
const SESSIONS = new URL("../sessions/", import.meta.url).pathname;

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
  // Chrome will not start an AudioContext without a gesture, and without the
  // AudioContext nothing reports having played anything.
  await page.getByRole("heading", { name: "Sotto" }).click();

  const mute = page.getByLabel("Mute voice");
  if (await mute.isChecked()) await mute.click();

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
  console.log(`replaying ${FIXTURE} as ${sessionId}; waiting for Sotto to answer…`);

  // The transcript is behind its own tab; the board is what the sidebar opens on.
  await page.locator('.discussion-tabs button:text-is("Transcript")').click();
  // An unprompted interjection earlier in the conversation spends the
  // frequency's cooldown (V2-017), and V3-004 counts against the same one — so
  // a run where the policy interjected before the question has nothing left to
  // say the answer with, and the card is the only sign. That is the specified
  // behaviour, so it is reported by name rather than waited out.
  const blocked = await page
    .waitForFunction(
      () =>
        [
          ...document.querySelectorAll('[data-testid="turn"][data-sotto="true"] .turn__text'),
        ].some((row) => (row.textContent ?? "").trim().startsWith("On ")),
      undefined,
      { timeout: ANSWER_TIMEOUT_MS },
    )
    .then(() => false)
    .catch(() => true);
  if (blocked) {
    problems.push(
      "no spoken answer: see the spoken_contribution lines below for the reason" +
        " (`cooldown`/`budget` means an earlier interjection had spent the floor)",
    );
  }
  const sotto = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="turn"][data-sotto="true"]')].map((row) => ({
      turnId: row.dataset.turnId,
      interrupted: row.dataset.interrupted === "true",
      text: (row.querySelector(".turn__text")?.textContent ?? "").trim(),
    })),
  );
  await page.screenshot({ path: `${shotPrefix}-transcript.png`, fullPage: true });

  const claim = sotto.find((row) => row.text.startsWith("I'll check"));
  const answer = sotto.find((row) => row.text.startsWith("On "));
  if (claim === undefined) problems.push("no claim ('I'll check …') in the transcript");
  if (answer === undefined) problems.push("no answer ('On …') in the transcript");
  if (claim !== undefined && answer !== undefined && sotto.indexOf(claim) > sotto.indexOf(answer)) {
    problems.push("the answer is above the claim in the transcript");
  }
  if (answer !== undefined && /\bhttps?:/.test(answer.text)) {
    problems.push(`the spoken answer carries a URL: ${answer.text}`);
  }

  // ---- the card is still the card, and it has its sources ---------------
  const card = page.locator('[data-testid="card"][data-variant="research"]').first();
  await card.waitFor({ timeout: 30_000 });
  await card.click();
  const open = page
    .locator('[data-testid="card"][data-variant="research"][data-expanded="true"]')
    .first();
  await open.locator('[data-testid="card-details"]').waitFor({ timeout: 15_000 });
  const opened = await open.evaluate((element) => ({
    headline: element.querySelector('[data-testid="card-headline"]')?.textContent?.trim() ?? "",
    keyPoints: element.querySelectorAll('[data-testid="card-details"] li').length,
    sources: [...element.querySelectorAll('[data-testid="card-source"] a')].map((a) => a.href),
    note: element.querySelector('[data-testid="card-note"]')?.textContent?.trim() ?? "",
  }));
  await page.screenshot({ path: `${shotPrefix}-card.png`, fullPage: true });
  if (opened.sources.length === 0) problems.push("the research card lists no sources");

  await page.evaluate(() => fetch("/api/session/stop", { method: "POST" }));
  await page.waitForFunction(
    () => document.querySelector('[data-testid="start-session"]')?.disabled === false,
    undefined,
    { timeout: 180_000 },
  );

  // ---- the record: what the decision to speak was made on ----------------
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
  const spoken = timing.filter((line) => line.stage === "spoken_contribution");
  const answers = spoken.filter((line) => line.kind === "answer" && line.spoken === true);
  const verdicts = timing.filter((line) => line.stage === "still_current");
  if (answers.length === 0) problems.push("timing.jsonl records no spoken answer");
  for (const line of answers) {
    if (typeof line.questionToSpeechMs !== "number") {
      problems.push("a spoken answer has no questionToSpeechMs");
    }
    if (typeof line.pauseWaitMs !== "number") problems.push("a spoken answer has no pauseWaitMs");
    if (line.stillCurrent?.verdict === undefined) {
      problems.push("a spoken answer records no still-current verdict");
    }
  }

  if (errors.length > 0) problems.push(`page errors: ${errors.join(" | ")}`);
  console.log(
    JSON.stringify(
      {
        sessionId,
        folder,
        sotto,
        card: opened,
        spoken: spoken.map((line) => ({
          kind: line.kind,
          spoken: line.spoken,
          reason: line.reason ?? null,
          atMs: line.atMs,
          questionToReserveMs: line.questionToReserveMs ?? null,
          questionToSpeechMs: line.questionToSpeechMs ?? null,
          pauseWaitMs: line.pauseWaitMs ?? null,
          stillCurrent: line.stillCurrent?.verdict ?? null,
          yielded: line.yielded ?? null,
          text: line.text,
        })),
        verdicts: verdicts.map((line) => ({
          verdict: line.verdict,
          turns: line.turns,
          latencyMs: line.latencyMs,
          why: line.why ?? null,
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
console.log("\nPASS: the claim and the answer are Sotto's lines, and the card keeps its sources.");
