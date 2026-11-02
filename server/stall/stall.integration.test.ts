/**
 * V3-007 against the real model: a group going round in circles, and a group
 * that is not.
 *
 * `stalled-naming` is the fixture with the stall planted in it — a pair with
 * three candidate names, agreeing for the third time that one is taken, one
 * is unspellable and one is unsayable, and then saying out loud that they are
 * stuck. `brainstorm` is the control: a long, productive conversation that
 * wanders and repeats itself the way a good one does, and must produce no
 * stall offer at all.
 *
 * Both are ordinary `max`-speed replays through a real `SessionManager`, with
 * nothing faked between the capture and the offer. Two replays in `beforeAll`
 * with instant `it` blocks, for `packet.integration.test.ts`'s reason: a
 * dozen sequential calls to a reasoning model blow past a per-test timeout,
 * and only `beforeAll`'s own matters.
 *
 * What it cannot check is the yes — whether the turn right after the offer is
 * read as taking it up depends on where in the conversation the offer lands,
 * and that moves with the model. The accept path is exercised offline, end to
 * end, in `server/session/SessionManager.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CandidateLogLine, CandidateLogRecord } from "../../shared/candidates.js";
import { defaultPolicySettings } from "../../shared/policy.js";
import type { SpokenContributionRecord } from "../../shared/spoken.js";
import type { StallLogRecord } from "../../shared/stall.js";
import { glimmerFromEnv } from "../model/GlimmerClient.js";
import { replayFixture } from "../eval/runner.js";
import { SESSION_FILES } from "../session/SessionStore.js";

// `globalSetup` runs in the main process; a test file runs in a worker.
loadDotenv({ quiet: true });

const apiKey = (process.env["MODEL_API_KEY"] ?? "").trim();
const describeSpark = apiKey === "" ? describe.skip : describe;

const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const loud = {
  log: (line: unknown) => process.stderr.write(`${String(line)}\n`),
  warn: (line: unknown) => process.stderr.write(`${String(line)}\n`),
  error: (line: unknown) => process.stderr.write(`${String(line)}\n`),
};

interface Replayed {
  /** Every `stall` line of `timing.jsonl`: one per noticed loop. */
  stalls: StallLogRecord[];
  /** The `offer_window` and `offer_reply` lines, so the yes can be read. */
  window: Record<string, unknown>[];
  /** The `spoken_contribution` lines, so the offer can be read back. */
  spoken: SpokenContributionRecord[];
  /** Every candidate the observer proposed, duplicates included. */
  candidates: CandidateLogRecord[];
}

let root: string;
let stuck: Replayed;
let productive: Replayed;

