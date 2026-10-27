import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAsrFrameRecords, type AsrFrameRecord } from "../../shared/asr.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import { TurnAssembler, turnKey } from "./turns.js";

const eventsDir = join(process.cwd(), "fixtures", "events");

/** Every capture in `fixtures/events/`, so a new fixture is covered the moment it lands. */
const captures = readdirSync(eventsDir)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => name.replace(/\.jsonl$/, ""))
  .sort();

function records(fixture: string): AsrFrameRecord[] {
  return parseAsrFrameRecords(readFileSync(join(eventsDir, `${fixture}.jsonl`), "utf8"));
}

/** Silences the assembler's warnings so a deliberately broken frame doesn't print. */
const quiet = { warn: () => {} };

/** Shorthand for building the frames by hand in the behaviour tests. */
function frame(atMs: number, body: Record<string, unknown>, session = 0): AsrFrameRecord {
  return { atMs, session, frame: body };
}

const speechStart = (atMs: number, turnId: number, session = 0) =>
  frame(atMs, { type: "speechStart", turnId, audioProcessedMs: atMs }, session);
const transcript = (atMs: number, text: string, session = 0) =>
  frame(atMs, { type: "transcript", transcript: text, final: false, audioProcessedMs: atMs }, session);
const speaker = (atMs: number, label: string, session = 0) =>
  frame(atMs, { type: "speaker", label, audioProcessedMs: atMs }, session);
const speechEnd = (atMs: number, turnId: number, session = 0) =>
  frame(atMs, { type: "speechEnd", turnId, audioProcessedMs: atMs }, session);
const speechComplete = (atMs: number, turnId: number, text: string, session = 0) =>
  frame(atMs, { type: "speechComplete", turnId, transcript: text, audioProcessedMs: atMs }, session);

