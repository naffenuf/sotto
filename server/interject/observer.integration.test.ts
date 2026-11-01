/**
 * The observer against the real model (PRD US-012).
 *
 * `moment-contradiction` is replayed at `max` through the whole pipeline —
 * assembler, board update loop, observer, `SessionStore` — with nothing faked
 * but the session folder's location, and the candidates are read back from
 * `candidates.jsonl` rather than from a callback, so one assertion covers both
 * "the observer noticed" and "it was written down before anything could act on
 * it".
 *
 * What this is really testing is `server/prompts/observer.md`: the fixture
 * plants a contradiction (a $4,000 first-version budget, then a $20,000 design
 * studio for that same first version) and the observer has to notice *that*,
 * cite the turn where it was said, and not fill the file with noise on the way
 * past.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
import {
  HEADLINE_MAX_CHARS,
  candidateTypes,
  type Candidate,
  type CandidateLogLine,
  type CandidateLogRecord,
  type DecisionLogRecord,
} from "../../shared/candidates.js";
import { BOLDNESS_THRESHOLDS, decisionReasons, decisions } from "../../shared/policy.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { EventBus } from "../events/bus.js";
import { SessionManager } from "../session/SessionManager.js";
import { SESSION_FILES, SessionStore } from "../session/SessionStore.js";

// `globalSetup` loads `.env` in the main process; a test file runs in a worker
// and has to load it for itself.
loadDotenv({ quiet: true });

const apiKey = (process.env.MODEL_API_KEY ?? "").trim();

/** A board call and an observer call per update; the API sets the pace. */
const REPLAY_TIMEOUT_MS = 10 * 60_000;

/**
 * The API reports a turn's position in the audio, but its endpointer trims
 * about half a second off each end of a line (`fixtures/events/NOTES.md`), so
 * the window a scripted line is matched against is widened rather than
 * requiring the turn to sit inside it exactly.
 */
const SLACK_MS = 1_500;

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const fixture = "moment-contradiction";

/** One replayed conversation: what the observer noticed, and what was said. */
interface Replayed {
  /** The candidate lines of `candidates.jsonl`, in order. */
  records: CandidateLogRecord[];
  /** The policy's decisions from the same file (US-014). */
  decided: DecisionLogRecord[];
  /** Every final turn, oldest first. */
  turns: TurnUpdate[];
}

