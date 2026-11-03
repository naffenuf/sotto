import { describe, expect, it } from "vitest";
import { sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import {
  FOLLOWUP_MAX_HUMAN_TURNS,
  FOLLOWUP_TIMEOUT_CALL_MS,
  FOLLOWUP_TIMEOUT_MS,
  FollowUpWindow,
} from "./FollowUpWindow.js";
import type { FollowUpResult, LastAnswer } from "./followUp.js";
import type { WakeTrigger } from "../wakeWatcher.js";

function turn(text: string, id = "0:1", speaker: string | null = "A"): TurnUpdate {
  return {
    turnId: id, speaker, text, final: true, startMs: 0, endMs: 1_000,
    speakerMappingUncertain: false,
  };
}

const answer: LastAnswer = {
  question: "What is a reasonable per-head budget for drinks at a launch party in London?",
  headline: "About £12–18 a head for a two-hour evening launch",
  spokenText: "Most London venues come out around twelve to eighteen pounds a head.",
};

const toSotto: FollowUpResult = { kind: "to_sotto", question: "What is the glass hire alone?" };
const toRoom: FollowUpResult = { kind: "to_room", question: "" };
const closing: FollowUpResult = { kind: "closing", question: "" };

interface Harness {
  window: FollowUpWindow;
  clock: SimulatedClock;
  /** Every turn the classifier was given, so "no call at all" is testable. */
  asked: string[];
  followUps: WakeTrigger[];
  indicator: boolean[];
  timing: Record<string, unknown>[];
  /** Resolves whatever classification is waiting, for the backstop tests. */
  release: () => void;
}

/** A window whose classifier answers from a queue, so nothing is awaited. */
function windowFor(
  replies: readonly (FollowUpResult | Error | "hold")[],
  options: { speakers?: Record<string, string>; wall?: SimulatedClock } = {},
): Harness {
  const clock = new SimulatedClock(0);
  const wall = options.wall ?? clock;
  const asked: string[] = [];
  const followUps: WakeTrigger[] = [];
  const indicator: boolean[] = [];
  const timing: Record<string, unknown>[] = [];
  const held: (() => void)[] = [];
  let next = 0;
  const window = new FollowUpWindow({
    clock,
    wallClock: wall,
    classify: async (input) => {
      asked.push(input.turn.text);
      const reply = replies[next++];
      if (reply === undefined || reply === "hold") {
        return new Promise((resolve) => held.push(() => resolve(toRoom)));
      }
      if (reply instanceof Error) throw reply;
      return reply;
    },
    speakers: () => options.speakers ?? { A: "Craig", B: "EJ" },
    onInConversation: (open) => indicator.push(open),
    onFollowUp: (trigger) => followUps.push(trigger),
    onTiming: (record) => timing.push(record),
  });
  return {
    window, clock, asked, followUps, indicator, timing,
    release: () => held.splice(0).forEach((resolve) => resolve()),
  };
}

/** Lets the serialized classification chain reach its first `await`. */
async function tick(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

/** Every `followup_window` line, which is what `timing.jsonl` records. */
function windows(timing: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return timing.filter((one) => one["stage"] === "followup_window");
}

function closeReason(timing: readonly Record<string, unknown>[]): unknown {
  return windows(timing).filter((one) => one["event"] === "closed").at(-1)?.["reason"];
}

describe("FollowUpWindow", () => {
  it("answers a follow-up that says nothing about Sotto, and stays open", async () => {
    const { window, clock, followUps, indicator, timing } = windowFor([toSotto]);
    expect(window.isOpen()).toBe(false);
    clock.advanceTo(30_000);
    window.answered(answer);
    expect(window.isOpen()).toBe(true);
    expect(indicator).toEqual([true]);

    clock.advanceTo(33_000);
    window.acceptTurn(turn(" And how much of that would just be the glass hire? ", "0:4", "B"));
    await window.flush();
    expect(followUps).toEqual([
      { turnId: "0:4", speaker: "B", question: toSotto.question },
    ]);
    // Still listening: the window stays open across the answer this produces.
    expect(window.isOpen()).toBe(true);
    expect(indicator).toEqual([true]);
    expect(timing.filter((one) => one["stage"] === "followup")).toEqual([
      { stage: "followup", atMs: 33_000, turnId: "0:4", kind: "to_sotto", latencyMs: 0 },
    ]);
    expect(windows(timing)).toEqual([
      { stage: "followup_window", event: "opened", atMs: 30_000, reopened: false, question: answer.question },
    ]);
  });

  it("closes when the humans resume, saying nothing", async () => {
    const { window, followUps, indicator, timing } = windowFor([toRoom]);
    window.answered(answer);
    window.acceptTurn(turn(" A float, capped. A cash bar feels like a conference. ", "0:7", "B"));
    await window.flush();
    expect(followUps).toEqual([]);
    expect(window.isOpen()).toBe(false);
    expect(indicator).toEqual([true, false]);
    expect(closeReason(timing)).toBe("to_room");
  });

  it("closes on thanks", async () => {
    const { window, followUps, timing } = windowFor([closing]);
    window.answered(answer);
    window.acceptTurn(turn(" Great, thanks. ", "0:5", "B"));
    await window.flush();
    expect(followUps).toEqual([]);
    expect(window.isOpen()).toBe(false);
    expect(closeReason(timing)).toBe("closing");
  });

  it("closes after the timeout with nobody saying anything", () => {
    const { window, clock, indicator, timing } = windowFor([]);
    window.answered(answer);
    clock.advanceBy(FOLLOWUP_TIMEOUT_MS - 1);
    expect(window.isOpen()).toBe(true);
    clock.advanceBy(1);
    expect(window.isOpen()).toBe(false);
    expect(indicator).toEqual([true, false]);
    expect(closeReason(timing)).toBe("timeout");
  });

  it("closes on a turn that names somebody else in the room, with no call at all", async () => {
    const { window, asked, followUps, timing } = windowFor([toSotto]);
    window.answered(answer);
    window.acceptTurn(
      turn(" Okay EJ, what do you actually want to do here, a cash bar or a float? ", "0:6", "A"),
    );
    await window.flush();
    expect(asked).toEqual([]);
    expect(followUps).toEqual([]);
    expect(window.isOpen()).toBe(false);
    expect(closeReason(timing)).toBe("named_person");
    expect(timing.filter((one) => one["stage"] === "followup")).toEqual([
      { stage: "followup", atMs: 0, turnId: "0:6", kind: "to_room", named: "EJ", latencyMs: 0 },
    ]);
  });

  it("does not read the speaker's own name as somebody else's", async () => {
    const { window, asked, followUps } = windowFor([toSotto]);
    window.answered(answer);
    // Craig is speaker A, so "Craig's" here is the speaker talking about
    // themselves rather than handing the floor over.
    window.acceptTurn(turn(" Is that per head or Craig's whole budget? ", "0:6", "A"));
    await window.flush();
    expect(asked).toHaveLength(1);
    expect(followUps).toHaveLength(1);
  });

  it("does not answer a turn whose verdict cannot be read, and keeps listening", async () => {
    const { window, followUps, timing } = windowFor([new Error("no verdict"), toSotto]);
    window.answered(answer);
    window.acceptTurn(turn(" And on Sunday? ", "0:5", "B"));
    await window.flush();
    expect(followUps).toEqual([]);
    // Unsure is not a reason to stop listening: the next turn gets its own verdict.
    expect(window.isOpen()).toBe(true);
    expect(timing.filter((one) => one["stage"] === "followup")).toEqual([
      { stage: "followup", atMs: 0, turnId: "0:5", kind: "unsure", latencyMs: 0, fallback: true },
    ]);
    window.acceptTurn(turn(" And how much is the ticket? ", "0:6", "B"));
    await window.flush();
    expect(followUps).toHaveLength(1);
  });

  it("gives up on a classification on the wall clock, without closing", async () => {
    const wall = new SimulatedClock(0);
    const { window, followUps, timing } = windowFor(["hold"], { wall });
    window.answered(answer);
    window.acceptTurn(turn(" And on Sunday? ", "0:5", "B"));
    await tick();
    wall.advanceBy(FOLLOWUP_TIMEOUT_CALL_MS);
    await window.flush();
    expect(followUps).toEqual([]);
    expect(window.isOpen()).toBe(true);
    expect(timing.filter((one) => one["stage"] === "followup").at(-1)).toMatchObject({ kind: "unsure", fallback: true });
  });

  it("closes once more turns go by than the backstop allows, before paying for a call", async () => {
    const { window, asked, followUps, timing, release } = windowFor(["hold", "hold", toSotto]);
    window.answered(answer);
    for (let index = 0; index <= FOLLOWUP_MAX_HUMAN_TURNS; index += 1) {
      window.acceptTurn(turn(` Line number ${index}. `, `0:${index + 5}`, index % 2 === 0 ? "A" : "B"));
      // Each turn's classification reaches the model before the next arrives,
      // which is what makes this the backstop for verdicts that never land
      // rather than for turns arriving in one tick.
      await tick();
    }
    expect(window.isOpen()).toBe(false);
    expect(closeReason(timing)).toBe("human_turns");
    // One call, not three: verdicts are serialized, so the turns behind the
    // one that never came back never reached the model at all.
    expect(asked).toEqual([" Line number 0. "]);
    expect(followUps).toEqual([]);
    // Even the verdict that finally lands answers nothing: the window it was
    // about has gone.
    release();
    await window.flush();
    expect(followUps).toEqual([]);
  });

  it("leaves a turn that says Sotto's name to the address path, and stays open", async () => {
    const { window, asked, followUps, timing } = windowFor([toSotto]);
    window.answered(answer);
    window.acceptTurn(turn(" Sotto, what about the food? ", "0:6", "B"));
    await window.flush();
    expect(asked).toEqual([]);
    expect(followUps).toEqual([]);
    expect(window.isOpen()).toBe(true);
    expect(timing.filter((one) => one["stage"] === "followup")).toEqual([
      { stage: "followup", atMs: 0, turnId: "0:6", kind: "addressed" },
    ]);
  });

  it("says nothing while the window is closed, and never opens itself", async () => {
    const { window, asked, followUps, indicator } = windowFor([toSotto]);
    window.acceptTurn(turn(" And how much of that is the glass hire? ", "0:4", "B"));
    await window.flush();
    expect(asked).toEqual([]);
    expect(followUps).toEqual([]);
    expect(indicator).toEqual([]);
  });

  it("never hears Sotto's own line", async () => {
    const { window, asked, followUps } = windowFor([toSotto]);
    window.answered(answer);
    window.acceptTurn(
      sottoTurn({
        utteranceId: "ans-1",
        text: "And how much of that is the glass hire?",
        startMs: 0,
        interrupted: false,
      }),
    );
    await window.flush();
    expect(asked).toEqual([]);
    expect(followUps).toEqual([]);
    expect(window.isOpen()).toBe(true);
  });

  it("re-arms the timeout and the backstop when the next answer finishes", async () => {
    const { window, clock, followUps, timing } = windowFor([toSotto, toSotto]);
    window.answered(answer);
    window.acceptTurn(turn(" And the glass hire? ", "0:4", "B"));
    await window.flush();
    clock.advanceBy(FOLLOWUP_TIMEOUT_MS - 1_000);
    window.answered({ ...answer, question: toSotto.question });
    clock.advanceBy(2_000);
    expect(window.isOpen()).toBe(true);
    window.acceptTurn(turn(" Where are you getting that from? ", "0:5", "A"));
    await window.flush();
    expect(followUps).toHaveLength(2);
    expect(windows(timing).filter((one) => one["event"] === "opened")).toHaveLength(2);
    expect(windows(timing).at(-1)?.["reopened"]).toBe(true);
  });

  it("drops a turn the barge-in owns, and says nothing about it", async () => {
    const { window, asked, followUps } = windowFor([toSotto]);
    window.answered(answer);
    window.ignoreTurn("0:4");
    window.acceptTurn(turn(" Sotto stop. ", "0:4", "B"));
    await window.flush();
    expect(asked).toEqual([]);
    expect(followUps).toEqual([]);
  });

  it("closes with the session and lets no late verdict answer", async () => {
    const { window, followUps, indicator, timing } = windowFor(["hold"]);
    window.answered(answer);
    window.acceptTurn(turn(" And on Sunday? ", "0:5", "B"));
    window.stop();
    expect(window.isOpen()).toBe(false);
    expect(indicator).toEqual([true, false]);
    expect(closeReason(timing)).toBe("session_ended");
    await window.flush();
    expect(followUps).toEqual([]);
    // Nothing opens it again afterwards.
    window.answered(answer);
    expect(window.isOpen()).toBe(false);
  });
});
