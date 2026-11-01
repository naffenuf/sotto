import { describe, expect, it } from "vitest";
import { sottoTurn, type TurnUpdate } from "../shared/turns.js";
import { WakeWatcher, type WakeTrigger } from "./wakeWatcher.js";

/** One snapshot of a turn, with the fields the watcher does not read filled in. */
function turn(turnId: string, text: string, final = false): TurnUpdate {
  return {
    turnId,
    speaker: final ? "A" : null,
    text,
    final,
    startMs: 0,
    endMs: final ? 1_000 : null,
    speakerMappingUncertain: false,
  };
}

interface Watched {
  watcher: WakeWatcher;
  listening: boolean[];
  questions: WakeTrigger[];
}

function watch(): Watched {
  const listening: boolean[] = [];
  const questions: WakeTrigger[] = [];
  const watcher = new WakeWatcher({
    onListening: (value) => listening.push(value),
    onQuestion: (trigger) => questions.push(trigger),
  });
  return { watcher, listening, questions };
}

describe("WakeWatcher", () => {
  it("clears an ignored partial without clearing another speaker's wake", () => {
    const { watcher, listening, questions } = watch();
    watcher.acceptTurn(turn("0:3", "Sotto, what time is lunch?"));
    watcher.ignoreTurn("0:4");
    expect(watcher.listening).toBe(true);
    watcher.ignoreTurn("0:3");
    expect(listening).toEqual([true, false]);
    expect(questions).toEqual([]);
  });

  it("never hears Sotto's own transcript line (V2-008a)", () => {
    const { watcher, listening, questions } = watch();
    // Its own answer says its name, and asks a question in passing.
    watcher.acceptTurn(
      sottoTurn({
        utteranceId: "ans-1",
        text: "Sotto, what do rivals charge? That is what you asked me.",
        startMs: 4_000,
        interrupted: false,
      }),
    );
    expect(listening).toEqual([]);
    expect(questions).toEqual([]);
  });

  it("lights the indicator on the partial and emits the question on the final", () => {
    const { watcher, listening, questions } = watch();

    // The partials of `ask-search`, verbatim from the capture.
    watcher.acceptTurn(turn("0:3", " Sotto"));
    expect(listening).toEqual([]);
    expect(watcher.listening).toBe(false);

    watcher.acceptTurn(turn("0:3", " Sotto what do"));
    expect(listening).toEqual([true]);
    expect(watcher.listening).toBe(true);
    // The question is still being asked, so there is nothing to answer yet.
    expect(questions).toEqual([]);

    watcher.acceptTurn(turn("0:3", " Sotto what do the main competitors charge"));
    expect(listening).toEqual([true]);

    watcher.acceptTurn(turn("0:3", " Sotto what do the main competitors charge per month. ", true));
    expect(listening).toEqual([true, false]);
    expect(questions).toEqual([
      {
        turnId: "0:3",
        speaker: "A",
        question: "what do the main competitors charge per month.",
      },
    ]);
  });

  it("takes the indicator back down when the next word says it was not the wake word", () => {
    const { watcher, listening, questions } = watch();

    // Contrived: the `no-wake` capture's first partial already has "voce" in
    // it. This is the shape a slower endpointer would produce.
    watcher.acceptTurn(turn("0:2", " Exactly. Sotto, if"));
    expect(listening).toEqual([true]);

    watcher.acceptTurn(turn("0:2", " Exactly. Sotto voce, if you want"));
    expect(listening).toEqual([true, false]);

    watcher.acceptTurn(turn("0:2", " Exactly. Sotto voce, if you want to be fancy about it. ", true));
    expect(listening).toEqual([true, false]);
    expect(questions).toEqual([]);
  });

  it("triggers at most once per turn", () => {
    const { watcher, questions } = watch();
    const text = "Sotto, what did we decide about pricing?";

    watcher.acceptTurn(turn("0:7", text, true));
    // A final turn arriving twice — a reconnect, a replayed capture read
    // twice — must not ask the same question again.
    watcher.acceptTurn(turn("0:7", text, true));
    watcher.acceptTurn(turn("0:7", `${text} And the tiers?`, true));

    expect(questions).toHaveLength(1);
  });

  it("does not let another speaker's turn pull the indicator down", () => {
    const { watcher, listening } = watch();

    watcher.acceptTurn(turn("0:4", "Sotto, what is"));
    expect(listening).toEqual([true]);

    // Somebody talking over the question: their turn never matched, so it has
    // no business saying the indicator should be down.
    watcher.acceptTurn(turn("0:5", "hang on"));
    watcher.acceptTurn(turn("0:5", "hang on a second", true));
    expect(listening).toEqual([true]);
    expect(watcher.listening).toBe(true);

    watcher.acceptTurn(turn("0:4", "Sotto, what is the budget?", true));
    expect(listening).toEqual([true, false]);
  });

  it("stays quiet through a conversation that never says its name", () => {
    const { watcher, listening, questions } = watch();
    for (const text of [
      " We should keep the whole thing quiet, so to speak. ",
      " so to speak ",
      " Huh, my uncle ran a place called Soto's Restaurant and he had one rule. ",
    ]) {
      watcher.acceptTurn(turn("0:1", text));
      watcher.acceptTurn(turn("0:1", text, true));
    }
    expect(listening).toEqual([]);
    expect(questions).toEqual([]);
  });

  it("takes the spellings it is given", () => {
    const { watcher, questions } = watch();
    watcher.acceptTurn(turn("0:1", "Jarvis, what time is it?", true));
    expect(questions).toEqual([]);

    const other = watch();
    const jarvis = new WakeWatcher({
      spellings: ["jarvis"],
      onListening: () => {},
      onQuestion: (trigger) => other.questions.push(trigger),
    });
    jarvis.acceptTurn(turn("0:1", "Jarvis, what time is it?", true));
    expect(other.questions.map((one) => one.question)).toEqual(["what time is it?"]);
  });
});
