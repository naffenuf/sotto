/**
 * Browser check for the Sotto UI: the header's source selector and dots, a
 * brainstorm events replay started and stopped (US-009), the transcript
 * panel it fills — first text, partial and final rows, naming a speaker, and
 * jump-to-live (US-007) — and the board panel below it (US-010), both filled
 * by the real replay and, on a second page with `/ws/events` mocked, driven
 * through every item state the model is not guaranteed to produce.
 *
 * Run with the dev server up, e.g.
 *   python3 ~/.claude/skills/webapp-testing/scripts/with_server.py \
 *     --server "npm run dev" --port 5173 -- node scripts/verify-ui.mjs /tmp/shot.png
 *
 * Writes the running state to the path given as the first argument, and the
 * scrolled, idle and mocked-board states alongside it as `<name>-scrolled.png`,
 * `<name>-idle.png` and `<name>-board.png`.
 */
import { chromium } from "playwright";

const url = process.env.SOTTO_URL ?? "http://127.0.0.1:5173";
const shot = process.argv[2] ?? "/tmp/sotto-shots/ui.png";
const idleShot = shot.replace(/\.png$/, "-idle.png");
const scrolledShot = shot.replace(/\.png$/, "-scrolled.png");
const boardShot = shot.replace(/\.png$/, "-board.png");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

/** The three dots, as `{ server: "active", … }`. */
const dots = () =>
  page.evaluate(() =>
    Object.fromEntries(
      ["server", "transcription", "model"].map((channel) => [
        channel,
        document.querySelector(`[data-testid="status-${channel}"]`)?.dataset.state,
      ]),
    ),
  );

/** Waits until every named dot is in `state`. */
const waitForDots = (channels, state, timeout = 15_000) =>
  page.waitForFunction(
    ({ channels, state }) =>
      channels.every(
        (channel) =>
          document.querySelector(`[data-testid="status-${channel}"]`)?.dataset.state === state,
      ),
    { channels, state },
    { timeout },
  );

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="status-server"]');
await waitForDots(["server"], "active");

const brand = (await page.locator("h1.brand").textContent())?.trim();
const serverDot = (await page.getByTestId("status-server").textContent())?.trim();
const health = await page.evaluate(() => fetch("/api/health").then((r) => r.json()));
const options = await page.locator('[data-testid="source-select"] option').evaluateAll((nodes) =>
  nodes.map((node) => ({ value: node.value, label: node.textContent, disabled: node.disabled })),
);
const idleDots = await dots();

const emptyTranscript = (await page.getByTestId("transcript-empty").textContent())?.trim();
const emptyBoard = (await page.getByTestId("board-empty").textContent())?.trim();
const noUpdateYet = (await page.getByTestId("board-updated").textContent())?.trim();

// Start the brainstorm replay and watch the dots come up.
await page.selectOption('[data-testid="source-select"]', "events:brainstorm");
const startedAt = Date.now();
await page.getByTestId("start-session").click();
await waitForDots(["transcription", "model"], "active");

// The spinner is only up while a board update is out, and the highlight only
// for the three seconds after one lands, so both are watched for from here
// rather than checked once the replay has moved on.
const sawBoardSpinner = page
  .waitForSelector('[data-testid="board-spinner"]', { timeout: 150_000 })
  .then(() => true)
  .catch(() => false);
const sawBoardHighlight = page
  .waitForSelector('[data-testid="board-item"][data-changed="true"]', { timeout: 150_000 })
  .then(() => true)
  .catch(() => false);

// The first words have to be on screen within 3 s of the first spoken one,
// which in this capture is the moment the replay starts.
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('[data-testid="turn"] .turn__text')].some(
      (node) => (node.textContent ?? "").trim() !== "",
    ),
  undefined,
  { timeout: 10_000 },
);
const firstTextMs = Date.now() - startedAt;

// A turn shows up as a gray italic partial before it goes final, so both
// states should be visible while the replay runs.
const sawPartial = await page
  .waitForSelector('[data-testid="turn"][data-final="false"]', { timeout: 15_000 })
  .then(() => true)
  .catch(() => false);
