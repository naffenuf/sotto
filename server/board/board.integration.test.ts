/**
 * The board update loop against the real model (PRD US-009).
 *
 * Two captured conversations are replayed at `max` through the whole
 * pipeline — assembler, update loop, `SessionStore`, event bus — with nothing
 * faked but the session folder's location. `max` is what makes this affordable:
 * simulated time skips the silences but stops dead at every `clock.track`ed
 * model call, so a two-minute conversation costs six or seven calls and about
 * as long as those calls take.
 *
 * What it is actually checking is that the prompt works. A board full of the
 * right kinds of item is the prompt doing its job; `moment-contradiction`'s
 * constraint pointing back at the turn where the budget was stated is the
 * `sourceTurnIds` instruction doing its job, which is what US-012's
 * contradiction detection will stand on.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";
import {
  FixtureScriptSchema,
  FixtureTimingSchema,
  type FixtureScript,
  type FixtureTiming,
} from "../../shared/fixtures.js";
import type { Board, Item } from "../../shared/board.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { EventBus } from "../events/bus.js";
import { SessionManager } from "../session/SessionManager.js";
import { SESSION_FILES, SessionStore } from "../session/SessionStore.js";

// `globalSetup` loads `.env` in the main process; a test file runs in a worker
// and has to load it for itself.
loadDotenv({ quiet: true });

const apiKey = (process.env.MODEL_API_KEY ?? "").trim();

/** Six or seven sequential reasoning calls per fixture; the API sets the pace. */
const REPLAY_TIMEOUT_MS = 10 * 60_000;

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** One replayed conversation: what the board ended up as, and what was said. */
interface Replayed {
  board: Board;
  markdown: string;
  /** Every final turn, oldest first. */
  turns: TurnUpdate[];
  /** How many `board` events went out over the bus. */
  pushes: number;
}

function loadScript(name: string): FixtureScript {
  const path = join(repoRoot, "fixtures/scripts", `${name}.json`);
  return FixtureScriptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function loadTiming(name: string): FixtureTiming {
  const path = join(repoRoot, "fixtures/audio", `${name}.timing.json`);
  return FixtureTimingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Replays a capture at `max` with a real model client and returns the board.
 *
 * The board is read back from `board.json` rather than from the bus, so one
 * assertion covers both halves of "written via SessionStore and pushed over
 * `/ws/events`" — the push is counted separately.
 */
async function replay(root: string, fixture: string): Promise<Replayed> {
  const bus = new EventBus(quiet);
  const sessions = new SessionManager({
    bus,
    apiKey,
    logger: quiet,
    replaySpeed: "max",
    createStore: (info) => SessionStore.create(info, { root, logger: quiet }),
  });

  const turns: TurnUpdate[] = [];
  let pushes = 0;
  const ended = new Promise<void>((resolve) => {
    const off = bus.subscribe((event) => {
      if (event.type === "turn" && event.turn.final) turns.push(event.turn);
      if (event.type === "board") pushes += 1;
      if (event.type === "session" && event.session === null) {
        off();
        resolve();
      }
    });
  });
  sessions.start({ kind: "events", fixture });
  await ended;

  // Each replay gets its own root, so there is exactly one folder in it; the
  // name is the minute and the source, not the session id.
  const folders = readdirSync(root);
  expect(folders).toHaveLength(1);
  const dir = join(root, folders[0] as string);
  const board = JSON.parse(readFileSync(join(dir, SESSION_FILES.board), "utf8")) as Board;
  const markdown = readFileSync(join(dir, SESSION_FILES.boardMarkdown), "utf8");
  return { board, markdown, turns, pushes };
}

/** Every item on the board that is not dropped, across all four sections. */
function live(items: Item[]): Item[] {
  return items.filter((item) => item.status !== "dropped");
}

describe.skipIf(apiKey === "")("the board after replaying brainstorm", () => {
  let root: string;
  let result: Replayed;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-board-brainstorm-"));
    result = await replay(root, "brainstorm");
  }, REPLAY_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("organizes the conversation into points, a decision and a question", () => {
    // The fixture was scripted (US-002) to contain at least five points, one
    // decision and one open question, so this is a test of the prompt.
    expect(live(result.board.points).length).toBeGreaterThanOrEqual(4);
    expect(live(result.board.decisions).length).toBeGreaterThanOrEqual(1);
    expect(live(result.board.questions).length).toBeGreaterThanOrEqual(1);
  });

  it("writes a non-empty summary of two sentences at most", () => {
    const summary = result.board.summary.trim();
    expect(summary).not.toBe("");
    // The prompt's limit. Counted generously: abbreviations would split too.
    expect(summary.split(/[.!?]+\s/).length).toBeLessThanOrEqual(3);
  });

  it("keeps items short and attributed, and pushes every update to the browser", () => {
    const items = [
      ...result.board.constraints,
      ...result.board.points,
      ...result.board.questions,
      ...result.board.decisions,
    ];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.text.trim()).not.toBe("");
      // "<= 12 words" is an instruction, not a schema keyword, so this is
      // loose on purpose: it catches a model writing paragraphs, not one
      // going a word over.
      expect(item.text.split(/\s+/).length, item.text).toBeLessThanOrEqual(20);
      expect(item.sourceTurnIds.length, item.text).toBeGreaterThan(0);
    }
    expect(result.pushes).toBeGreaterThan(0);
  });

  it("writes board.md alongside board.json", () => {
    expect(result.markdown).toContain("# Board");
    for (const item of live(result.board.points)) {
      expect(result.markdown).toContain(item.text);
    }
  });
});

