import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionLogRecord } from "../../shared/candidates.js";
import type { StageCard } from "../../shared/cards.js";
import { FREQUENCY_LIMITS } from "../../shared/policy.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { ENDPOINTER_HANGOVER_MS } from "../asr/turns.js";
import { PAUSE_MS } from "../interject/policy.js";
import { SESSION_FILES } from "../session/SessionStore.js";
import {
  deliveredDecisions,
  deliveriesFrom,
  readCandidateLog,
  replayFixture,
  runFixture,
  type ReplayResult,
} from "./runner.js";

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/** No model client at all: the replay transcribes and notices nothing. */
const noModel = () => null;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sotto-eval-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("replayFixture", () => {
  it("replays a capture to the end and saves it like any other session", async () => {
    const result = await replayFixture({
      fixture: "brainstorm",
      settings: { frequency: "normal", boldness: "normal" },
      sessionRoot: root,
      createModel: noModel,
      logger: quiet,
    });

    const finals = result.turns.filter((turn) => turn.final);
    expect(finals.length).toBeGreaterThan(10);
    expect(result.durationMs).toBeGreaterThan(60_000);
    // Nothing can be noticed without a model, so nothing reaches the stage.
    expect(result.cards).toEqual([]);
    expect(result.candidates).toBe(0);
    expect(result.decisions).toBe(0);

    expect(result.sessionDir).not.toBeNull();
    expect(readdirSync(root)).toHaveLength(1);
    expect(readdirSync(result.sessionDir as string)).toContain(SESSION_FILES.transcript);
  }, 60_000);
});

describe("runFixture", () => {
  it("places a fixture's planted moments against the turns the replay produced", async () => {
    const run = await runFixture({
      fixture: "moment-contradiction",
      settings: { frequency: "normal", boldness: "cautious" },
      sessionRoot: root,
      createModel: noModel,
      logger: quiet,
    });

    expect(run.error).toBeUndefined();
    expect(run.settings).toEqual({ frequency: "normal", boldness: "cautious" });
    expect(run.finalTurns).toBeGreaterThan(10);
    expect(run.moments).toHaveLength(1);
    const moment = run.moments[0];
    expect(moment?.expectedLevel).toBe("interject");
    expect(moment?.triggerEndMs).toBeGreaterThan(0);
    // The capture really contains the planted lines, so both windows resolve
    // to turns the assembler produced.
    expect(moment?.setupTurnIds.length).toBeGreaterThan(0);
    expect(moment?.triggerTurnIds.length).toBeGreaterThan(0);
    expect(moment?.triggerTurnEndMs).not.toBeNull();
    // No model, so nothing was delivered and there is nothing to judge.
    expect(run.deliveries).toEqual([]);
    expect(run.matches).toEqual([]);
  }, 60_000);

  it("records a replay that could not start rather than throwing", async () => {
    const run = await runFixture({
      fixture: "no-such-fixture",
      settings: { frequency: "normal", boldness: "normal" },
      sessionRoot: root,
      createModel: noModel,
      logger: quiet,
    });
    expect(run.error).toContain("no-such-fixture");
    expect(run.deliveries).toEqual([]);
    expect(run.finalTurns).toBe(0);
  });
});

describe("readCandidateLog and deliveredDecisions", () => {
  function decision(partial: Partial<DecisionLogRecord>): DecisionLogRecord {
    return {
      kind: "decision",
      atMs: 1_000,
      candidateId: "cand-1",
      headline: "a headline",
      type: "contradiction",
      heldForMs: 0,
      turnsWaited: 0,
      decision: "hold",
      reason: "waiting_for_pause",
      score: 0.7,
      level: "interject",
      thresholds: { glow: 0.35, interject: 0.6 },
      limits: FREQUENCY_LIMITS.normal,
      settings: { frequency: "normal", boldness: "normal" },
      ...partial,
    };
  }

  it("is empty for a session with no folder, and for one that never opened the log", () => {
    expect(readCandidateLog(null)).toEqual([]);
    expect(readCandidateLog(root)).toEqual([]);
  });

  it("skips a half-written last line rather than failing on it", () => {
    const dir = join(root, "session");
    mkdirSync(dir);
    const lines = [
      JSON.stringify(decision({})),
      JSON.stringify(decision({ decision: "interject", reason: "delivered", atMs: 9_000 })),
      '{"kind":"decision",',
    ];
    writeFileSync(join(dir, SESSION_FILES.candidates), `${lines.join("\n")}\n`);
    expect(readCandidateLog(dir)).toHaveLength(2);
  });

  it("keeps the decision that put a candidate on the stage, not the holds before it", () => {
    const delivered = deliveredDecisions([
      decision({}),
      decision({ decision: "interject", reason: "delivered", atMs: 9_000 }),
      decision({ candidateId: "cand-2", decision: "silent", reason: "below_threshold" }),
      decision({ candidateId: "cand-3", decision: "glow", reason: "cooldown", atMs: 12_000 }),
    ]);
    expect([...delivered.keys()]).toEqual(["cand-1", "cand-3"]);
    expect(delivered.get("cand-1")?.atMs).toBe(9_000);
    expect(delivered.get("cand-3")?.reason).toBe("cooldown");
  });
});