await page.waitForSelector('[data-testid="turn"][data-final="true"]', { timeout: 15_000 });

// Wait for a second speaker, so the colours can be compared.
await page.waitForFunction(
  () =>
    new Set(
      [...document.querySelectorAll('[data-testid="turn"]')]
        .map((node) => node.dataset.speaker)
        .filter((label) => label !== ""),
    ).size >= 2,
  undefined,
  { timeout: 30_000 },
);

/** The chip colour and text of the first row of each speaker label. */
const chipsBySpeaker = () =>
  page.evaluate(() => {
    const seen = {};
    for (const row of document.querySelectorAll('[data-testid="turn"]')) {
      const label = row.dataset.speaker;
      const chip = row.querySelector('[data-testid="speaker-chip"]');
      if (label === "" || chip === null) continue;
      const colour = getComputedStyle(chip).backgroundColor;
      seen[label] ??= { colours: new Set(), texts: new Set() };
      seen[label].colours.add(colour);
      seen[label].texts.add(chip.textContent.trim());
    }
    return Object.fromEntries(
      Object.entries(seen).map(([label, { colours, texts }]) => [
        label,
        { colours: [...colours], texts: [...texts] },
      ]),
    );
  });

const chips = await chipsBySpeaker();

// Name speaker A, which every row of A's should pick up.
await page.locator('[data-testid="turn"][data-speaker="A"] [data-testid="speaker-chip"]').first().click();
await page.getByTestId("speaker-name-input").fill("Craig");
await page.getByTestId("speaker-name-save").click();
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('[data-testid="turn"][data-speaker="A"] [data-testid="speaker-chip"]')]
      .every((chip) => chip.textContent.trim() === "Craig"),
  undefined,
  { timeout: 5_000 },
);
const namedChips = await chipsBySpeaker();

// Scrolling up stops the panel following the conversation and offers a way
// back — which needs more conversation than fits the panel first, so this
// waits for the list to overflow (about a minute into the capture).
await page.waitForFunction(
  () => {
    const list = document.querySelector('.transcript__list');
    return list !== null && list.scrollHeight > list.clientHeight + 48;
  },
  undefined,
  { timeout: 120_000 },
);
await page.locator('.transcript__list').evaluate((node) => {
  node.scrollTop = 0;
});
await page.waitForSelector('[data-testid="jump-to-live"]', { timeout: 5_000 });
const jumpAppeared = true;
await page.screenshot({ path: scrolledShot });
await page.getByTestId("jump-to-live").click();
await page.waitForSelector('[data-testid="jump-to-live"]', { state: "detached", timeout: 5_000 });
const atLive = await page.locator('.transcript__list').evaluate((node) => {
  return node.scrollHeight - node.scrollTop - node.clientHeight;
});

// By now the replay is a minute in, so the board has had its four final turns
// and a model call. The panel is read straight off the page.
await page.waitForSelector('[data-testid="board-item"]', { timeout: 150_000 });
const liveBoard = await readBoard(page);
const liveBoardUpdated = (await page.getByTestId("board-updated").textContent())?.trim();
const boardSpinnerSeen = await sawBoardSpinner;
const boardHighlightSeen = await sawBoardHighlight;

const runningDots = await dots();
const runningState = (await page.getByTestId("session-state").textContent())?.trim();
const turnRows = await page.locator('[data-testid="turn"]').count();
await page.screenshot({ path: shot });

// Stop, and watch them go back down.
await page.getByTestId("stop-session").click();
await waitForDots(["transcription", "model"], "idle", 90_000);
const stoppedDots = await dots();
const stoppedState = (await page.getByTestId("session-state").textContent())?.trim();
await page.screenshot({ path: idleShot });


// ---- The board panel's item states, on a mocked `/ws/events` (US-010) ----
//
// A replay shows whatever the model happens to say, and it will not reliably
// cover a dropped item or a covered one. So the second page gets a crafted
// board over a mocked socket: the panel is the real component, only the
// server is not.

