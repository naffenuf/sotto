/**
 * The knowledge folder against the real model (PRD V3-009).
 *
 * Two halves, each one real call, both against `fixtures/knowledge-demo/` —
 * the fictional company whose customer list, price sheet and notes nothing on
 * the web knows anything about. That is the point: a question answered from
 * that folder cannot have been answered from the web, so a `file:` citation
 * is proof the tool was used rather than a coincidence.
 *
 * What is really under test is two prompts. The JSON Schema fixes the keys
 * and the types; whether the model searches the files *first*, believes what
 * it finds about the group's own business, and phrases a correction as the
 * file's own, is `research-packet.md` and `verify-knowledge.md`.
 *
 * The calls are made in `beforeAll` with its own timeout, because a grounded
 * call with tools runs several rounds and `vitest.integration.config.ts`'s
 * per-test timeout is 60 s; the `it` blocks are then instant.
 */
import { config as loadDotenv } from "dotenv";
import { beforeAll, describe, expect, it } from "vitest";
import type { Candidate, VerificationLogRecord } from "../../shared/candidates.js";
import { isKnowledgeCitation } from "../../shared/knowledge.js";
import { FREQUENCY_LIMITS } from "../../shared/policy.js";
import type { ResearchPacket, ResearchPacketRecord } from "../../shared/research.js";
import { SimulatedClock } from "../clock.js";
import { spokenCorrection } from "../interject/corrections.js";
import type { Interjection } from "../interject/InterjectionPolicy.js";
import { Verifier } from "../interject/Verifier.js";
import { MuseClient } from "../model/client.js";
import { ResearchRunner } from "../research/ResearchRunner.js";
import { KnowledgeIndex } from "./KnowledgeIndex.js";

// `globalSetup` runs in the main process; a test file runs in a worker.
loadDotenv({ quiet: true });

const apiKey = (process.env["MODEL_API_KEY"] ?? "").trim();
const describeSpark = apiKey === "" ? describe.skip : describe;

const quiet = { log: () => {}, warn: () => {} };
const loud = {
  log: (line: unknown) => process.stderr.write(`${String(line)}\n`),
  warn: (line: unknown) => process.stderr.write(`${String(line)}\n`),
};

const DEMO = "fixtures/knowledge-demo";

function knowledge(): KnowledgeIndex {
  const index = KnowledgeIndex.load(DEMO, { logger: quiet });
  if (index === null) throw new Error(`${DEMO} holds no readable files`);
  return index;
}

function model(): MuseClient {
  return new MuseClient({ apiKey, logger: quiet });
}

describeSpark("answering an open question from the group's own files", () => {
  let packet: ResearchPacket | null = null;
  let records: ResearchPacketRecord[] = [];

  beforeAll(async () => {
    const clock = new SimulatedClock(120_000);
    const runner = new ResearchRunner({
      clock,
      model: model(),
      knowledge: knowledge(),
      logger: loud,
      onRecord: (record) => records.push(record),
    });
    // The fast path's shape (V3-003): the room wondered it aloud, the
    // classifier cleaned it up, and the search starts at once.
    packet = await runner.run({
      id: "idea-1",
      topic: "Harborview renewal date",
      question: "When does Harborview Clinic's contract renew?",
      why: "they are planning the quarter around which accounts are up",
      sourceTurnIds: ["0:4"],
      askedAtMs: 118_000,
    });
  }, 5 * 60_000);

  it("comes back sourced, and the source is the file", () => {
    expect(records[0]?.outcome, JSON.stringify(records[0])).toBe("ready");
    expect(packet).not.toBeNull();
    const files = (packet?.sources ?? []).filter((source) => isKnowledgeCitation(source.url));
    expect(files.map((source) => source.url)).toContain("file:customers.csv");
  });

  it("answers with the date that is in the file", () => {
    const text = `${packet?.title ?? ""} ${packet?.teaser ?? ""} ${(packet?.keyPoints ?? []).join(" ")}`;
    // 2027-03-01, however the model chose to write it.
    expect(text).toMatch(/2027/);
    expect(text).toMatch(/March|03-01|3\/1|01\/03/i);
  });

  it("has something to say out loud about it (V3-004)", () => {
    const spoken = packet?.spokenAnswer ?? "";
    expect(spoken).not.toBe("");
    // Written to be heard, so the year may be spelled out ("twenty
    // twenty-seven") — measured, and the right call for a spoken line.
    expect(spoken).toMatch(/2027|twenty twenty[- ]seven/i);
    // Written to be heard: no URL, no file name read aloud.
    expect(spoken).not.toMatch(/https?:/);
  });
});

describeSpark("a correction out of the group's own files", () => {
  const records: VerificationLogRecord[] = [];
  const verified: Candidate[] = [];

  /**
   * The claim: Pro at $49 a seat. The demo's `notes.md` says it was $49 for
   * two quarters of 2026 and came down to $40 in July, and `prices.csv` has
   * it at 40 — so the files settle it and the web could not.
   */
  const candidate: Candidate = {
    id: "cand-1",
    createdAtMs: 60_000,
    run: 2,
    type: "factual_error",
    headline: "Pro is $40 a seat, not $49",
    detail: "The quote being built rests on a price that came down in July.",
    whyNow: "a quote is being put together on that number",
    evidenceTurnIds: ["0:11"],
    evidence: [
      {
        turnId: "0:11",
        speaker: "A",
        quote: "Pro is forty-nine dollars a seat a month, so forty-five seats is about two thousand two hundred.",
      },
    ],
    relatedBoardItemIds: [],
    scores: { relevance: 0.9, novelty: 0.8, importance: 0.9, confidence: 0.7 },
  };

  beforeAll(async () => {
    const verifier = new Verifier({
      clock: new SimulatedClock(70_000),
      model: model(),
      knowledge: knowledge(),
      logger: loud,
      onRecord: (record) => records.push(record),
      onVerified: (one) => verified.push(one),
    });
    verifier.verify(candidate);
    await verifier.flush();
  }, 5 * 60_000);

  it("is settled by the file, with no web search", () => {
    const verification = records[0]?.verification;
    expect(records[0]?.outcome, JSON.stringify(records[0])).toBe("verified");
    expect(verification?.verdict).toBe("wrong");
    expect(verification?.searched).toBe(false);
    expect(["prices.csv", "notes.md"]).toContain(verification?.file);
    expect(verification?.citations.map((one) => one.url)).toEqual([
      `file:${verification?.file ?? ""}`,
    ]);
  });

  it("says what the file says, in the file's own words", () => {
    const correction = records[0]?.verification?.correction ?? "";
    expect(correction).toMatch(/\$?40/);
    expect(correction.split(/\s+/).length).toBeLessThanOrEqual(30);
  });

  it("is the one correction a session at the default boldness says out loud", () => {
    const one = verified[0];
    expect(one, "the candidate did not reach the policy").toBeDefined();
    if (one === undefined) return;
    const interjection: Interjection = {
      candidate: one,
      level: "interject",
      atMs: 71_000,
      decision: {
        decision: "interject",
        reason: "delivered",
        score: 0.7,
        level: "interject",
        thresholds: { glow: 0.25, interject: 0.45 },
        limits: FREQUENCY_LIMITS.normal,
        settings: { frequency: "normal", boldness: "normal" },
      },
    };
    const line = spokenCorrection(interjection);
    process.stderr.write(`[V3-009] spoken at normal: ${String(line)}\n`);
    expect(line).not.toBeNull();
    // Either `From <file>: …` or a sentence that already named the file.
    expect(line?.toLowerCase()).toContain((one.verification?.file ?? "").toLowerCase());
  });
});
