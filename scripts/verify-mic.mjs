/**
 * Browser check for US-012: the microphone.
 *
 * Two runs in one, each in its own browser context:
 *
 *  1. **Refused.** `getUserMedia` is replaced with one that rejects the way a
 *     blocked permission does, and the page has to say so in the open and
 *     start no session.
 *  2. **Allowed.** Chromium's fake capture device plays into the real
 *     pipeline: getUserMedia -> AudioWorklet -> 24 kHz PCM16 -> /ws/audio ->
 *     the live transcription API. The transcription dot has to go active, and
 *     the session folder has to show the API working through the audio
 *     (`audioProgress` frames, `fixtures/events/NOTES.md`), which is the proof
 *     that real samples made it all the way out of the browser. Halfway
 *     through, the page is **reloaded**: the audio socket drops without a
 *     clean close, the server holds the session open, and the reloaded page
 *     — with no click on it — has to dial the microphone back in, so the one
 *     session keeps counting audio and no second one is started.
 *
 * The second run is a live session, so the dev server needs MODEL_API_KEY.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-mic.mjs /tmp/mic.png
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/mic.png";
const deniedShot = shot.replace(/\.png$/, "-denied.png");
const idleShot = shot.replace(/\.png$/, "-idle.png");
const sessionsDir = fileURLToPath(new URL("../sessions/", import.meta.url));

/** How long the microphone streams before Stop. Enough for a few seconds of frames. */
const LISTEN_MS = 6_000;

const browser = await chromium.launch({
  headless: true,
  args: [
    // A microphone that is always there and always allowed. The autoplay
    // policy is deliberately Chrome's own: the reloaded page has had no
    // gesture, and whether its AudioContext runs is part of what is checked.
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});

const consoleErrors = [];
const watch = (page) => {
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  return page;
};

/** Waits until every named dot is in `state`. */
const waitForDots = (page, channels, state, timeout = 20_000) =>
  page.waitForFunction(
    ({ channels, state }) =>
      channels.every(
        (channel) =>
          document.querySelector(`[data-testid="status-${channel}"]`)?.dataset.state === state,
      ),
    { channels, state },
    { timeout },
  );

const dots = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      ["server", "transcription", "model"].map((channel) => [
        channel,
        document.querySelector(`[data-testid="status-${channel}"]`)?.dataset.state,
      ]),
    ),
  );

// ---------------------------------------------------------------- refused --
const refused = await browser.newContext({ viewport: { width: 1200, height: 760 } });
await refused.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = () =>
    Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
});
const deniedPage = watch(await refused.newPage());
await deniedPage.goto(url, { waitUntil: "networkidle" });
await waitForDots(deniedPage, ["server"], "active");
await deniedPage.getByTestId("start-session").click();
await deniedPage.waitForSelector('[data-testid="session-problem"]', { timeout: 10_000 });
const deniedProblem = (await deniedPage.getByTestId("session-problem").textContent())?.trim();
const deniedState = (await deniedPage.getByTestId("session-state").textContent())?.trim();
const deniedDots = await dots(deniedPage);
await deniedPage.screenshot({ path: deniedShot });
await refused.close();

// ---------------------------------------------------------------- allowed --
const allowed = await browser.newContext({
  viewport: { width: 1200, height: 760 },
  permissions: ["microphone"],
});
const page = watch(await allowed.newPage());
await page.goto(url, { waitUntil: "networkidle" });
await waitForDots(page, ["server"], "active");

const before = sessionFolders();
await page.getByTestId("start-session").click();
await waitForDots(page, ["transcription", "model"], "active");
const runningDots = await dots(page);
const runningState = (await page.getByTestId("session-state").textContent())?.trim();
await page.waitForTimeout(LISTEN_MS);
// `.textContent()` on a missing element waits out the whole default timeout,
// which here would be thirty more seconds of billed microphone.
const problem = page.getByTestId("session-problem");
const problemWhileRunning = (await problem.count()) > 0 ? await problem.textContent() : null;
await page.screenshot({ path: shot });

// A refresh mid-meeting. The server sees the socket drop and holds the
// session; the reloaded page finds it on the transcription dot and rejoins.
const processedBeforeReload = audioProcessedSoFar(before);
await page.reload({ waitUntil: "networkidle" });
const detailAfterReload = await page
  .locator('[data-testid="status-transcription"]')
  .evaluate((node) => node.dataset.detail);