const MOCK_BOARD = {
  summary: "The group is pricing a solo plan and has settled on a weekly digest.",
  constraints: [
    item("c1", "Budget is 4,000 dollars a month", "open"),
    item("c2", "Launch before the end of Q1", "covered"),
  ],
  points: [
    item("p1", "Solo tier at 12 dollars a month", "open"),
    item("p2", "Bundle the mobile app for free", "dropped"),
  ],
  questions: [item("q1", "What do competitors charge?", "open")],
  decisions: [item("d1", "Ship a weekly digest email", "covered")],
};

function item(id, text, status) {
  return { id, text, status, sourceTurnIds: ["m:1"], createdAtMs: 1_000, updatedAtMs: 2_000 };
}

const mockPage = await browser.newPage({ viewport: { width: 1200, height: 760 } });
mockPage.on("console", (m) => m.type() === "error" && consoleErrors.push(`[mock] ${m.text()}`));
mockPage.on("pageerror", (e) => consoleErrors.push(`[mock] ${e}`));

// No `connectToServer`, so the page's socket terminates here and nothing it
// sends reaches the real server. React's StrictMode runs the socket effect
// twice in dev, and the first socket's close schedules a reconnect, so the
// live ones are tracked rather than assumed to be one.
const sockets = [];
await mockPage.routeWebSocket(/\/ws\/events/, (ws) => {
  sockets.push(ws);
  ws.onClose(() => {
    const at = sockets.indexOf(ws);
    if (at !== -1) sockets.splice(at, 1);
  });
});
await mockPage.goto(url, { waitUntil: "networkidle" });
await mockPage.waitForTimeout(3_000);
const push = (event) => {
  for (const ws of [...sockets]) ws.send(JSON.stringify(event));
};
if (sockets.length === 0) throw new Error("the mocked /ws/events socket never settled");

push({
  type: "session",
  session: { id: "mock-1", source: { kind: "events", fixture: "brainstorm" }, startedAtMs: 0 },
});
push({ type: "status", status: { channel: "transcription", state: "active" } });
// A call is out: the header spins and says so, with no board yet.
push({ type: "status", status: { channel: "model", state: "connecting", detail: "updating the board" } });
await mockPage.waitForSelector('[data-testid="board-spinner"]');
const mockUpdating = (await mockPage.getByTestId("board-updated").textContent())?.trim();

push({ type: "board", board: MOCK_BOARD, changedIds: ["p1", "q1"], updatedAtMs: 42_000 });
push({ type: "status", status: { channel: "model", state: "active", detail: "model client ready" } });
await mockPage.waitForSelector('[data-testid="board-item"]');
await mockPage.waitForSelector('[data-testid="board-spinner"]', { state: "detached" });

const mockBoard = await readBoard(mockPage);
const mockHighlighted = mockBoard.items.filter((one) => one.changed).map((one) => one.id);
const mockFade = await mockPage
  .locator('[data-testid="board-item"]')
  .first()
  .evaluate((node) => getComputedStyle(node).transitionDuration);
await mockPage.screenshot({ path: boardShot });

// The highlight is gone a little over three seconds after the update, and
// the "ago" line has started counting.
await mockPage.waitForSelector('[data-testid="board-item"][data-changed="true"]', {
  state: "detached",
  timeout: 6_000,
});
const mockFaded = (await mockPage.locator('[data-testid="board-item"][data-changed="true"]').count()) === 0;
const mockAgo = (await mockPage.getByTestId("board-updated").textContent())?.trim();

// Dropped items are behind the toggle, and only behind the toggle.
const droppedToggleText = (await mockPage.getByTestId("show-dropped").textContent())?.trim();
await mockPage.getByTestId("show-dropped").click();
await mockPage.waitForSelector('[data-testid="board-item"][data-status="dropped"]');
const shownDropped = await readBoard(mockPage);
const hideToggleText = (await mockPage.getByTestId("show-dropped").textContent())?.trim();

