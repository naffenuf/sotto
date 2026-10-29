/**
 * Drawing a real diagram with the real model (PRD US-020).
 *
 * `ask-diagram` is the capture where somebody says "Sotto, can you sketch the
 * user flow we just described as a diagram?" out loud, after eight lines
 * describing that flow. Replaying it at `max` runs the whole path — wake
 * detection (US-017), the board for context (US-009), then the answer agent's
 * streamed, searching call with `show_html` on the table — and the thing under
 * test is whether the model takes it: whether `server/prompts/answer.md` plus
 * the tool's description get a diagram for a question that wants one.
 *
 * The result is read off disk, because the session folder is the contract: a
 * line in `answers.jsonl` naming an artifact, and that artifact in
 * `artifacts/`.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";
import type { AnswerLogRecord } from "../../shared/answers.js";
import { ARTIFACT_FILE_PATTERN, artifactUrl } from "../../shared/artifacts.js";
import type { StageCard } from "../../shared/cards.js";
import { EventBus } from "../events/bus.js";
import { SessionManager } from "../session/SessionManager.js";
import { ARTIFACTS_DIR, SESSION_FILES, SessionStore } from "../session/SessionStore.js";

// `globalSetup` loads `.env` in the main process; a test file runs in a worker
// and has to load it for itself.
loadDotenv({ quiet: true });

const apiKey = (process.env.MODEL_API_KEY ?? "").trim();

/** Board calls, an observer look each, and one answer that draws. */
const REPLAY_TIMEOUT_MS = 10 * 60_000;

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

const fixture = "ask-diagram";

describe.skipIf(apiKey === "")(`the answer agent after replaying ${fixture}`, () => {
  let root: string;
  let folder: string;
  let answers: AnswerLogRecord[];
  let cards: StageCard[];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-artifact-"));
    const bus = new EventBus(quiet);
    cards = [];
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
    });
    const sessions = new SessionManager({
      bus,
      apiKey,
      logger: quiet,
      replaySpeed: "max",
      createStore: (info) => SessionStore.create(info, { root, logger: quiet }),
    });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture });
    await ended;

    const folders = readdirSync(root);
    expect(folders).toHaveLength(1);
    folder = join(root, folders[0] as string);
    const path = join(folder, SESSION_FILES.answers);
    expect(existsSync(path), `nothing was written to ${SESSION_FILES.answers}`).toBe(true);
    answers = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as AnswerLogRecord);
  }, REPLAY_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("answers the one question the fixture asks with exactly one artifact", () => {
    expect(answers.map((answer) => answer.question)).toHaveLength(1);
    const answer = answers[0]!;
    expect(answer.status, answer.error ?? "no error recorded").toBe("done");
    expect(answer.question.toLowerCase()).toContain("sketch");
    expect(
      answer.artifacts,
      `no artifact; the answer was ${JSON.stringify(answer.headline)}`,
    ).toHaveLength(1);
    const artifact = answer.artifacts[0]!;
    expect(artifact.title.trim()).not.toBe("");
    expect(artifact.path).toBe(join(ARTIFACTS_DIR, artifact.path.split("/").at(-1) as string));
    expect(ARTIFACT_FILE_PATTERN.test(artifact.path.split("/").at(-1) as string)).toBe(true);
    // Still a glanceable answer: the diagram does not replace the headline.
    expect(answer.headline.trim()).not.toBe("");
  });

  it("writes the artifact where the card says it is, as a real document", () => {
    const artifact = answers[0]!.artifacts[0]!;
    const file = artifact.path.split("/").at(-1) as string;
    const path = join(folder, ARTIFACTS_DIR, file);
    expect(existsSync(path), `${path} is not on disk`).toBe(true);
    const html = readFileSync(path, "utf8");
    // The PRD's test of "is it really a drawing": SVG or a laid-out document.
    expect(html.includes("<svg") || html.includes("<div"), html.slice(0, 200)).toBe(true);
    // Self-contained, as the prompt asks: nothing it renders is fetched.
    expect(html).not.toMatch(/<link[^>]+href\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<script[^>]+src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<img[^>]+src\s*=\s*["']https?:/i);
  });

  it("puts it on the card as a URL under this session", () => {
    const answer = answers[0]!;
    const file = answer.artifacts[0]!.path.split("/").at(-1) as string;
    const last = cards.filter((card) => card.variant === "answer").at(-1)!;
    expect(last.state).toBe("ready");
    expect(last.artifacts).toEqual([
      { title: answer.artifacts[0]!.title, url: artifactUrl("events-ask-diagram-1", file) },
    ]);
  });
});