describe("TurnAssembler", () => {
  it("replaces the current turn's text with each partial and finalises on speechComplete", () => {
    const updates: TurnUpdate[] = [];
    const assembler = new TurnAssembler({
      clock: new SimulatedClock(),
      onUpdate: (turn) => updates.push(turn),
    });

    assembler.accept(speechStart(100, 0));
    assembler.accept(transcript(200, " So"));
    assembler.accept(transcript(300, " So walk"));
    assembler.accept(transcript(400, " So walk me through it. "));
    assembler.accept(speaker(410, "A"));
    assembler.accept(speechEnd(420, 0));
    assembler.accept(speechComplete(430, 0, " So walk me through it. "));

    expect(updates.map((turn) => turn.text)).toEqual([
      "",
      " So",
      " So walk",
      " So walk me through it. ",
      " So walk me through it. ",
      " So walk me through it. ",
      " So walk me through it. ",
    ]);
    expect(updates.filter((turn) => turn.final)).toHaveLength(1);
    expect(assembler.finalTurns()).toEqual([
      {
        turnId: "0:0",
        speaker: "A",
        text: " So walk me through it. ",
        final: true,
        startMs: 100,
        endMs: 420,
        speakerMappingUncertain: false,
      },
    ]);
    expect(assembler.openTurns()).toEqual([]);
  });

  it("takes the final text from speechComplete even when it differs from the last partial", () => {
    const assembler = new TurnAssembler({ clock: new SimulatedClock() });
    assembler.accept(speechStart(0, 0));
    assembler.accept(transcript(100, " ten second"));
    assembler.accept(speaker(110, "B"));
    assembler.accept(speechEnd(120, 0));
    assembler.accept(speechComplete(130, 0, " Ten seconds is the bar. "));

    expect(assembler.finalTurns()[0]?.text).toBe(" Ten seconds is the bar. ");
  });

  it("leaves a partial with no speaker until its speaker frame lands", () => {
    const assembler = new TurnAssembler({ clock: new SimulatedClock() });
    const opened = assembler.accept(speechStart(0, 0));
    const partial = assembler.accept(transcript(100, " Hello"));
    expect(opened?.speaker).toBeNull();
    expect(partial?.speaker).toBeNull();

    const labelled = assembler.accept(speaker(110, "A"));
    expect(labelled?.speaker).toBe("A");
  });

  it("applies untagged partials to the most recent turn that has not ended", () => {
    const assembler = new TurnAssembler({ clock: new SimulatedClock() });
    assembler.accept(speechStart(0, 0));
    assembler.accept(transcript(50, " first speaker"));
    // A second turn opens before the first one closes: the partials that
    // follow belong to the newer turn.
    assembler.accept(speechStart(100, 1));
    assembler.accept(transcript(150, " second speaker"));
    assembler.accept(speaker(160, "B"));
    assembler.accept(speechEnd(170, 1));
    assembler.accept(speechComplete(180, 1, " Second speaker. "));
    // With turn 1 closed, partials go back to turn 0.
    assembler.accept(transcript(200, " first speaker again"));
    assembler.accept(speaker(210, "A"));
    assembler.accept(speechEnd(220, 0));
    assembler.accept(speechComplete(230, 0, " First speaker again. "));

    expect(assembler.finalTurns()).toEqual([
      {
        turnId: "0:1",
        speaker: "B",
        text: " Second speaker. ",
        final: true,
        startMs: 100,
        endMs: 170,
        speakerMappingUncertain: false,
      },
      {
        turnId: "0:0",
        speaker: "A",
        text: " First speaker again. ",
        final: true,
        startMs: 0,
        endMs: 220,
        speakerMappingUncertain: false,
      },
    ]);
  });

  it("keys turns by session so turnIds repeated after a reconnect do not collide", () => {
    const assembler = new TurnAssembler({ clock: new SimulatedClock() });
    assembler.accept(speechStart(0, 0, 0));
    assembler.accept(speaker(10, "A", 0));
    assembler.accept(speechEnd(20, 0, 0));
    assembler.accept(speechComplete(30, 0, " Before. ", 0));
    assembler.accept(speechStart(100, 0, 1));
    assembler.accept(speaker(110, "A", 1));
    assembler.accept(speechEnd(120, 0, 1));
    assembler.accept(speechComplete(130, 0, " After. ", 1));

    expect(assembler.finalTurns().map((turn) => turn.turnId)).toEqual(["0:0", "1:0"]);
    expect(turnKey(1, 0)).toBe("1:0");
  });

  it("maps a later session's labels onto the known speakers by order of first appearance", () => {
    const assembler = new TurnAssembler({ clock: new SimulatedClock() });
    // Session 0 meets A then B.
    assembler.accept(speechStart(0, 0, 0));
    assembler.accept(speaker(10, "A", 0));
    assembler.accept(speechEnd(20, 0, 0));
    assembler.accept(speechComplete(30, 0, " A first. ", 0));
    assembler.accept(speechStart(40, 1, 0));
    assembler.accept(speaker(50, "B", 0));
    assembler.accept(speechEnd(60, 1, 0));
    assembler.accept(speechComplete(70, 1, " B second. ", 0));

    // The 60-minute limit hit; session 1 labels the same room from scratch and
    // happens to hear the second speaker first.
    assembler.accept(speechStart(100, 0, 1));
    assembler.accept(speaker(110, "B", 1));
    assembler.accept(speechEnd(120, 0, 1));
    assembler.accept(speechComplete(130, 0, " Still going. ", 1));
    assembler.accept(speechStart(140, 1, 1));
    assembler.accept(speaker(150, "A", 1));
    assembler.accept(speechEnd(160, 1, 1));
    assembler.accept(speechComplete(170, 1, " Me too. ", 1));
    // A label already seen in this session keeps the speaker it was given.
    assembler.accept(speechStart(180, 2, 1));
    assembler.accept(speaker(190, "B", 1));
    assembler.accept(speechEnd(200, 2, 1));
    assembler.accept(speechComplete(210, 2, " And again. ", 1));

    expect(assembler.finalTurns().map((turn) => turn.speaker)).toEqual(["A", "B", "A", "B", "A"]);
    expect(assembler.finalTurns().map((turn) => turn.speakerMappingUncertain)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(assembler.speakers()).toEqual(["A", "B"]);
  });

  it("flags a reconnected turn as uncertain from its first partial, before any label", () => {
    const assembler = new TurnAssembler({ clock: new SimulatedClock() });
    assembler.accept(speechStart(0, 0, 0));
    assembler.accept(speaker(10, "A", 0));
    assembler.accept(speechEnd(20, 0, 0));
    assembler.accept(speechComplete(30, 0, " Before. ", 0));

    const opened = assembler.accept(speechStart(100, 0, 1));
    expect(opened).toMatchObject({ speaker: null, speakerMappingUncertain: true });
    expect(assembler.openTurns()).toEqual([
      {
        turnId: "1:0",
        speaker: null,
        text: "",
        final: false,
        startMs: 100,
        endMs: null,
        speakerMappingUncertain: true,
      },
    ]);
  });

  it("gives a voice beyond the ones already heard a new speaker rather than folding it in", () => {
    const assembler = new TurnAssembler({ clock: new SimulatedClock() });
    assembler.accept(speechStart(0, 0, 0));
    assembler.accept(speaker(10, "A", 0));
    assembler.accept(speechEnd(20, 0, 0));
    assembler.accept(speechComplete(30, 0, " Only me so far. ", 0));

    // Session 1's first label maps to the one known speaker; its second is
    // somebody new, and keeps a label of its own even though "A" is taken.
    assembler.accept(speechStart(100, 0, 1));
    assembler.accept(speaker(110, "B", 1));
    assembler.accept(speechEnd(120, 0, 1));
    assembler.accept(speechComplete(130, 0, " Same voice. ", 1));
    assembler.accept(speechStart(140, 1, 1));
    assembler.accept(speaker(150, "A", 1));
    assembler.accept(speechEnd(160, 1, 1));
    assembler.accept(speechComplete(170, 1, " A different voice. ", 1));

    expect(assembler.finalTurns().map((turn) => turn.speaker)).toEqual(["A", "A", "B"]);
    expect(assembler.speakers()).toEqual(["A", "B"]);
  });

  it("reports speaking while a turn is open and silence from the last speechEnd", () => {
    const clock = new SimulatedClock();
    const assembler = new TurnAssembler({ clock, startedAtMs: 0 });

    clock.advanceTo(500);
    expect(assembler.pauseState()).toEqual({ speaking: false, silentForMs: 500 });

    assembler.accept(speechStart(1_000, 0));
    clock.advanceTo(3_000);
    expect(assembler.pauseState()).toEqual({ speaking: true, silentForMs: 0 });

    assembler.accept(speechEnd(3_000, 0));
    assembler.accept(speechComplete(3_010, 0, " Done. "));
    clock.advanceTo(4_600);
    expect(assembler.pauseState()).toEqual({ speaking: false, silentForMs: 1_600 });
    expect(assembler.pauseState(3_500)).toEqual({ speaking: false, silentForMs: 500 });
  });

  it("stays speaking until the last overlapping turn ends", () => {
    const assembler = new TurnAssembler({ clock: new SimulatedClock() });
    assembler.accept(speechStart(0, 0));
    assembler.accept(speechStart(100, 1));
    assembler.accept(speechEnd(200, 1));
    expect(assembler.pauseState(300)).toEqual({ speaking: true, silentForMs: 0 });

    assembler.accept(speechEnd(400, 0));
    expect(assembler.pauseState(900)).toEqual({ speaking: false, silentForMs: 500 });
  });

  it("ignores frames that carry no turn information", () => {
    const assembler = new TurnAssembler({ clock: new SimulatedClock() });
    expect(assembler.accept(frame(0, { sessionId: "voyager/duplex/ABC" }))).toBeNull();
    expect(assembler.accept(frame(10, { type: "audioProgress", audioProcessedMs: 80 }))).toBeNull();
    assembler.accept(speechStart(20, 0));
    assembler.accept(speaker(30, "A"));
    assembler.accept(speechEnd(40, 0));
    assembler.accept(speechComplete(50, 0, " Hi. "));
    // The empty `final: true` transcript the server sends after `endStream`.
    expect(
      assembler.accept(frame(60, { type: "transcript", transcript: "", final: true, audioProcessedMs: 80 })),
    ).toBeNull();

    expect(assembler.finalTurns()).toHaveLength(1);
    expect(assembler.malformedFrames()).toBe(0);
  });

  it("counts a known frame type that does not match its shape instead of guessing", () => {
    const assembler = new TurnAssembler({ clock: new SimulatedClock(), logger: quiet });
    expect(assembler.accept(frame(0, { type: "speechStart", audioProcessedMs: 0 }))).toBeNull();
    expect(assembler.malformedFrames()).toBe(1);
    expect(assembler.finalTurns()).toEqual([]);
  });

  it("drops frames that arrive without an open turn", () => {
    const assembler = new TurnAssembler({ clock: new SimulatedClock(), logger: quiet });
    expect(assembler.accept(transcript(0, " orphan"))).toBeNull();
    expect(assembler.accept(speaker(10, "A"))).toBeNull();
    expect(assembler.accept(speechEnd(20, 7))).toBeNull();
    expect(assembler.accept(speechComplete(30, 7, " orphan "))).toBeNull();
    expect(assembler.finalTurns()).toEqual([]);
    expect(assembler.malformedFrames()).toBe(0);
  });
});

interface Replay {
  turns: readonly TurnUpdate[];
  assembler: TurnAssembler;
  /** The longest silence `pauseState` reported at any frame arrival. */
  longestSilenceMs: number;
}

/**
 * Replays a capture frame by frame, sampling `pauseState` at every arrival.
 * `audioProgress` keeps arriving every 80 ms through a pause, so the sample
 * closest to the end of a gap is within a chunk of the whole gap.
 */
function replay(fixture: string): Replay {
  const clock = new SimulatedClock();
  const assembler = new TurnAssembler({ clock, startedAtMs: 0, logger: quiet });
  let longestSilenceMs = 0;
  for (const record of records(fixture)) {
    clock.advanceTo(record.atMs);
    assembler.accept(record);
    const state = assembler.pauseState();
    if (!state.speaking) longestSilenceMs = Math.max(longestSilenceMs, state.silentForMs);
  }
  return { turns: assembler.finalTurns(), assembler, longestSilenceMs };
}

describe.each(captures)("replaying the %s capture", (fixture) => {
  it("builds labeled turns with no leftovers", () => {
    const { turns, assembler } = replay(fixture);

    expect(turns.length).toBeGreaterThan(0);
    expect(assembler.malformedFrames()).toBe(0);
    // Every turn that opened also completed: nothing left half-built.
    expect(assembler.openTurns()).toEqual([]);
    for (const turn of turns) {
      expect(turn.text.trim()).not.toBe("");
      expect(turn.speaker).not.toBeNull();
      expect(turn.endMs).not.toBeNull();
      expect(turn.endMs as number).toBeGreaterThanOrEqual(turn.startMs);
      // Every capture is one session, so no label was remapped.
      expect(turn.speakerMappingUncertain).toBe(false);
    }
    // Turn keys are unique, and the conversation reads in the order it happened.
    expect(new Set(turns.map((turn) => turn.turnId)).size).toBe(turns.length);
    const starts = turns.map((turn) => turn.startMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});

describe("replaying the brainstorm capture", () => {
  it("has at least two speakers, non-empty finals in time order, and a pause of 1.5 s", () => {
    const { turns, longestSilenceMs } = replay("brainstorm");

    const speakers = new Set(turns.map((turn) => turn.speaker));
    expect(speakers.size).toBeGreaterThanOrEqual(2);
    expect(turns.every((turn) => turn.text.trim().length > 0)).toBe(true);
    const ends = turns.map((turn) => turn.endMs as number);
    expect([...ends].sort((a, b) => a - b)).toEqual(ends);
    expect(longestSilenceMs).toBeGreaterThanOrEqual(1_500);
  });

  it("ends every turn before the next one starts, since nobody talks over anybody", () => {
    const { turns } = replay("brainstorm");
    for (let i = 1; i < turns.length; i += 1) {
      expect(turns[i]!.startMs).toBeGreaterThan(turns[i - 1]!.endMs as number);
    }
  });
});
