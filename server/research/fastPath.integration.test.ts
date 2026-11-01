/**
 * The fast path from a question to a packet, against the real model (V3-003).
 *
 * `offsite-plan` is replayed at `max` through an ordinary session — the same
 * pipeline a browser drives, nothing faked in between — and the question it
 * turns on is line 12, "Is it an hour and a half?", which V3-002's classifier
 * hears as an `open_question` about the drive time. What this checks is
 * everything that happens next and nothing that happened before: the idea
 * carries `origin: "open_question"`, **no gate verdict was ever asked for**,
 * a card went up while the search ran, and the packet that came back can be
 * said out loud.
 *
 * The one thing it cannot check is the PRD's twenty-five seconds. Simulated
 * time stands still inside a tracked model call, so a replay's
 * `questionToPacketMs` reads near zero however long the search really took;
 * `npm run e2e -- --fixtures offsite-plan` is the clock that charges for it.
 *
 * One replay in `beforeAll` with the assertions in instant `it` blocks, for
 * `packet.integration.test.ts`'s reason: a dozen sequential calls to a
 * reasoning model blow past the per-test timeout, and only `beforeAll`'s own
 * matters.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StageCard } from "../../shared/cards.js";
import {
  RESEARCH_LOOKING_PREFIX,
  type ResearchGateRecord,
  type ResearchIdeaRecord,
  type ResearchLogLine,
  type ResearchPacketRecord,
  type ResearchPendingRecord,
} from "../../shared/research.js";
import { EventBus } from "../events/bus.js";
import { glimmerFromEnv } from "../model/GlimmerClient.js";
import { SessionManager } from "../session/SessionManager.js";
import { SESSION_FILES, SessionStore } from "../session/SessionStore.js";

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
let records: ResearchLogLine[] = [];
const cards: StageCard[] = [];

/** Every idea the session had, and the ones nobody repeated. */
const ideas = (): ResearchIdeaRecord[] =>
  records.filter((record): record is ResearchIdeaRecord => record.kind === "idea");

const questions = (): ResearchIdeaRecord[] =>
  ideas().filter((record) => record.origin === "open_question");

describeSpark("the fast path from an open question (V3-003)", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-fast-path-"));
    const bus = new EventBus(quiet);
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
    });
    const sessions = new SessionManager({
      bus,
      apiKey,
      logger: loud,
      replaySpeed: "max",
      createStore: (info) => SessionStore.create(info, { root, logger: quiet }),
      // Exactly what the server does: Glimmer when this Mac is serving one.
      // It gates the planner's and the observer's ideas; a question's idea is
      // the one thing it is never asked about.
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
    sessions.start({ kind: "events", fixture: "offsite-plan" });
    await ended;

    const folders = readdirSync(root);
    records = readFileSync(join(root, folders[0] as string, SESSION_FILES.research), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as ResearchLogLine);
  }, 20 * 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("turns what the room wondered aloud into an idea, with no gate call", () => {
    const asked = questions();
    process.stderr.write(
      `[fast path] ${asked.length} question idea(s): ${asked
        .map((record) => `${record.idea.id} [${record.idea.topic}] ${record.idea.question}`)
        .join(" | ")}\n`,
    );
    expect(asked.length, "nothing the room wondered aloud reached the research manager")
      .toBeGreaterThan(0);
    for (const record of asked) {
      expect(record.idea.askedAtMs, "a question's idea carries when it was asked").toBeDefined();
      expect(record.idea.sourceTurnIds.length).toBeGreaterThan(0);
      expect(record.idea.question).not.toBe("");
      expect(record.idea.topic).not.toBe("");
    }

    // The whole point of the path: the classifier already made this judgment,
    // so a second one would only be latency. A hook or a planner idea beside
    // it is still gated.
    const gated = records.filter((r): r is ResearchGateRecord => r.kind === "gate");
    const fromQuestions = new Set(asked.map((record) => record.idea.id));
    process.stderr.write(
      `[fast path] gate: ${
        gated
          .map((r) => `${r.ideaId} ${r.decision} ${r.score.toFixed(2)} on ${r.where ?? "nothing"}`)
          .join(" | ") || "nothing was gated"
      }\n`,
    );
    expect(gated.filter((record) => fromQuestions.has(record.ideaId))).toEqual([]);
  });

  it("puts a card on the stage while the search runs, and fills that card in", () => {
    const pendings = records.filter(
      (record): record is ResearchPendingRecord => record.kind === "pending",
    );
    const accepted = questions().filter((record) => record.duplicateOf === undefined);
    expect(pendings.map((record) => record.ideaId)).toEqual(
      accepted.map((record) => record.idea.id),
    );

    for (const pending of pendings) {
      const thinking = cards.find(
        (card) => card.id === pending.cardId && card.state === "thinking",
      );
      expect(thinking, `no thinking card for ${pending.ideaId}`).toBeDefined();
      expect(thinking?.variant).toBe("research");
      expect(thinking?.headline).toContain(RESEARCH_LOOKING_PREFIX);
      // The question itself is on the card, so the room can see what Sotto
      // thought it heard.
      expect(thinking?.headline).toContain(pending.question.slice(0, 20));
    }

    // Whatever the search came back with, the spinner stopped.
    for (const pending of pendings) {
      const last = [...cards].reverse().find((card) => card.id === pending.cardId);
      expect(last?.state, `${pending.cardId} is still thinking`).not.toBe("thinking");
    }
  });

  it("comes back with an answer that can be said out loud", () => {
    const packets = records.filter((r): r is ResearchPacketRecord => r.kind === "packet");
    const fromQuestions = new Set(questions().map((record) => record.idea.id));
    const asked = packets.filter((record) => fromQuestions.has(record.ideaId));
    process.stderr.write(
      `[fast path] ${asked.length} job(s) from a question: ${asked
        .map(
          (r) =>
            `${r.outcome} in ${r.latencyMs} ms — ${JSON.stringify(
              r.packet?.spokenAnswer ?? r.title ?? r.error ?? "",
            )}`,
        )
        .join(" | ")}\n`,
    );
    const ready = asked.filter((record) => record.outcome === "ready");
    expect(ready.length, "no packet came back for anything the room wondered").toBeGreaterThan(0);

    for (const record of ready) {
      const spoken = record.packet?.spokenAnswer ?? "";
      expect(spoken, "a sourced packet has a line to say").not.toBe("");
      // Written to be heard: no URL, no bullet list, and short.
      expect(spoken).not.toMatch(/https?:\/\/|www\./);
      expect(spoken).not.toContain("\n");
      expect(spoken.split(/\s+/).length).toBeLessThanOrEqual(45);
      expect(record.packet?.sources.length ?? 0).toBeGreaterThan(0);
      // The latency is recorded, but a replay's clock does not move inside a
      // call: `npm run e2e` is where the number means something.
      expect(record.questionToPacketMs).toBeDefined();
    }
  });
});
