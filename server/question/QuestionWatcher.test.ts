import { describe, expect, it } from "vitest";
import { sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import { QUESTION_TIMEOUT_MS, QuestionWatcher } from "./QuestionWatcher.js";
import type { DecisionClosing, OpenQuestion, QuestionResult } from "./question.js";

function turn(text: string, id = "0:1", speaker: string | null = "A"): TurnUpdate {
  return {
    turnId: id, speaker, text, final: true, startMs: 0, endMs: 1_000,
    speakerMappingUncertain: false,
  };
}

const open: QuestionResult = {
  kind: "open_question",
  question: "How long is the drive to the farmhouse?",
  topic: "the drive time",
  closing: false,
  decision: "",
};

/** V3-013: the group settling something, off the same call. */
const settled: QuestionResult = {
  kind: "decision",
  question: "",
  topic: "",
  closing: true,
  decision: "six sheds, one per association",
};

interface Harness {
  watcher: QuestionWatcher;
  clock: SimulatedClock;
  questions: OpenQuestion[];
  /** V3-013: the decisions the same call reported as settled. */
  closings: DecisionClosing[];
  timing: Record<string, unknown>[];
  asked: string[];
}

/** A watcher whose classifier answers from a queue, so nothing is awaited. */
function watcherFor(
  replies: readonly (QuestionResult | Error)[],
  options: { wall?: SimulatedClock } = {},
): Harness {
  const clock = new SimulatedClock(0);
  const wall = options.wall ?? clock;
  const questions: OpenQuestion[] = [];
  const closings: DecisionClosing[] = [];
  const timing: Record<string, unknown>[] = [];
  const asked: string[] = [];
  let next = 0;
  const watcher = new QuestionWatcher({
    clock,
    wallClock: wall,
    classify: async (input) => {
      asked.push(input.turn.text);
      const reply = replies[next++];
      if (reply === undefined) return new Promise(() => {});
      if (reply instanceof Error) throw reply;
      return reply;
    },
    speakers: () => ({ A: "Craig", B: "EJ" }),
    onOpenQuestion: (question) => questions.push(question),
    onDecisionClosing: (closing) => closings.push(closing),
    onTiming: (record) => timing.push(record),
  });
  return { watcher, clock, questions, closings, timing, asked };
}

describe("QuestionWatcher", () => {
  it("classifies a question-shaped final turn and reports the open question", async () => {
    const { watcher, clock, questions, timing } = watcherFor([open]);
    clock.advanceTo(12_000);
    watcher.acceptTurn(turn(" Is it an hour and a half to the farmhouse? "));
    await watcher.flush();
    expect(questions).toEqual([
      {
        turnId: "0:1",
        question: open.question,
        topic: open.topic,
        askedBy: "Craig",
        askedAtMs: 12_000,
      },
    ]);
    expect(timing.filter((one) => one["stage"] === "question")).toEqual([
      { stage: "question", atMs: 12_000, turnId: "0:1", kind: "open_question", latencyMs: 0 },
    ]);
  });

  it("reads a turn with no question word in it: a need said as a statement", async () => {
    // "We need the bus schedules…" went unread for three minutes under the
    // old word check (`2026-11-03_0945-mic`); every turn is classified now.
    const { watcher, asked, questions } = watcherFor([open]);
    watcher.acceptTurn(turn(" We need the bus schedules from New York to Philadelphia. "));
    await watcher.flush();
    expect(asked).toHaveLength(1);
    expect(questions).toHaveLength(1);
  });

  it("leaves a turn that says Sotto's name to the address path", async () => {
    const { watcher, asked, timing } = watcherFor([open]);
    watcher.acceptTurn(turn(" Sotto what do the main competitors charge per month. "));
    await watcher.flush();
    expect(asked).toEqual([]);
    expect(timing).toEqual([
      { stage: "question_skipped", atMs: 0, turnId: "0:1", reason: "addressed" },
    ]);
  });

  it("leaves a turn in the follow-up window to the address path", async () => {
    const clock = new SimulatedClock(0);
    const asked: string[] = [];
    const watcher = new QuestionWatcher({
      clock,
      classify: async (input) => {
        asked.push(input.turn.text);
        return open;
      },
      speakers: () => ({}),
      inFollowUpWindow: () => true,
      onOpenQuestion: () => {},
      onTiming: () => {},
    });
    watcher.acceptTurn(turn(" And how much would that cost? "));
    await watcher.flush();
    expect(asked).toEqual([]);
  });

  it("reports nothing for the five kinds that are not an open question", async () => {
    const nothing = { question: "", topic: "", closing: false, decision: "" } as const;
    const quiet: QuestionResult[] = [
      { kind: "to_group", ...nothing },
      { kind: "rhetorical", ...nothing },
      { kind: "decision", ...nothing },
      { kind: "answered", ...nothing },
      { kind: "none", ...nothing },
    ];
    const { watcher, questions, timing } = watcherFor(quiet);
    quiet.forEach((_reply, index) => {
      watcher.acceptTurn(turn(" And who's handling food? ", `0:${index}`));
    });
    await watcher.flush();
    expect(questions).toEqual([]);
    expect(timing.map((one) => one["kind"])).toEqual([
      "to_group", "rhetorical", "decision", "answered", "none",
    ]);
  });

  it("classifies one turn once, however often it arrives", async () => {
    const { watcher, asked } = watcherFor([open]);
    const question = turn(" Is it an hour and a half? ");
    watcher.acceptTurn(question);
    watcher.acceptTurn(question);
    await watcher.flush();
    expect(asked).toHaveLength(1);
  });

  it("reads no partials and no lines of Sotto's own", async () => {
    const { watcher, asked } = watcherFor([open, open]);
    watcher.acceptTurn({ ...turn(" Is it an hour and a half? "), final: false, endMs: null });
    watcher.acceptTurn(sottoTurn({
      utteranceId: "u1", text: "How long is the drive? Two hours.", startMs: 0,
      interrupted: false,
    }));
    await watcher.flush();
    expect(asked).toEqual([]);
  });

  it("falls back to none when the classifier fails", async () => {
    const { watcher, questions, timing } = watcherFor([new Error("no")]);
    watcher.acceptTurn(turn(" Is it an hour and a half? "));
    await watcher.flush();
    expect(questions).toEqual([]);
    expect(timing).toEqual([
      { stage: "question", atMs: 0, turnId: "0:1", kind: "none", latencyMs: 0, fallback: true },
    ]);
  });

  it("gives up on real time, not on the session clock", async () => {
    const wall = new SimulatedClock(0);
    const { watcher, questions, timing } = watcherFor([], { wall });
    watcher.acceptTurn(turn(" Is it an hour and a half? "));
    wall.advanceBy(QUESTION_TIMEOUT_MS);
    await watcher.flush();
    expect(questions).toEqual([]);
    expect(timing).toEqual([
      {
        stage: "question", atMs: 0, turnId: "0:1", kind: "none",
        latencyMs: QUESTION_TIMEOUT_MS, fallback: true,
      },
    ]);
  });

  it("classifies two questions at once rather than in turn", async () => {
    const { watcher, asked, questions } = watcherFor([open, open]);
    watcher.acceptTurn(turn(" Is it an hour and a half? ", "0:1"));
    watcher.acceptTurn(turn(" And what do they charge for the room? ", "0:2", "B"));
    expect(asked).toHaveLength(2);
    await watcher.flush();
    expect(questions.map((one) => one.turnId)).toEqual(["0:1", "0:2"]);
    expect(questions[1]?.askedBy).toBe("EJ");
  });

  it("gives the classifier the four previous final turns, by name", async () => {
    const clock = new SimulatedClock(0);
    const seen: string[][] = [];
    const watcher = new QuestionWatcher({
      clock,
      classify: async (input) => {
        seen.push(input.previous.map((one) => one.text));
        return { kind: "none", question: "", topic: "" } as QuestionResult;
      },
      speakers: () => ({ A: "Craig" }),
      onOpenQuestion: () => {},
      onTiming: () => {},
    });
    for (const index of [0, 1, 2, 3, 4]) watcher.acceptTurn(turn(`line ${index}`, `0:${index}`));
    watcher.acceptTurn(turn(" Is it an hour and a half? ", "0:5"));
    await watcher.flush();
    // Every turn is read now, so the earlier ones were classified too; the
    // question is still given exactly the four finals before it.
    expect(seen.at(-1)).toEqual(["line 1", "line 2", "line 3", "line 4"]);
  });

  it("takes side talk as context without classifying it", async () => {
    const { watcher, asked } = watcherFor([open]);
    watcher.remember(turn(" It's about an hour out. ", "0:0"));
    watcher.acceptTurn(turn(" Is it an hour and a half? ", "0:1"));
    await watcher.flush();
    expect(asked).toHaveLength(1);
  });

  it("forgets an echo of Sotto's own voice", async () => {
    const { watcher, asked } = watcherFor([open]);
    watcher.ignoreTurn("0:1");
    watcher.acceptTurn(turn(" Is it an hour and a half? ", "0:1"));
    await watcher.flush();
    expect(asked).toEqual([]);
  });

  it("drops a verdict that lands after the session has stopped", async () => {
    const { watcher, questions } = watcherFor([open]);
    watcher.acceptTurn(turn(" Is it an hour and a half? "));
    watcher.stop();
    await watcher.flush();
    expect(questions).toEqual([]);
  });
});

describe("QuestionWatcher: the group settling something (V3-013)", () => {
  it("classifies a closing-shaped turn that is no question at all", async () => {
    const { watcher, clock, closings, asked, timing } = watcherFor([settled]);
    clock.advanceTo(100_000);
    watcher.acceptTurn(
      turn(" Fine. Right. Let's lock that in. Saturday the 14th. Mechanic and coffee cart. "),
    );
    await watcher.flush();
    // It would never have reached the model on the question filter alone.
    expect(asked).toHaveLength(1);
    expect(closings).toEqual([
      {
        turnId: "0:1",
        decision: "six sheds, one per association",
        decidedBy: "Craig",
        decidedAtMs: 100_000,
      },
    ]);
    expect(timing[0]).toMatchObject({
      stage: "question", kind: "decision", closing: true,
      decision: "six sheds, one per association",
    });
  });

  it("reports nothing for a decision the group is still weighing", async () => {
    const { watcher, closings, timing } = watcherFor([
      { kind: "decision", question: "", topic: "", closing: false, decision: "" },
    ]);
    watcher.acceptTurn(turn(" We could lock it in now, or wait for Alex. "));
    await watcher.flush();
    expect(closings).toEqual([]);
    expect(timing[0]).not.toHaveProperty("closing");
  });

  it("is never both a closing and an open question", async () => {
    const { watcher, questions, closings } = watcherFor([settled]);
    watcher.acceptTurn(turn(" So we're agreed, six sheds. "));
    await watcher.flush();
    expect(questions).toEqual([]);
    expect(closings).toHaveLength(1);
  });
});