await waitForDots(page, ["transcription"], "active");
await page.waitForTimeout(LISTEN_MS);
const processedAfterReload = audioProcessedSoFar(before);
const problemAfterReload = (await problem.count()) > 0 ? await problem.textContent() : null;
const stateAfterReload = (await page.getByTestId("session-state").textContent())?.trim();
const rejoinedDots = await dots(page);

await page.getByTestId("stop-session").click();
await waitForDots(page, ["transcription", "model"], "idle");
const stoppedDots = await dots(page);
await page.screenshot({ path: idleShot });

await browser.close();

// What the session folder recorded, which is the proof audio reached the API.
const folder = sessionFolders().find((name) => !before.includes(name));
const frames =
  folder === undefined
    ? []
    : readFileSync(join(sessionsDir, folder, "events.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
const progress = frames.filter((record) => record.frame?.type === "audioProgress");
const audioProcessedMs = progress.at(-1)?.frame?.audioProcessedMs ?? 0;
const asrSessions =
  folder === undefined
    ? []
    : JSON.parse(readFileSync(join(sessionsDir, folder, "session.json"), "utf8")).asrSessions;

const report = {
  deniedProblem,
  deniedState,
  deniedDots,
  runningDots,
  runningState,
  problemWhileRunning,
  reload: {
    detailAfterReload,
    processedBeforeReload,
    processedAfterReload,
    problemAfterReload,
    stateAfterReload,
    rejoinedDots,
  },
  stoppedDots,
  folder,
  frames: frames.length,
  audioProgressFrames: progress.length,
  audioProcessedMs,
  asrSessions,
  consoleErrors,
};
console.log(JSON.stringify(report, null, 2));

const problems = [];
if (!/microphone access was blocked/i.test(deniedProblem ?? "")) {
  problems.push(`a refused microphone said ${JSON.stringify(deniedProblem)}`);
}
if (!deniedState?.startsWith("Sotto listens")) {
  problems.push(`a refused microphone still started a session: ${JSON.stringify(deniedState)}`);
}
if (deniedDots.transcription !== "idle") {
  problems.push(`a refused microphone moved the dots: ${JSON.stringify(deniedDots)}`);
}
if (runningDots.transcription !== "active") {
  problems.push(`the transcription dot did not go active: ${JSON.stringify(runningDots)}`);
}
if (!runningState?.startsWith("Listening to Microphone")) {
  problems.push(`the stage reads ${JSON.stringify(runningState)}`);
}
if (problemWhileRunning !== null) problems.push(`an error while running: ${problemWhileRunning}`);
if (problemAfterReload !== null) problems.push(`an error after the reload: ${problemAfterReload}`);
if (!stateAfterReload?.startsWith("Listening to Microphone")) {
  problems.push(`after the reload the stage reads ${JSON.stringify(stateAfterReload)}`);
}
// The reloaded page rejoined: the same session went on counting audio, by at
// least four of the six seconds listened to after the reload.
if (processedAfterReload - processedBeforeReload < 4_000) {
  problems.push(
    `after the reload only ${processedAfterReload - processedBeforeReload} ms more audio reached the API`,
  );
}
if (sessionFolders().filter((name) => !before.includes(name)).length !== 1) {
  problems.push("the reload started a second session");
}
if (stoppedDots.transcription !== "idle" || stoppedDots.model !== "idle") {
  problems.push(`the dots did not go back down: ${JSON.stringify(stoppedDots)}`);
}
if (folder === undefined) problems.push("no session folder was written");
if (asrSessions.length !== 1) problems.push(`asrSessions is ${JSON.stringify(asrSessions)}`);
// The API reports its position in the audio once per 80 ms chunk, so this is
// the browser's samples arriving: at least eight of the twelve seconds of them.
if (audioProcessedMs < 8_000) {
  problems.push(`only ${audioProcessedMs} ms of microphone audio reached the API`);
}
if (consoleErrors.length > 0) problems.push(`console errors: ${consoleErrors.join("; ")}`);
if (problems.length > 0) throw new Error(problems.join("\n"));

console.log(`\nOK — screenshots at ${deniedShot}, ${shot} and ${idleShot}`);

/** The API's count of audio received so far by the session started in this run. */
function audioProcessedSoFar(before) {
  const folder = sessionFolders().find((name) => !before.includes(name));
  if (folder === undefined) return 0;
  let processed = 0;
  for (const line of readFileSync(join(sessionsDir, folder, "events.jsonl"), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line);
    if (record.frame?.type === "audioProgress") processed = record.frame.audioProcessedMs;
  }
  return processed;
}

/** Session folders, newest last. */
function sessionFolders() {
  try {
    return readdirSync(sessionsDir)
      .filter((name) => statSync(join(sessionsDir, name)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}
