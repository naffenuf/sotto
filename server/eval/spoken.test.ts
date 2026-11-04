/**
 * Placing unprompted speech in the conversation (PRD V3-010).
 *
 * The two things only speech can get wrong are here: being said while
 * somebody was talking, and carrying on over somebody who started. Both are
 * read off the transcript, which is what makes the same module serve the
 * `max`-speed eval and the real-time end-to-end check.
 */
import { describe, expect, it } from "vitest";
import type { SpokenContributionRecord } from "../../shared/spoken.js";
import { SPOKEN_CONTRIBUTION_STAGE, estimateSpokenMs } from "../../shared/spoken.js";
import { sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { PAUSE_MS, SPEAK_PAUSE_MS } from "../interject/policy.js";
import { isUnpromptedSpeech, pauseThresholdFor, spokenRecords } from "./spoken.js";

function roomTurn(turnId: string, startMs: number, endMs: number | null): TurnUpdate {
  return {
    turnId,
    speaker: "A",
    text: "something the room said",
    final: endMs !== null,
    startMs,
    endMs,
    speakerMappingUncertain: false,
  };
}

function record(partial: Partial<SpokenContributionRecord> = {}): SpokenContributionRecord {
  return {
    stage: SPOKEN_CONTRIBUTION_STAGE,
    kind: "answer",
    atMs: 90_000,
    ideaId: "idea-1",
    turnId: "0:7",
    topic: "the drive time",
    spoken: true,
    text: "On the drive time: about two hours fifteen.",
    ...partial,
  };
}

/** The row V2-008a writes for one spoken line, at `startMs` on the stream. */
function row(one: SpokenContributionRecord, startMs: number): TurnUpdate {
  return sottoTurn({
    utteranceId: `${one.kind}-${one.ideaId}`,
    text: one.heard ?? one.text,
    startMs,
    interrupted: false,
  });
}

describe("pauseThresholdFor", () => {
  it("gives each kind the threshold its own rule waits for", () => {
    expect(pauseThresholdFor("reserve")).toBe(PAUSE_MS);
    expect(pauseThresholdFor("no_answer")).toBe(PAUSE_MS);
    expect(pauseThresholdFor("answer")).toBe(SPEAK_PAUSE_MS);
    expect(pauseThresholdFor("correction")).toBe(SPEAK_PAUSE_MS);
    expect(pauseThresholdFor("readback")).toBe(SPEAK_PAUSE_MS);
  });

  it("asks a called-on line for no silence at all: the room stopped to ask", () => {
    expect(pauseThresholdFor("called_on")).toBe(0);
  });
});

describe("spokenRecords", () => {
  it("places a line on the stream clock, off Sotto's own transcript row", () => {
    const said = record();
    // The room's last words were at 80s, so by 82s it has been quiet for
    // 2s: comfortably past SPEAK_PAUSE_MS.
    const [one] = spokenRecords({
      records: [said],
      turns: [roomTurn("0:7", 74_000, 80_000)],
      sottoTurns: [row(said, 82_000)],
    });
    expect(one?.atStreamMs).toBe(82_000);
    expect(one?.inPause).toBe(true);
    expect(one?.pause?.silentForMs).toBe(2_000);
    expect(one?.overTurnId).toBeNull();
    expect(one?.endsAtStreamMs).toBe(82_000 + estimateSpokenMs(said.text));
    expect(one?.id).toBe("spoken-0");
  });

  it("marks a line said while somebody was still talking", () => {
    const said = record();
    const [one] = spokenRecords({
      records: [said],
      turns: [roomTurn("0:7", 74_000, 90_000)],
      sottoTurns: [row(said, 82_000)],
    });
    expect(one?.inPause).toBe(false);
    expect(one?.pause?.speaking).toBe(true);
  });

  it("holds a claim to the policy's gap, not the shorter speaking one", () => {
    const claim = record({ kind: "reserve", text: "I'll check the drive time." });
    const answer = record();
    // Half a second after the room's last word: past SPEAK_PAUSE_MS, short
    // of PAUSE_MS.
    const soon = 80_500;
    const [said, heard] = spokenRecords({
      records: [claim, answer],
      turns: [roomTurn("0:7", 70_000, 80_000)],
      sottoTurns: [row(claim, soon), row(answer, soon)],
    });
    expect(said?.pause?.silentForMs).toBe(500);
    expect(said?.inPause).toBe(false);
    expect(heard?.inPause).toBe(true);
  });

  it("names the turn Sotto carried on over", () => {
    const said = record();
    const over = estimateSpokenMs(said.text);
    const [one] = spokenRecords({
      records: [said],
      turns: [
        roomTurn("0:7", 74_000, 80_000),
        roomTurn("0:8", 82_000 + Math.round(over / 2), 95_000),
      ],
      sottoTurns: [row(said, 82_000)],
    });
    expect(one?.overTurnId).toBe("0:8");
  });

  it("does not call a line that yielded an overrun: that is the rule working", () => {
    const said = record({ yielded: true, yields: 1, heard: "On the drive time:" });
    const [one] = spokenRecords({
      records: [said],
      turns: [roomTurn("0:7", 74_000, 80_000), roomTurn("0:8", 82_200, 95_000)],
      // A yielded first attempt keeps the attempt-0 utterance id (V3-004).
      sottoTurns: [row(said, 82_000)],
    });
    expect(one?.atStreamMs).toBe(82_000);
    expect(one?.overTurnId).toBeNull();
  });

  it("finds the row of a retry, which is numbered from the second attempt", () => {
    const retry = record({ yields: 1 });
    const [one] = spokenRecords({
      records: [retry],
      turns: [roomTurn("0:7", 74_000, 80_000)],
      sottoTurns: [
        sottoTurn({
          utteranceId: "answer-idea-1-2",
          text: retry.text,
          startMs: 88_000,
          interrupted: false,
        }),
      ],
    });
    expect(one?.atStreamMs).toBe(88_000);
  });

  it("leaves a line nobody heard unplaced rather than calling it a failure", () => {
    const [one] = spokenRecords({
      records: [record({ spoken: false, reason: "no_gap" })],
      turns: [roomTurn("0:7", 74_000, 80_000)],
      sottoTurns: [],
    });
    expect(one?.atStreamMs).toBeNull();
    expect(one?.inPause).toBeNull();
    expect(one?.overTurnId).toBeNull();
    expect(isUnpromptedSpeech(one as never)).toBe(false);
  });

  it("reports an overrun as unmeasured when the clock spends no time speaking", () => {
    const said = record();
    const over = estimateSpokenMs(said.text);
    const [one] = spokenRecords({
      records: [said],
      turns: [
        roomTurn("0:7", 74_000, 80_000),
        roomTurn("0:8", 82_000 + Math.round(over / 2), 95_000),
      ],
      sottoTurns: [row(said, 82_000)],
      // What `npm run eval` passes: a `max` replay's clock does not move
      // while an utterance is being said, so the next scripted turn always
      // looks as though it started mid-sentence.
      speechTakesTime: false,
    });
    expect(one?.overTurnId).toBeNull();
    expect(one?.overrunMeasured).toBe(false);
    // Everything else about the line is still measured.
    expect(one?.inPause).toBe(true);
  });

  it("keeps a called-on line out of unprompted speech: the room asked", () => {
    const said = record({ kind: "called_on", ideaId: "card-cand-1" });
    const [one] = spokenRecords({
      records: [said],
      turns: [roomTurn("0:7", 74_000, 80_000)],
      sottoTurns: [row(said, 82_000)],
    });
    expect(one?.record.spoken).toBe(true);
    expect(isUnpromptedSpeech(one as never)).toBe(false);
  });
});