function read(sessionDir: string | null, spoken: SpokenContributionRecord[]): Replayed {
  const lines = (file: string): unknown[] =>
    sessionDir === null
      ? []
      : readFileSync(join(sessionDir, file), "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as unknown);
  let candidates: CandidateLogRecord[] = [];
  try {
    candidates = (lines(SESSION_FILES.candidates) as CandidateLogLine[]).filter(
      (line): line is CandidateLogRecord => line.kind === "candidate",
    );
  } catch {
    // A conversation nobody noticed anything in has no `candidates.jsonl`:
    // `SessionStore` only opens a log on the first append.
  }
  const timing = lines(SESSION_FILES.timing) as Record<string, unknown>[];
  const stalls = timing
    .filter((line) => line["stage"] === "stall")
    .map((line) => line as unknown as StallLogRecord);
  const window = timing.filter(
    (line) =>
      line["stage"] === "offer_window" ||
      line["stage"] === "offer_reply" ||
      line["stage"] === "offer_accepted",
  );
  return { stalls, window, spoken, candidates };
}

async function replay(fixture: string): Promise<Replayed> {
  const result = await replayFixture({
    fixture,
    settings: defaultPolicySettings(),
    sessionRoot: root,
    apiKey,
    // Exactly what the server does: Glimmer when this Mac is serving one. It
    // gates research ideas; a stall never reaches it (V3-001, V3-007).
    createGlimmer: () => glimmerFromEnv(quiet),
    logger: loud,
  });
  return read(result.sessionDir, result.spokenLog);
}

describeSpark("the offer of ideas to a stuck group (V3-007)", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-stall-"));
    stuck = await replay("stalled-naming");
    productive = await replay("brainstorm");
  }, 25 * 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("notices the planted stall and offers a few ideas", () => {
    const noticed = stuck.candidates.filter((record) => record.candidate.type === "stall");
    process.stderr.write(
      `[stall] stalled-naming: ${noticed.length} stall candidate(s): ${noticed
        .map((record) => `${record.candidate.id} ${record.candidate.headline}`)
        .join(" | ")}\n`,
    );
    process.stderr.write(
      `[stall] outcomes: ${stuck.stalls
        .map((record) => `${record.candidateId} ${record.outcome} ${record.latencyMs ?? "-"}ms`)
        .join(" | ")}\n`,
    );
    expect(noticed.length, "the observer noticed no stall in a conversation about one")
      .toBeGreaterThan(0);
    // The stall left the interjection path: every one of them reached here.
    expect(stuck.stalls.length).toBeGreaterThan(0);
    const offered = stuck.stalls.filter((record) => record.outcome === "offered");
    expect(offered.length, "a noticed stall produced no offer").toBe(1);
    const ideas = offered[0]?.ideas ?? [];
    process.stderr.write(`[stall] ideas on "${offered[0]?.topic}": ${ideas.join(" / ")}\n`);
    expect(ideas.length).toBeGreaterThan(0);
    expect(ideas.length).toBeLessThanOrEqual(3);
    for (const idea of ideas) expect(idea).not.toMatch(/https?:|^[-*]\s/);
  });

  it("offers them as a statement, and says nothing about them unasked", () => {
    const offers = stuck.spoken.filter((record) => record.kind === "offer");
    const stallOffers = offers.filter((record) => record.ideaId.startsWith("stall-"));
    process.stderr.write(
      `[stall] offer lines: ${stallOffers
        .map((record) => `${record.spoken ? "said" : `skipped (${record.reason})`}: ${record.text}`)
        .join(" | ")}\n`,
    );
    expect(stallOffers).toHaveLength(1);
    expect(stallOffers[0]?.text).toMatch(/^I've got a few ideas on .+ if they'd help\.$/);
    expect(stallOffers[0]?.text).not.toContain("?");
    process.stderr.write(
      `[stall] window: ${stuck.window
        .map((line) => `${String(line["stage"])}=${String(line["outcome"] ?? line["kind"] ?? line["event"])}`)
        .join(" | ")}\n`,
    );
    // Nothing is said about the ideas themselves unless somebody says yes,
    // and nobody reliably does in a scripted conversation.
    const said = stuck.spoken.filter((record) => record.kind === "ideas" && record.spoken);
    if (said.length === 0) {
      expect(stuck.spoken.filter((record) => record.kind === "ideas")).toEqual([]);
    } else {
      expect(said[0]?.text).toContain("A few thoughts on");
    }
  });

  it("offers a conversation that is merely wandering nothing at all", () => {
    const noticed = productive.candidates.filter((record) => record.candidate.type === "stall");
    process.stderr.write(
      `[stall] brainstorm: ${productive.candidates.length} candidate(s), ` +
        `${noticed.length} of them stalls\n`,
    );
    expect(noticed, "brainstorm is a productive conversation, not a stuck one").toEqual([]);
    expect(productive.stalls).toEqual([]);
    expect(
      productive.spoken.filter(
        (record) => record.kind === "offer" && record.ideaId.startsWith("stall-"),
      ),
    ).toEqual([]);
    expect(productive.spoken.filter((record) => record.kind === "ideas")).toEqual([]);
  });
});