await browser.close();

const report = {
  brand,
  serverDot,
  health,
  options,
  idleDots,
  emptyTranscript,
  firstTextMs,
  sawPartial,
  turnRows,
  chips,
  namedChips,
  jumpAppeared,
  atLive,
  runningDots,
  runningState,
  stoppedDots,
  stoppedState,
  emptyBoard,
  noUpdateYet,
  liveBoard,
  liveBoardUpdated,
  boardSpinnerSeen,
  boardHighlightSeen,
  mockUpdating,
  mockBoard,
  mockHighlighted,
  mockFade,
  mockFaded,
  mockAgo,
  droppedToggleText,
  hideToggleText,
  shownDropped,
  consoleErrors,
};
console.log(JSON.stringify(report, null, 2));

/**
 * The board panel as the page renders it: the summary, the section headings in
 * order, and every visible item with the box character, whether it is struck
 * through and whether it is still highlighted.
 */
function readBoard(target) {
  return target.evaluate(() => {
    const panel = document.querySelector('[data-testid="board"]');
    const sections = [...panel.querySelectorAll('[data-testid="board-section"]')].map((node) => ({
      section: node.dataset.section,
      title: node.querySelector(".board__section-title").textContent.trim(),
      ids: [...node.querySelectorAll('[data-testid="board-item"]')].map((row) => row.dataset.itemId),
    }));
    const items = [...panel.querySelectorAll('[data-testid="board-item"]')].map((row) => ({
      id: row.dataset.itemId,
      status: row.dataset.status,
      changed: row.dataset.changed === "true",
      box: row.querySelector(".board__box").textContent.trim(),
      text: row.querySelector(".board__text").textContent.trim(),
      struck: getComputedStyle(row.querySelector(".board__text")).textDecorationLine.includes(
        "line-through",
      ),
    }));
    return {
      summary: panel.querySelector('[data-testid="board-summary"]')?.textContent.trim() ?? "",
      sections,
      items,
    };
  });
}

const problems = [];
if (brand !== "Sotto") problems.push(`brand is ${JSON.stringify(brand)}`);
if (serverDot !== "server: connected") problems.push(`server dot reads ${JSON.stringify(serverDot)}`);
if (health?.ok !== true) problems.push(`/api/health returned ${JSON.stringify(health)}`);
if (!options.some((o) => o.value === "wav:brainstorm")) problems.push("no WAV fixture option");
if (!options.some((o) => o.label?.includes("Replay events: brainstorm"))) {
  problems.push("no events replay option");
}
if (!options.some((o) => o.value === "mic" && !o.disabled)) {
  problems.push("microphone option is missing or disabled");
}
if (idleDots.transcription !== "idle" || idleDots.model !== "idle") {
  problems.push(`dots were not idle before Start: ${JSON.stringify(idleDots)}`);
}
if (runningDots.transcription !== "active" || runningDots.model !== "active") {
  problems.push(`dots did not go active: ${JSON.stringify(runningDots)}`);
}
if (!runningState?.startsWith("Listening to Replay events: brainstorm")) {
  problems.push(`running state reads ${JSON.stringify(runningState)}`);
}
if (firstTextMs > 3_000) problems.push(`first text took ${firstTextMs} ms, over the 3 s budget`);
if (!sawPartial) problems.push("no partial turn was ever on screen");
if (turnRows < 2) problems.push(`only ${turnRows} transcript rows`);
for (const [label, { colours, texts }] of Object.entries(chips)) {
  if (colours.length !== 1) problems.push(`speaker ${label} had colours ${colours.join(", ")}`);
  if (texts.length !== 1) problems.push(`speaker ${label} had chips ${texts.join(", ")}`);
}
const palette = Object.values(chips).map(({ colours }) => colours[0]);
if (new Set(palette).size !== palette.length) {
  problems.push(`two speakers share a colour: ${palette.join(", ")}`);
}
if (namedChips.A?.texts?.[0] !== "Craig") {
  problems.push(`renaming A left chips ${JSON.stringify(namedChips.A?.texts)}`);
}
if (namedChips.B?.texts?.[0] === "Craig") problems.push("renaming A also renamed B");
if (atLive > 48) problems.push(`jump to live left ${atLive}px of scroll below`);
// ---- Board panel (US-010) ----
if (!emptyBoard?.startsWith("Nothing on the board yet")) {
  problems.push(`empty board reads ${JSON.stringify(emptyBoard)}`);
}
if (noUpdateYet !== "no update yet") problems.push(`idle freshness reads ${JSON.stringify(noUpdateYet)}`);
if (liveBoard.items.length === 0) problems.push("the replay put nothing on the board");
if (liveBoard.summary === "") problems.push("the replay left the board summary empty");
if (!/^updated /.test(liveBoardUpdated ?? "")) {
  problems.push(`live freshness reads ${JSON.stringify(liveBoardUpdated)}`);
}
if (!boardSpinnerSeen) problems.push("no spinner while a board update was in flight");
if (!boardHighlightSeen) problems.push("no highlight on the items a live update changed");

