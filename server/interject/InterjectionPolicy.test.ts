import { describe, expect, it } from "vitest";
import type { Candidate, CandidateScores, DecisionLogRecord } from "../../shared/candidates.js";
import type { Chattiness } from "../../shared/policy.js";
import type { PauseState, TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import { InterjectionPolicy, type Interjection } from "./InterjectionPolicy.js";
import {
  COOLDOWN_MS,
  COURTESY_MS,
  MAX_INTERJECTS_PER_WINDOW,
  PAUSE_MS,
  STALE_MS,
  STALE_TURNS,
} from "./policy.js";

/** Scores that multiply out to `score` exactly, through confidence alone. */
function scoring(score: number): CandidateScores {
  return { relevance: 1, novelty: 1, importance: 1, confidence: score };
}

let nextId = 0;

function candidate(score: number, overrides: Partial<Candidate> = {}): Candidate {
  nextId += 1;
  return {
    id: `cand-${nextId}`,
    createdAtMs: 0,
    run: 1,
    type: "contradiction",
    headline: `something worth ${score}`,
    detail: "Because of what was said earlier.",
    whyNow: "They are about to decide",
    evidenceTurnIds: ["0:1"],
    evidence: [],
    relatedBoardItemIds: [],
    scores: scoring(score),
    ...overrides,
  };
}

interface Harness {
  clock: SimulatedClock;
  policy: InterjectionPolicy;
  /** Every line written to `candidates.jsonl`, in order. */
  records: DecisionLogRecord[];
  delivered: Interjection[];
  /** Somebody starts talking: a `speechStart` partial. */
  startSpeaking(): void;
  /** They stop: a `speechEnd` partial, then the final turn. */
  stopSpeaking(): void;
  /** The pause state the policy is reading right now. */
  pause(): PauseState;
}

/**
 * A policy on a simulated clock, with a pause state that behaves like the
 * turn assembler's: `silentForMs` counts from the last `speechEnd`, and the
 * policy hears about every snapshot.
 */
function harness(chattiness: Chattiness = "normal"): Harness {
  const clock = new SimulatedClock(0);
  const records: DecisionLogRecord[] = [];
  const delivered: Interjection[] = [];
  let speaking = false;
  let silenceSinceMs = 0;
  const pause = (): PauseState =>
    speaking
      ? { speaking: true, silentForMs: 0 }
      : { speaking: false, silentForMs: clock.now() - silenceSinceMs };
  const policy = new InterjectionPolicy({
    clock,
    pauseState: pause,
    chattiness,
    onRecord: (record) => records.push(record),
    onDeliver: (interjection) => delivered.push(interjection),
    logger: { log: () => {}, warn: () => {} },
  });
  let turns = 0;
  const snapshot = (final: boolean): TurnUpdate => {
    turns += final ? 1 : 0;
    return {
      turnId: `0:${turns}`,
      speaker: "A",
      text: "words",
      final,
      startMs: clock.now(),
      endMs: final ? clock.now() : null,
      speakerMappingUncertain: false,
    };
  };
  return {
    clock,
    policy,
    records,
    delivered,
    pause,
    startSpeaking: () => {
      speaking = true;
      policy.acceptTurn(snapshot(false));
    },
    stopSpeaking: () => {
      speaking = false;
      silenceSinceMs = clock.now();
      policy.acceptTurn(snapshot(false));
      policy.acceptTurn(snapshot(true));
    },
  };
}

describe("InterjectionPolicy", () => {
  it("holds a candidate through the sentence and delivers it at the pause", () => {
    const { clock, policy, records, delivered, startSpeaking, stopSpeaking } = harness();
    startSpeaking();
    clock.advanceBy(3_000);
    policy.accept(candidate(0.9));

    expect(delivered).toEqual([]);
    expect(policy.heldCount()).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ decision: "hold", reason: "waiting_for_pause" });

    stopSpeaking();
    // Half a pause is not a pause, and nothing has been said.
    clock.advanceBy(PAUSE_MS - 1);
    expect(delivered).toEqual([]);

    clock.advanceBy(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.level).toBe("interject");
    expect(delivered[0]?.atMs).toBe(3_000 + PAUSE_MS);
    expect(policy.heldCount()).toBe(0);
    expect(records.at(-1)).toMatchObject({
      kind: "decision",
      decision: "interject",
      reason: "delivered",
      candidateId: delivered[0]?.candidate.id,
      heldForMs: PAUSE_MS,
      score: 0.9,
      thresholds: { glow: 0.35, interject: 0.6 },
      chattiness: "normal",
    });
  });

  it("writes a decision down once, however many times it is re-checked", () => {
    const { clock, policy, records, startSpeaking } = harness();
    startSpeaking();
    policy.accept(candidate(0.9));
    for (let i = 0; i < 4; i += 1) {
      clock.advanceBy(500);
      startSpeaking();
    }

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ decision: "hold", reason: "waiting_for_pause" });
  });

  it("decides a below-threshold candidate at once and never holds it", () => {
    const { policy, records, delivered } = harness();
    policy.accept(candidate(0.3));

    expect(delivered).toEqual([]);
    expect(policy.heldCount()).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ decision: "silent", reason: "below_threshold", score: 0.3 });
  });

  it("gives up on a held candidate after ninety seconds", () => {
    const { clock, policy, records, delivered, startSpeaking } = harness();
    startSpeaking();
    policy.accept(candidate(0.9));
    clock.advanceBy(STALE_MS - 1);
    expect(policy.heldCount()).toBe(1);

    clock.advanceBy(1);
    expect(delivered).toEqual([]);
    expect(policy.heldCount()).toBe(0);
    expect(records.at(-1)).toMatchObject({
      decision: "silent",
      reason: "stale",
      heldForMs: STALE_MS,
    });
  });

  it("gives up on it after six final turns, however fast they go by", () => {
    const { clock, policy, records, delivered, startSpeaking, stopSpeaking } = harness();
    startSpeaking();
    policy.accept(candidate(0.9));
    // Six turns, each short enough that no pause ever opens.
    for (let i = 0; i < STALE_TURNS; i += 1) {
      stopSpeaking();
      clock.advanceBy(PAUSE_MS - 1);
      startSpeaking();
      clock.advanceBy(600);
    }

    expect(delivered).toEqual([]);
    expect(records.at(-1)).toMatchObject({
      decision: "silent",
      reason: "stale",
      turnsWaited: STALE_TURNS,
    });
  });

  it("downgrades the next interject to a glow for three minutes", () => {
    const { clock, policy, delivered, records, stopSpeaking } = harness();
    stopSpeaking();
    clock.advanceBy(PAUSE_MS);
    policy.accept(candidate(0.9));
    expect(delivered.at(-1)?.level).toBe("interject");

    // A minute later, in a pause just as good.
    clock.advanceBy(60_000);
    policy.accept(candidate(0.9));
    expect(delivered).toHaveLength(2);
    expect(delivered.at(-1)?.level).toBe("glow");
    expect(records.at(-1)).toMatchObject({
      decision: "glow",
      reason: "cooldown",
      level: "interject",
    });

    // Once the cooldown is up, it can raise its hand again.
    clock.advanceBy(COOLDOWN_MS);
    policy.accept(candidate(0.9));
    expect(delivered.at(-1)?.level).toBe("interject");
  });

  it("allows three interjects in a quarter of an hour and glows after that", () => {
    const { clock, policy, delivered, records, stopSpeaking } = harness();
    stopSpeaking();
    clock.advanceBy(PAUSE_MS);
    for (let i = 0; i < MAX_INTERJECTS_PER_WINDOW + 1; i += 1) {
      policy.accept(candidate(0.9));
      clock.advanceBy(COOLDOWN_MS);
    }

    expect(delivered.map((one) => one.level)).toEqual([
      "interject",
      "interject",
      "interject",
      "glow",
    ]);
    expect(policy.interjects()).toHaveLength(MAX_INTERJECTS_PER_WINDOW);
    expect(records.at(-1)).toMatchObject({ decision: "glow", reason: "budget" });
  });

  it("says nothing while an answer is being written, then says it", () => {
    const { clock, policy, delivered, records, stopSpeaking } = harness();
    stopSpeaking();
    clock.advanceBy(PAUSE_MS);
    policy.setAnswerThinking(true);
    policy.accept(candidate(0.9));

    expect(delivered).toEqual([]);
    expect(records[0]).toMatchObject({ decision: "hold", reason: "courtesy" });

    clock.advanceBy(4_000);
    policy.setAnswerThinking(false);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.level).toBe("interject");
  });

  it("leaves the floor to whoever just said the wake phrase", () => {
    const { clock, policy, delivered, records, stopSpeaking } = harness();
    stopSpeaking();
    clock.advanceBy(PAUSE_MS);
    policy.wakePhraseDetected();
    policy.accept(candidate(0.9));

    expect(delivered).toEqual([]);
    expect(records[0]).toMatchObject({ decision: "hold", reason: "courtesy" });

    // The window closes on its own, with nothing else arriving.
    clock.advanceBy(COURTESY_MS);
    expect(delivered).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ decision: "interject", reason: "delivered" });
  });

  it("applies a chattiness change to what is already waiting", () => {
    const { clock, policy, delivered, startSpeaking, stopSpeaking } = harness("quiet");
    startSpeaking();
    policy.accept(candidate(0.5));
    expect(policy.heldCount()).toBe(1);

    policy.setChattiness("active");
    expect(policy.setting()).toBe("active");
    expect(delivered).toEqual([]);

    stopSpeaking();
    clock.advanceBy(PAUSE_MS);
    // 0.5 is a glow under `quiet` and an interject under `active`.
    expect(delivered.at(-1)?.level).toBe("interject");
  });

  it("drops a held candidate that a quieter setting no longer wants", () => {
    const { policy, records, delivered, startSpeaking } = harness("normal");
    startSpeaking();
    policy.accept(candidate(0.4));
    expect(policy.heldCount()).toBe(1);

    policy.setChattiness("quiet");
    expect(delivered).toEqual([]);
    expect(policy.heldCount()).toBe(0);
    expect(records.at(-1)).toMatchObject({
      decision: "silent",
      reason: "below_threshold",
      chattiness: "quiet",
    });
  });

  it("delivers the second candidate of one pause as a glow", () => {
    const { clock, policy, delivered, stopSpeaking } = harness();
    stopSpeaking();
    clock.advanceBy(PAUSE_MS);
    policy.accept(candidate(0.9));
    policy.accept(candidate(0.9));

    expect(delivered.map((one) => one.level)).toEqual(["interject", "glow"]);
  });

  it("takes the last pause of the conversation, then accounts for the rest", () => {
    const { clock, policy, delivered, records, startSpeaking, stopSpeaking } = harness();
    stopSpeaking();
    clock.advanceBy(PAUSE_MS);
    policy.accept(candidate(0.9));
    startSpeaking();
    policy.accept(candidate(0.9));
    expect(policy.heldCount()).toBe(1);

    policy.flush();
    // The first went out in the pause; the second was mid-sentence and is
    // written down rather than silently forgotten.
    expect(delivered).toHaveLength(1);
    expect(policy.heldCount()).toBe(0);
    expect(records.at(-1)).toMatchObject({ decision: "silent", reason: "session_ended" });
  });

  it("decides nothing more once it has been stopped", () => {
    const { clock, policy, records, delivered, stopSpeaking } = harness();
    stopSpeaking();
    clock.advanceBy(PAUSE_MS);
    policy.stop();
    policy.accept(candidate(0.9));
    policy.flush();

    expect(records).toEqual([]);
    expect(delivered).toEqual([]);
    expect(clock.pending).toBe(0);
  });
});