describe.skipIf(apiKey === "")("the board after replaying moment-contradiction", () => {
  let root: string;
  let result: Replayed;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-board-contradiction-"));
    result = await replay(root, "moment-contradiction");
  }, REPLAY_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("records the planted budget constraint, sourced from a setup turn", () => {
    const script = loadScript("moment-contradiction");
    const timing = loadTiming("moment-contradiction");
    const moment = script.moments[0];
    expect(moment?.type).toBe("contradiction");

    // The turns that overlap the lines where the constraint was stated. The
    // API reports a turn's position in the audio, but its endpointer trims
    // about half a second off each end of a line (see
    // fixtures/events/NOTES.md), so the window is widened rather than
    // requiring the turn to sit inside the scripted line exactly.
    const SLACK_MS = 1_500;
    const setupTurnIds = new Set(
      (moment?.setupLines ?? []).flatMap((line) => {
        const scripted = timing.lines[line];
        expect(scripted, `no timing for line ${line}`).toBeDefined();
        const { startMs, endMs } = scripted as { startMs: number; endMs: number };
        return result.turns
          .filter(
            (turn) =>
              turn.startMs <= endMs + SLACK_MS && (turn.endMs ?? turn.startMs) >= startMs - SLACK_MS,
          )
          .map((turn) => turn.turnId);
      }),
    );
    expect(setupTurnIds.size, "no turns overlap the planted setup lines").toBeGreaterThan(0);

    const constraints = live(result.board.constraints);
    expect(constraints.length, "no constraints on the board").toBeGreaterThan(0);
    // The budget is the constraint the contradiction turns on, so it has to be
    // there by its number, not merely as "we agreed on a budget".
    const budget = constraints.filter((item) => /\b(4,?000|four thousand)\b/i.test(item.text));
    expect(
      budget.map((item) => item.text),
      `no $4,000 budget constraint among ${JSON.stringify(constraints.map((i) => i.text))}`,
    ).not.toHaveLength(0);
    // And it has to point back at where it was said, which is what US-012
    // quotes as evidence.
    const sourced = budget.filter((item) =>
      item.sourceTurnIds.some((id) => setupTurnIds.has(id)),
    );
    expect(
      sourced.map((item) => ({ text: item.text, sourceTurnIds: item.sourceTurnIds })),
      `the budget constraint cites no setup turn; expected one of ${JSON.stringify([...setupTurnIds])}`,
    ).not.toHaveLength(0);
  });
});