const SECTION_ORDER = [
  ["constraints", "Constraints"],
  ["points", "Points"],
  ["questions", "Open Questions"],
  ["decisions", "Decisions"],
];
const mockOrder = mockBoard.sections.map(({ section, title }) => [section, title]);
if (JSON.stringify(mockOrder) !== JSON.stringify(SECTION_ORDER)) {
  problems.push(`sections came out as ${JSON.stringify(mockOrder)}`);
}
if (mockBoard.summary !== MOCK_BOARD.summary) {
  problems.push(`summary reads ${JSON.stringify(mockBoard.summary)}`);
}
if (mockUpdating !== "updating…") problems.push(`in-flight freshness reads ${JSON.stringify(mockUpdating)}`);
for (const one of mockBoard.items) {
  if (one.status === "open" && (one.box !== "☐" || one.struck)) {
    problems.push(`open item ${one.id} rendered box ${one.box}, struck ${one.struck}`);
  }
  if (one.status === "covered" && (one.box !== "☑" || !one.struck)) {
    problems.push(`covered item ${one.id} rendered box ${one.box}, struck ${one.struck}`);
  }
  if (one.status === "dropped") problems.push(`dropped item ${one.id} was on screen unasked`);
}
if (JSON.stringify(mockHighlighted) !== JSON.stringify(["p1", "q1"])) {
  problems.push(`highlighted ${JSON.stringify(mockHighlighted)}, expected p1 and q1`);
}
if (mockFade !== "3s") problems.push(`the highlight fades over ${mockFade}, not 3s`);
if (!mockFaded) problems.push("the highlight never faded");
if (!/^updated (just now|\d+s ago)$/.test(mockAgo ?? "")) {
  problems.push(`freshness after the fade reads ${JSON.stringify(mockAgo)}`);
}
if (droppedToggleText !== "show dropped (1)") {
  problems.push(`the dropped toggle reads ${JSON.stringify(droppedToggleText)}`);
}
if (hideToggleText !== "hide dropped (1)") {
  problems.push(`the toggle reads ${JSON.stringify(hideToggleText)} once dropped items are shown`);
}
const shownDroppedItem = shownDropped.items.find((one) => one.id === "p2");
if (shownDroppedItem === undefined) problems.push("the toggle did not reveal the dropped item");
else if (!shownDroppedItem.struck) problems.push("the dropped item was not struck through");
if (shownDropped.sections.find((one) => one.section === "points")?.ids.join() !== "p1,p2") {
  problems.push("the dropped item did not come back in board order");
}

if (consoleErrors.length > 0) problems.push(`console errors: ${consoleErrors.join("; ")}`);
if (problems.length > 0) throw new Error(problems.join("\n"));

console.log(`\nOK — screenshots at ${shot}, ${scrolledShot}, ${idleShot} and ${boardShot}`);