describe("deliveriesFrom", () => {
  function turn(turnId: string, startMs: number, endMs: number): TurnUpdate {
    return {
      turnId,
      speaker: "A",
      text: "words",
      final: true,
      startMs,
      endMs,
      speakerMappingUncertain: false,
    };
  }

  function card(partial: Partial<StageCard>): StageCard {
    return {
      id: "card-cand-1",
      variant: "interject",
      state: "ready",
      createdAtMs: 12_000,
      headline: "the budget does not add up",
      detailMd: "four thousand against five",
      whyNow: "before it is agreed",
      ...partial,
    };
  }

  const turns = [turn("0:0", 1_000, 4_000), turn("0:1", 6_000, 9_000)];

  function result(partial: Partial<ReplayResult>): ReplayResult {
    return {
      turns,
      cards: [],
      sessionDir: null,
      durationMs: 9_000,
      candidates: 0,
      decisions: 0,
      gateCalls: [],
      delivered: new Map(),
      ...partial,
    };
  }

  it("reads a card's level, time and words, and the decision behind it", () => {
    const decided: DecisionLogRecord = {
      kind: "decision",
      atMs: 12_000,
      candidateId: "cand-1",
      headline: "the budget does not add up",
      type: "contradiction",
      heldForMs: 3_000,
      turnsWaited: 1,
      decision: "interject",
      reason: "delivered",
      score: 0.81,
      level: "interject",
      thresholds: { glow: 0.35, interject: 0.6 },
      limits: FREQUENCY_LIMITS.normal,
      settings: { frequency: "normal", boldness: "normal" },
    };
    const [delivery] = deliveriesFrom(
      result({ cards: [card({})], delivered: new Map([["cand-1", decided]]) }),
    );
    expect(delivery).toMatchObject({
      cardId: "card-cand-1",
      candidateId: "cand-1",
      type: "contradiction",
      level: "interject",
      deliveredAtMs: 12_000,
      reason: "delivered",
      score: 0.81,
      inPause: true,
    });
    expect(delivery?.pause).toEqual({
      speaking: false,
      silentForMs: 3_000 + ENDPOINTER_HANGOVER_MS,
    });
  });

  it("measures the pause itself rather than trusting the policy", () => {
    // Mid-turn, which the policy should never do: the harness has to be able
    // to say so.
    const [delivery] = deliveriesFrom(result({ cards: [card({ createdAtMs: 7_000 })] }));
    expect(delivery?.inPause).toBe(false);
    expect(delivery?.pause.speaking).toBe(true);
    // And a gap too short to count as a pause is not one either. The length
    // is `PAUSE_MS` rather than a number, so tuning the threshold (US-023)
    // moves the boundary this test is about instead of breaking it — less the
    // hangover, since the room was already quiet when the turn closed.
    const tooSoonAtMs = 9_000 + PAUSE_MS - ENDPOINTER_HANGOVER_MS - 1;
    const [tooSoon] = deliveriesFrom(result({ cards: [card({ createdAtMs: tooSoonAtMs })] }));
    expect(tooSoon?.inPause).toBe(false);
    expect(tooSoon?.pause).toEqual({ speaking: false, silentForMs: PAUSE_MS - 1 });
  });

  it("takes a glow as a delivery and leaves an answer card alone", () => {
    const deliveries = deliveriesFrom(
      result({
        cards: [
          card({ id: "card-cand-2", variant: "glow" }),
          card({ id: "answer-1", variant: "answer" }),
        ],
      }),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ cardId: "card-cand-2", level: "glow", type: null });
  });
});
