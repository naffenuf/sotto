/**
 * Answering a real question with the real model and the real web (PRD US-018).
 *
 * `ask-search` is the capture where somebody says "Sotto, what do the main
 * competitors charge per month?" out loud, so replaying it at `max` runs the
 * whole path with nothing faked but the session folder's location: wake
 * detection (US-017), the board loop for context (US-009), then the answer
 * agent's streamed, searching call. The result is read back out of
 * `answers.jsonl`, because that file is the contract — one line per answer,
 * with the headline, the detail and the sources as the group saw them.
 *
 * What is really under test is `server/prompts/answer.md` plus
 * `MuseClient.prose`: the model has to search, answer in the shape the stage
 * expects (a headline of at most 90 characters, then markdown), and name
 * pages it actually read.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";
import {
  ANSWER_DETAIL_MAX_WORDS,
  ANSWER_HEADLINE_MAX_CHARS,
  type AnswerLogRecord,
} from "../../shared/answers.js";
import type { StageCard } from "../../shared/cards.js";
import { EventBus } from "../events/bus.js";
import { SessionManager } from "../session/SessionManager.js";
import { SESSION_FILES, SessionStore } from "../session/SessionStore.js";

// `globalSetup` loads `.env` in the main process; a test file runs in a worker
// and has to load it for itself.
loadDotenv({ quiet: true });

const apiKey = (process.env.MODEL_API_KEY ?? "").trim();

/** Board calls, an observer look each, and one searching answer. */
const REPLAY_TIMEOUT_MS = 10 * 60_000;

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

const fixture = "ask-search";

/** What one replayed conversation produced. */
interface Replayed {
  answers: AnswerLogRecord[];
  cards: StageCard[];
}

async function replay(root: string, name: string): Promise<Replayed> {
  const bus = new EventBus(quiet);
  const cards: StageCard[] = [];
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
  sessions.start({ kind: "events", fixture: name });
  await ended;

  // Each replay gets its own root, so there is exactly one folder in it.
  const folders = readdirSync(root);
  expect(folders).toHaveLength(1);
  const path = join(root, folders[0] as string, SESSION_FILES.answers);
  // The log is only opened on the first append, so a missing file means
  // nothing was ever asked — which for this fixture is the failure.
  expect(existsSync(path), `nothing was written to ${SESSION_FILES.answers}`).toBe(true);
  const answers = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AnswerLogRecord);
  return { answers, cards };
}

describe.skipIf(apiKey === "")(`the answer agent after replaying ${fixture}`, () => {
  let root: string;
  let result: Replayed;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-answer-"));
    result = await replay(root, fixture);
  }, REPLAY_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("answers the one question the fixture asks, and only that one", () => {
    expect(
      result.answers.map((answer) => answer.question),
      "expected exactly one answer",
    ).toHaveLength(1);
    const answer = result.answers[0]!;
    expect(answer.kind).toBe("answer");
    expect(answer.status, answer.error ?? "no error recorded").toBe("done");
    expect(answer.question.toLowerCase()).toContain("competitors charge");
    // Spoken, so it belongs to the turn it was asked in.
    expect(answer.turnId).not.toBeNull();
    expect(answer.askedBy).not.toBe("");
    // Zero here, and only here: simulated time does not move while a tracked
    // call is in flight (US-006), so a `max` replay's answer takes no time on
    // the session clock. A live session's does.
    expect(answer.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("answers in the shape the stage expects, with pages it read", () => {
    const answer = result.answers[0]!;
    expect(answer.headline.trim(), "the headline is empty").not.toBe("");
    expect(answer.headline.length).toBeLessThanOrEqual(ANSWER_HEADLINE_MAX_CHARS);
    // A headline is one line: the detail lives under it.
    expect(answer.headline).not.toContain("\n");
    expect(
      answer.detailMd.split(/\s+/).filter((word) => word !== "").length,
    ).toBeLessThanOrEqual(ANSWER_DETAIL_MAX_WORDS);
    // The sources block is pulled out of the detail and shown as links.
    expect(answer.detailMd.toLowerCase()).not.toContain("sources:");

    expect(
      answer.citations,
      `no citations; the detail was ${JSON.stringify(answer.detailMd)}`,
    ).not.toHaveLength(0);
    for (const citation of answer.citations) {
      expect(citation.url, answer.headline).toMatch(/^https?:\/\//);
      expect(citation.title.trim(), citation.url).not.toBe("");
    }
    // Deduplicated by URL before it reaches the card.
    expect(new Set(answer.citations.map((one) => one.url)).size).toBe(answer.citations.length);
  });

  it("streams the answer onto the stage under one card id", () => {
    const answers = result.cards.filter((card) => card.variant === "answer");
    expect(answers.length, "no answer card reached the stage").toBeGreaterThanOrEqual(2);
    expect(new Set(answers.map((card) => card.id)).size).toBe(1);
    // Thinking first, finished last; a headline may arrive in between.
    expect(answers[0]?.state).toBe("thinking");
    expect(answers[0]?.headline).toBe("");
    const last = answers.at(-1)!;
    expect(last.state).toBe("ready");
    expect(last.headline).toBe(result.answers[0]?.headline);
    expect(last.question).toBe(result.answers[0]?.question);
    expect(last.citations).toEqual(result.answers[0]?.citations);
  });
});