function loadScript(name: string): FixtureScript {
  const path = join(repoRoot, "fixtures/scripts", `${name}.json`);
  return FixtureScriptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function loadTiming(name: string): FixtureTiming {
  const path = join(repoRoot, "fixtures/audio", `${name}.timing.json`);
  return FixtureTimingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

async function replay(root: string, name: string): Promise<Replayed> {
  const bus = new EventBus(quiet);
  const sessions = new SessionManager({
    bus,
    apiKey,
    logger: quiet,
    replaySpeed: "max",
    createStore: (info) => SessionStore.create(info, { root, logger: quiet }),
  });

  const turns: TurnUpdate[] = [];
  const ended = new Promise<void>((resolve) => {
    const off = bus.subscribe((event) => {
      if (event.type === "turn" && event.turn.final) turns.push(event.turn);
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
  const dir = join(root, folders[0] as string);
  // The log is only opened on the first append, so a missing file means the
  // observer noticed nothing at all — which for this fixture is the failure.
  const path = join(dir, SESSION_FILES.candidates);
  expect(existsSync(path), `the observer wrote no ${SESSION_FILES.candidates}`).toBe(true);
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CandidateLogLine);
  return {
    records: lines.filter((line): line is CandidateLogRecord => line.kind === "candidate"),
    decided: lines.filter((line): line is DecisionLogRecord => line.kind === "decision"),
    turns,
  };
}

/** The ids of the final turns that overlap one scripted line of the fixture. */
function turnsOverlapping(turns: TurnUpdate[], timing: FixtureTiming, line: number): string[] {
  const scripted = timing.lines[line];
  expect(scripted, `no timing for line ${line}`).toBeDefined();
  const { startMs, endMs } = scripted as { startMs: number; endMs: number };
  return turns
    .filter(
      (turn) =>
        turn.startMs <= endMs + SLACK_MS && (turn.endMs ?? turn.startMs) >= startMs - SLACK_MS,
    )
    .map((turn) => turn.turnId);
}

describe.skipIf(apiKey === "")(`the observer after replaying ${fixture}`, () => {
  let root: string;
  let result: Replayed;
  /** Turn ids overlapping the line where the contradiction is sprung. */
  let triggerTurnIds: Set<string>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-observer-"));
    result = await replay(root, fixture);
    const timing = loadTiming(fixture);
    const script = loadScript(fixture);
    const moment = script.moments[0];
    expect(moment?.type).toBe("contradiction");
    triggerTurnIds = new Set(turnsOverlapping(result.turns, timing, moment?.triggerLine ?? -1));
    expect(triggerTurnIds.size, "no turns overlap the planted trigger line").toBeGreaterThan(0);
  }, REPLAY_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("notices the planted contradiction and cites the turn that sprang it", () => {
    const contradictions = result.records
      .map((record) => record.candidate)
      .filter((candidate) => candidate.type === "contradiction");
    expect(
      contradictions.map((candidate) => candidate.headline),
      `no contradiction candidate among ${JSON.stringify(summary(result.records))}`,
    ).not.toHaveLength(0);

    const sourced = contradictions.filter((candidate) =>
      candidate.evidenceTurnIds.some((id) => triggerTurnIds.has(id)),
    );
    expect(
      sourced.map((candidate) => ({
        headline: candidate.headline,
        evidenceTurnIds: candidate.evidenceTurnIds,
      })),
      `no contradiction cites the trigger turn; expected one of ${JSON.stringify([...triggerTurnIds])}`,
    ).not.toHaveLength(0);
  });

  it("writes every candidate down with an id, a run, scores and evidence", () => {
    expect(result.records.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const record of result.records) {
      const candidate = record.candidate;
      expect(record.kind).toBe("candidate");
      expect(ids.has(candidate.id), `${candidate.id} was written twice`).toBe(false);
      ids.add(candidate.id);
      expect(candidateTypes).toContain(candidate.type);
      expect(candidate.run).toBeGreaterThan(0);
      expect(candidate.headline.length, candidate.headline).toBeLessThanOrEqual(
        HEADLINE_MAX_CHARS,
      );
      expect(candidate.detail.trim(), candidate.headline).not.toBe("");
      expect(candidate.whyNow.trim(), candidate.headline).not.toBe("");
      expect(candidate.evidenceTurnIds.length, candidate.headline).toBeGreaterThan(0);
      for (const score of Object.values(candidate.scores)) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it("stays quiet enough to be worth listening to", () => {
    // Twenty-six scripted lines with one planted moment. A handful of
    // candidates is the prompt working; one per board update is it padding.
    const passed = result.records.filter((record) => record.candidate.duplicateOf === undefined);
    expect(passed.length, JSON.stringify(summary(result.records))).toBeLessThanOrEqual(8);
  });

  it("decides about everything it passed on, in the same file", () => {
    // A `factual_error` can stop at the verifier, but a contradiction always
    // reaches the policy — and the first test here insists on one.
    expect(result.decided.length).toBeGreaterThan(0);
    const passed = new Set(
      result.records
        .filter((record) => record.candidate.duplicateOf === undefined)
        .map((record) => record.candidate.id),
    );
    for (const decision of result.decided) {
      expect(passed.has(decision.candidateId), `${decision.candidateId} was decided unasked`).toBe(
        true,
      );
      expect(decisions).toContain(decision.decision);
      expect(decisionReasons).toContain(decision.reason);
      expect(decision.score).toBeGreaterThanOrEqual(0);
      expect(decision.score).toBeLessThanOrEqual(1);
      expect(decision.settings).toEqual({ frequency: "normal", boldness: "normal" });
      expect(decision.thresholds).toEqual(BOLDNESS_THRESHOLDS.normal);
    }
  });

  it("does not raise the same thing twice", () => {
    const passed = result.records
      .map((record) => record.candidate)
      .filter((candidate) => candidate.duplicateOf === undefined);
    // Within one type, no two candidates that got through point at the same
    // board item — that is exactly what the duplicate check removes.
    for (const type of candidateTypes) {
      const items = passed
        .filter((candidate) => candidate.type === type)
        .flatMap((candidate) => candidate.relatedBoardItemIds);
      expect(new Set(items).size, `${type} repeats a board item`).toBe(items.length);
    }
  });
});

/** `contradiction: "…" (dup of cand-1)` per record, for a failure message. */
function summary(records: readonly CandidateLogRecord[]): string[] {
  return records.map((record) => describe1(record.candidate));
}

function describe1(candidate: Candidate): string {
  const dup = candidate.duplicateOf === undefined ? "" : ` (dup of ${candidate.duplicateOf})`;
  return `${candidate.id} ${candidate.type}: ${candidate.headline}${dup}`;
}
