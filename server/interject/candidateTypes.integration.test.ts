/**
 * The two candidate types v2 added, against the real model (V2-011).
 *
 * Both new fixtures are replayed at `max` through the whole pipeline —
 * assembler, board update loop, observer, policy, `SessionStore` — with
 * nothing faked but the session folder's location, and the candidates are
 * read back out of `candidates.jsonl`, so one assertion covers "the observer
 * noticed" and "it was written down before anything acted on it".
 *
 * What is really under test is `server/prompts/observer.md`. `offsite-plan`
 * plants a question nobody answers (line 20: "and who's handling food?",
 * answered with "good question" and a swerve to the projector) and
 * `research-business-idea` plants two things an outside lookup would settle
 * (a market size from a half-remembered conference talk, and where three
 * named competitors actually fall short). The third assertion is the routing:
 * a `research_hook` is an idea for the research gate (V2-012), so the policy
 * must never have decided anything about one.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";
import {
  candidateTypes,
  type Candidate,
  type CandidateLogLine,
  type CandidateLogRecord,
  type DecisionLogRecord,
} from "../../shared/candidates.js";
import { EventBus } from "../events/bus.js";
import { SessionManager } from "../session/SessionManager.js";
import { SESSION_FILES, SessionStore } from "../session/SessionStore.js";

// `globalSetup` loads `.env` in the main process; a test file runs in a worker
// and has to load it for itself.
loadDotenv({ quiet: true });

const apiKey = (process.env.MODEL_API_KEY ?? "").trim();

/** Two three-minute fixtures, a board and an observer call per update. */
const REPLAY_TIMEOUT_MS = 20 * 60_000;

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/** Words that make a candidate one about the meal rather than the venue. */
const FOOD_WORDS = /\b(food|meal|meals|lunch|dinner|breakfast|catering|caterer|eat|eating|snack)/i;

/** The candidate and decision lines of one replayed conversation. */
interface Replayed {
  noticed: Candidate[];
  decided: DecisionLogRecord[];
}

async function replay(root: string, fixture: string): Promise<Replayed> {
  const bus = new EventBus(quiet);
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

  // Each replay gets its own root, so there is exactly one folder in it.
  const folders = readdirSync(root);
  expect(folders).toHaveLength(1);
  const path = join(root, folders[0] as string, SESSION_FILES.candidates);
  // The log is only opened on the first append, so a missing file means the
  // observer noticed nothing at all in three minutes of conversation.
  expect(existsSync(path), `the observer wrote no ${SESSION_FILES.candidates}`).toBe(true);
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CandidateLogLine);
  return {
    noticed: lines
      .filter((line): line is CandidateLogRecord => line.kind === "candidate")
      .map((record) => record.candidate),
    decided: lines.filter((line): line is DecisionLogRecord => line.kind === "decision"),
  };
}

describe.skipIf(apiKey === "")("the observer's new candidate types", () => {
  let roots: string[] = [];
  let offsite: Replayed;
  let research: Replayed;

  beforeAll(async () => {
    roots = [
      mkdtempSync(join(tmpdir(), "sotto-offsite-")),
      mkdtempSync(join(tmpdir(), "sotto-research-")),
    ];
    offsite = await replay(roots[0] as string, "offsite-plan");
    research = await replay(roots[1] as string, "research-business-idea");
  }, REPLAY_TIMEOUT_MS);

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("notices that nobody answered who was handling food", () => {
    const questions = offsite.noticed.filter(
      (candidate) => candidate.type === "unanswered_question",
    );
    expect(
      questions.map((candidate) => candidate.headline),
      `no unanswered_question at all among ${JSON.stringify(summary(offsite.noticed))}`,
    ).not.toHaveLength(0);

    const food = questions.filter(
      (candidate) => FOOD_WORDS.test(candidate.headline) || FOOD_WORDS.test(candidate.detail),
    );
    expect(
      food.map((candidate) => candidate.headline),
      `no unanswered_question about food among ${JSON.stringify(summary(offsite.noticed))}`,
    ).not.toHaveLength(0);
    for (const candidate of food) {
      expect(candidate.evidenceTurnIds.length, candidate.headline).toBeGreaterThan(0);
    }
  });

  it("notices at least one thing worth looking up in the business conversation", () => {
    const hooks = research.noticed.filter((candidate) => candidate.type === "research_hook");
    expect(
      hooks.map((candidate) => candidate.headline),
      `no research_hook among ${JSON.stringify(summary(research.noticed))}`,
    ).not.toHaveLength(0);
    for (const hook of hooks) {
      expect(hook.detail.trim(), hook.headline).not.toBe("");
      expect(hook.evidenceTurnIds.length, hook.headline).toBeGreaterThan(0);
    }
  });

  it("keeps every research hook away from the interjection policy", () => {
    for (const replayed of [offsite, research]) {
      const hooks = new Set(
        replayed.noticed
          .filter((candidate) => candidate.type === "research_hook")
          .map((candidate) => candidate.id),
      );
      for (const decision of replayed.decided) {
        expect(
          hooks.has(decision.candidateId),
          `the policy decided ${decision.candidateId}, a research hook`,
        ).toBe(false);
        expect(decision.type).not.toBe("research_hook");
      }
    }
  });

  it("stays inside the vocabulary it was given", () => {
    for (const candidate of [...offsite.noticed, ...research.noticed]) {
      expect(candidateTypes).toContain(candidate.type);
    }
  });
});

/** `cand-1 research_hook: "…" (dup of cand-1)` per candidate, for a failure. */
function summary(candidates: readonly Candidate[]): string[] {
  return candidates.map((candidate) => {
    const dup = candidate.duplicateOf === undefined ? "" : ` (dup of ${candidate.duplicateOf})`;
    return `${candidate.id} ${candidate.type}: ${candidate.headline}${dup}`;
  });
}
