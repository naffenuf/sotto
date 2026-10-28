/**
 * The fact check against the real model and the real web (PRD US-013).
 *
 * `moment-fact` is replayed at `max` through the whole pipeline — assembler,
 * board loop, observer, verifier, `SessionStore` — with nothing faked but the
 * session folder's location, and the result is read back out of
 * `candidates.jsonl`, because that file is the contract: a candidate is
 * written down when it is noticed and a `verification` line lands beside it
 * when the check comes back.
 *
 * The fixture plants one checkable error: B says Instagram launched in 2014
 * (it was October 2010) and hangs a two-year growth curve on it. So what is
 * really under test is `server/prompts/verify.md` plus
 * `MuseClient.grounded` — the model has to search, come back `wrong`, and
 * name a page it actually read.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";
import {
  CORRECTION_LABEL,
  CORRECTION_MAX_WORDS,
  type CandidateLogLine,
  type CandidateLogRecord,
  type VerificationLogRecord,
} from "../../shared/candidates.js";
import { EventBus } from "../events/bus.js";
import { SessionManager } from "../session/SessionManager.js";
import { SESSION_FILES, SessionStore } from "../session/SessionStore.js";

// `globalSetup` loads `.env` in the main process; a test file runs in a worker
// and has to load it for itself.
loadDotenv({ quiet: true });

const apiKey = (process.env.MODEL_API_KEY ?? "").trim();

/** A board call, an observer call and a search per update: the API's pace. */
const REPLAY_TIMEOUT_MS = 10 * 60_000;

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

const fixture = "moment-fact";

/** What one replayed conversation wrote to `candidates.jsonl`. */
interface Replayed {
  noticed: CandidateLogRecord[];
  checked: VerificationLogRecord[];
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
  const path = join(root, folders[0] as string, SESSION_FILES.candidates);
  // The log is only opened on the first append, so a missing file means the
  // observer noticed nothing at all — which for this fixture is the failure.
  expect(existsSync(path), `nothing was written to ${SESSION_FILES.candidates}`).toBe(true);
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CandidateLogLine);
  return {
    noticed: lines.filter((line): line is CandidateLogRecord => line.kind === "candidate"),
    checked: lines.filter((line): line is VerificationLogRecord => line.kind === "verification"),
  };
}

describe.skipIf(apiKey === "")(`the fact check after replaying ${fixture}`, () => {
  let root: string;
  let result: Replayed;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-verify-"));
    result = await replay(root, fixture);
  }, REPLAY_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("checks every factual error the observer passed on, and only those", () => {
    const errors = result.noticed
      .map((record) => record.candidate)
      .filter(
        (candidate) => candidate.type === "factual_error" && candidate.duplicateOf === undefined,
      );
    expect(
      errors.map((candidate) => candidate.headline),
      `no factual_error candidate among ${JSON.stringify(summary(result.noticed))}`,
    ).not.toHaveLength(0);

    const byId = new Map(errors.map((candidate) => [candidate.id, candidate]));
    for (const record of result.checked) {
      expect(byId.has(record.candidateId), `${record.candidateId} was checked unasked`).toBe(true);
    }
    expect(result.checked.map((record) => record.candidateId).sort()).toEqual(
      [...byId.keys()].sort(),
    );
  });

  it("finds the planted error wrong and cites a page it read", () => {
    const verified = result.checked.filter((record) => record.outcome === "verified");
    expect(
      verified.map((record) => ({ headline: record.headline, ...record.verification })),
      `nothing was verified; the checks came back ${JSON.stringify(outcomes(result.checked))}`,
    ).not.toHaveLength(0);

    const cited = verified.filter((record) => (record.verification?.citations ?? []).length > 0);
    expect(
      cited.map((record) => record.verification?.citations),
      `a verdict came back with no citations: ${JSON.stringify(verified, null, 2)}`,
    ).not.toHaveLength(0);

    for (const record of cited) {
      const verification = record.verification!;
      expect(verification.verdict).toBe("wrong");
      expect(verification.correction.trim(), record.headline).not.toBe("");
      expect(verification.correction.split(/\s+/).length).toBeLessThanOrEqual(
        CORRECTION_MAX_WORDS,
      );
      for (const citation of verification.citations) {
        expect(citation.url, record.headline).toMatch(/^https?:\/\//);
        expect(citation.title.trim(), citation.url).not.toBe("");
      }
    }
  });

  /**
   * The one error the fixture plants. If this fails while the test above
   * passes, the model checked something else in the conversation and missed
   * the launch year — a prompt problem, not a wiring one.
   */
  it("corrects the launch year the fixture gets wrong", () => {
    const corrections = result.checked
      .filter((record) => record.outcome === "verified")
      .map((record) => record.verification?.correction ?? "");
    expect(
      corrections,
      `no correction mentions 2010; got ${JSON.stringify(corrections)}`,
    ).toEqual(expect.arrayContaining([expect.stringContaining("2010")]));
  });

  it("passes the correction on to the policy inside the candidate's detail", () => {
    const verified = result.checked.filter((record) => record.outcome === "verified");
    expect(verified.length).toBeGreaterThan(0);
    // The candidate the policy (US-014) will see is the logged one plus the
    // correction; `candidates.jsonl` holds the halves, so check they join.
    for (const record of verified) {
      const noticed = result.noticed.find((line) => line.candidate.id === record.candidateId);
      expect(noticed, record.candidateId).toBeDefined();
      const detail = noticed!.candidate.detail;
      expect(detail.trim()).not.toBe("");
      expect(detail).not.toContain(CORRECTION_LABEL);
      expect(record.verification?.correction).not.toBe("");
    }
  });
});

/** `cand-1 factual_error: "…"` per record, for a failure message. */
function summary(records: readonly CandidateLogRecord[]): string[] {
  return records.map(
    (record) => `${record.candidate.id} ${record.candidate.type}: ${record.candidate.headline}`,
  );
}

function outcomes(records: readonly VerificationLogRecord[]): string[] {
  return records.map(
    (record) =>
      `${record.candidateId} ${record.outcome}` +
      `${record.verification === undefined ? "" : ` (${record.verification.verdict})`}` +
      `${record.error === undefined ? "" : ` (${record.error})`}`,
  );
}
