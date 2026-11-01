/**
 * The digest after a real conversation (V2-018).
 *
 * `offsite-plan` is replayed at `max` with a real model client, so the
 * observer really notices things, the policy really holds most of them back
 * and the research pipeline really runs — and then `digest.md` is read off
 * the disk. `max` is what makes it affordable: simulated time skips the
 * silences and stops dead at every tracked model call.
 *
 * What it checks is the thing no unit test can: that a digest written from a
 * conversation nobody scripted for it still has all seven sections, and that
 * "what Sotto almost said" has something in it with a reason beside it.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";
import type { CandidateLogLine } from "../../shared/candidates.js";
import { EventBus } from "../events/bus.js";
import { SessionManager } from "./SessionManager.js";
import { SESSION_FILES, SessionStore } from "./SessionStore.js";
import { DIGEST_SECTIONS, NOTHING } from "./digest.js";

// `globalSetup` loads `.env` in the main process; a test file runs in a
// worker and has to load it for itself.
loadDotenv({ quiet: true });

const apiKey = (process.env.MODEL_API_KEY ?? "").trim();

/** Nine board updates, nine observer looks and a search or two, in series. */
const REPLAY_TIMEOUT_MS = 15 * 60_000;

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(apiKey === "")("the digest after replaying offsite-plan", () => {
  let root: string;
  let digest: string;
  let candidates: CandidateLogLine[];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-digest-"));
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
    sessions.start({ kind: "events", fixture: "offsite-plan" });
    await ended;

    const folders = readdirSync(root);
    expect(folders).toHaveLength(1);
    const dir = join(root, folders[0] as string);
    digest = readFileSync(join(dir, SESSION_FILES.digest), "utf8");
    candidates = readFileSync(join(dir, SESSION_FILES.candidates), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as CandidateLogLine);
  }, REPLAY_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes all seven sections", () => {
    for (const section of DIGEST_SECTIONS) expect(digest).toContain(`## ${section}`);
  });

  it("summarizes the conversation off the board", () => {
    const summary = section("Summary");
    expect(summary).not.toBe(NOTHING);
    expect(summary.length).toBeGreaterThan(20);
  });

  it("lists at least one held-back candidate with the reason it was held back", () => {
    const held = section("What Sotto almost said");
    expect(
      held,
      `nothing was held back; candidates.jsonl had ${candidates.length} line(s)`,
    ).not.toBe(NOTHING);
    const lines = held.split("\n").filter((line) => line.startsWith("- **"));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(5);
    for (const line of lines) {
      // `- **headline** — reason _(type, score 0.42)_`
      expect(line).toMatch(/^- \*\*.+\*\* — .+ _\(.+, score \d\.\d\d\)_$/);
    }
  });

  /** One section of the digest, without its heading. */
  function section(name: string): string {
    const start = digest.indexOf(`## ${name}\n`);
    expect(start, `no ${name} section`).toBeGreaterThanOrEqual(0);
    const body = digest.slice(start + `## ${name}\n`.length);
    const next = body.indexOf("\n## ");
    return (next === -1 ? body : body.slice(0, next)).trim();
  }
});
