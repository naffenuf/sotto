/**
 * The research runner against the real model (V2-013).
 *
 * `research-business-idea` is replayed at `max` through an ordinary session —
 * the same pipeline a browser drives, with nothing faked in between — and
 * what is checked is the one thing the PRD asks of this story: by the time
 * somebody at the end of that conversation says "Sotto, what did you find on
 * competitors?", there is at least one **sourced** packet waiting for them.
 *
 * It is one replay in `beforeAll` with the assertions in instant `it` blocks,
 * because the replay is a dozen sequential calls to a reasoning model and
 * `vitest.integration.config.ts`'s per-test timeout is 60 s: only
 * `beforeAll`'s own timeout matters. Reaching a packet costs the board loop,
 * the observer, the gate and the search itself, so it is deliberately one
 * run — read `research.jsonl` in the session folder it leaves behind before
 * paying for a second.
 *
 * The gate goes through V2-010's router, so it runs on local Glimmer when the
 * Ollama server is up and on Muse Spark when it is not; both are a pass.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ResearchGateRecord,
  type ResearchIdeaRecord,
  type ResearchLogLine,
  type ResearchPacketRecord,
} from "../../shared/research.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { EventBus } from "../events/bus.js";
import { glimmerFromEnv } from "../model/GlimmerClient.js";
import { SessionManager } from "../session/SessionManager.js";
import { SESSION_FILES, SessionStore } from "../session/SessionStore.js";
import { detectsAddress } from "../wake.js";

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

let root: string;
let dir: string;
let records: ResearchLogLine[] = [];
let finals: TurnUpdate[] = [];

describeSpark("researching research-business-idea end to end", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-research-packet-"));
    const bus = new EventBus(quiet);
    bus.subscribe((event) => {
      if (event.type === "turn" && event.turn.final && !isSottoTurn(event.turn)) {
        finals.push(event.turn);
      }
    });
    const sessions = new SessionManager({
      bus,
      apiKey,
      logger: loud,
      replaySpeed: "max",
      createStore: (info) => SessionStore.create(info, { root, logger: quiet }),
      // Exactly what the server does: Glimmer when this Mac is serving one.
      createGlimmer: () => glimmerFromEnv(quiet),
    });

    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "research-business-idea" });
    await ended;

    const folders = readdirSync(root);
    dir = join(root, folders[0] as string);
    records = readFileSync(join(dir, SESSION_FILES.research), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as ResearchLogLine);
  }, 20 * 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("has ideas and a gate verdict for each of them", () => {
    const ideas = records.filter((r): r is ResearchIdeaRecord => r.kind === "idea");
    const gated = records.filter((r): r is ResearchGateRecord => r.kind === "gate");
    process.stderr.write(
      `[research] ${ideas.length} idea(s): ${ideas
        .map((r) => `${r.idea.id} (${r.origin}) ${r.idea.question}`)
        .join(" | ")}\n` +
        `[research] gate: ${gated
          .map((r) => `${r.ideaId} ${r.decision} ${r.score.toFixed(2)} on ${r.where ?? "nothing"}`)
          .join(" | ")}\n`,
    );
    expect(ideas.length, "nothing was proposed to look up").toBeGreaterThan(0);
    const fresh = ideas.filter((r) => r.duplicateOf === undefined);
    expect(gated.map((r) => r.ideaId)).toEqual(fresh.map((r) => r.idea.id));
  });

  it("produces at least one sourced packet before the wake question", () => {
    const packets = records.filter((r): r is ResearchPacketRecord => r.kind === "packet");
    process.stderr.write(
      `[research] ${packets.length} job(s): ${packets
        .map((r) => `${r.outcome} in ${r.latencyMs} ms at ${Math.round(r.atMs / 1000)}s — ${r.packet?.title ?? r.title ?? r.error ?? ""}`)
        .join(" | ")}\n`,
    );
    const ready = packets.filter((r) => r.outcome === "ready");
    expect(ready.length, "no packet came back").toBeGreaterThan(0);

    // The question at the end of the fixture: the first final turn that
    // addresses Sotto. The spelling varies — `fixtures/events/NOTES.md`.
    const asked = finals.find((turn) => detectsAddress(turn.text));
    expect(asked, "the wake question never arrived").toBeDefined();
    const deadline = (asked as TurnUpdate).startMs;
    const inTime = ready.filter((r) => (r.packet?.createdAtMs ?? Infinity) < deadline);
    process.stderr.write(
      `[research] wake question at ${Math.round(deadline / 1000)}s; ` +
        `${inTime.length} packet(s) ready before it\n`,
    );
    expect(inTime.length, "every packet landed after the question").toBeGreaterThan(0);

    const packet = inTime[0]?.packet;
    expect(packet?.sources.length ?? 0).toBeGreaterThan(0);
    expect(packet?.teaser).not.toBe("");
    expect(packet?.title).not.toBe("");
    for (const source of packet?.sources ?? []) {
      expect(source.url).toMatch(/^https?:\/\//);
      expect(source.title).not.toBe("");
    }
  });

  it("writes each sourced packet into the session folder, as JSON and markdown", () => {
    const ready = records.filter(
      (r): r is ResearchPacketRecord => r.kind === "packet" && r.outcome === "ready",
    );
    for (const record of ready) {
      const id = record.packet?.id as string;
      const saved = JSON.parse(readFileSync(join(dir, "research", `${id}.json`), "utf8"));
      expect(saved).toEqual(record.packet);
      const markdown = readFileSync(join(dir, "research", `${id}.md`), "utf8");
      expect(markdown).toContain(record.packet?.title as string);
      expect(markdown).toContain("## Sources");
    }
  });
});
