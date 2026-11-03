/**
 * The model-read introductions (post-V3-011): one call once the room has
 * settled, applied over the pattern-read names; later calls only for turns
 * about a name.
 */
import { describe, expect, it } from "vitest";
import type { SpeakerNames } from "../../shared/events.js";
import { sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import type { ModelClient, StructuredCall } from "../model/client.js";
import {
  INTRO_MIN_GAP_MS,
  INTRO_SETTLE_MS,
  INTRO_SETTLE_TURNS,
  IntroductionReader,
  aboutAName,
  renderIntroductionsRequest,
} from "./IntroductionReader.js";

function turn(id: string, speaker: string, text: string): TurnUpdate {
  return { turnId: id, speaker, text, final: true, startMs: 0, endMs: 100, speakerMappingUncertain: false };
}

function setup(reply: (call: StructuredCall) => Promise<unknown> = async () => ({ speakers: [] })) {
  const clock = new SimulatedClock(0);
  const wall = new SimulatedClock(0);
  const calls: StructuredCall[] = [];
  const renames: [string, string][] = [];
  const timing: Record<string, unknown>[] = [];
  const names: Record<string, string> = {};
  const model: ModelClient = {
    structured: async (call) => {
      calls.push(call);
      return reply(call);
    },
    grounded: async () => { throw new Error("not here"); },
    prose: async () => { throw new Error("not here"); },
  };
  const reader = new IntroductionReader({
    clock,
    wallClock: wall,
    model,
    speakers: (): SpeakerNames => ({ ...names }),
    rename: (label, name) => {
      renames.push([label, name]);
      names[label] = name;
    },
    onTiming: (event) => timing.push(event),
    logger: { log: () => {}, warn: () => {} },
  });
  return { clock, wall, calls, renames, timing, names, reader };
}

describe("IntroductionReader", () => {
  it("reads the first turns once they settle and applies the corrections", async () => {
    const t = setup(async () => ({ speakers: [{ label: "A", name: "Craig" }, { label: "B", name: "EJ" }] }));
    // The patterns already named them, one of them wrongly.
    t.names.A = "Craig";
    t.names.B = "AJ";
    t.reader.acceptTurn(turn("0:1", "A", "I'm Craig."));
    t.reader.acceptTurn(turn("0:2", "B", "And I'm AJ."));
    t.reader.acceptTurn(turn("0:3", "A", "No, that was EJ. Okay. So we're planning our trip to Philadelphia."));
    expect(t.calls).toEqual([]);
    t.clock.advanceBy(INTRO_SETTLE_MS);
    await t.reader.flush();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.label).toBe("introductions");
    expect(t.calls[0]?.user).toContain("B: AJ");
    expect(t.calls[0]?.user).toContain("A: No, that was EJ.");
    // Only what changed is applied.
    expect(t.renames).toEqual([["B", "EJ"]]);
    expect(t.timing.at(-1)).toMatchObject({ stage: "introductions", why: "time", changed: 1 });
  });

  it("settles early once enough turns have gone by", async () => {
    const t = setup();
    for (let i = 1; i <= INTRO_SETTLE_TURNS; i += 1) t.reader.acceptTurn(turn(`0:${i}`, "A", `turn ${i}`));
    await t.reader.flush();
    expect(t.calls).toHaveLength(1);
    expect(t.timing.at(-1)).toMatchObject({ why: "turns" });
  });

  it("never names a label the model left blank, and never a label or the wake word", async () => {
    const t = setup(async () => ({ speakers: [{ label: "A", name: "" }, { label: "B", name: "B" }, { label: "C", name: "Sotto" }] }));
    t.reader.acceptTurn(turn("0:1", "A", "hello"));
    t.reader.acceptTurn(turn("0:2", "B", "hi"));
    t.reader.acceptTurn(turn("0:3", "C", "hey"));
    t.clock.advanceBy(INTRO_SETTLE_MS);
    await t.reader.flush();
    expect(t.renames).toEqual([]);
  });

  it("looks again only for a turn about a name, and not twice in quick succession", async () => {
    let answer = { speakers: [{ label: "A", name: "Craig" }, { label: "B", name: "AJ" }] };
    const t = setup(async () => answer);
    t.reader.acceptTurn(turn("0:1", "A", "I'm Craig."));
    t.reader.acceptTurn(turn("0:2", "B", "And I'm AJ."));
    t.clock.advanceBy(INTRO_SETTLE_MS);
    await t.reader.flush();
    expect(t.calls).toHaveLength(1);

    t.clock.advanceBy(INTRO_MIN_GAP_MS);
    t.reader.acceptTurn(turn("0:3", "A", "So the bus leaves at ten."));
    await t.reader.flush();
    expect(t.calls).toHaveLength(1);

    answer = { speakers: [{ label: "A", name: "Craig" }, { label: "B", name: "EJ" }] };
    t.reader.acceptTurn(turn("0:4", "A", "You got her name wrong, it's EJ with an E."));
    await t.reader.flush();
    expect(t.calls).toHaveLength(2);
    expect(t.renames).toEqual([["A", "Craig"], ["B", "AJ"], ["B", "EJ"]]);

    // Another name turn straight away waits out the gap.
    t.reader.acceptTurn(turn("0:5", "B", "Yes, EJ."));
    await t.reader.flush();
    expect(t.calls).toHaveLength(2);
  });

  it("ignores Sotto's own lines and a failed call", async () => {
    const t = setup(async () => { throw new Error("down"); });
    t.reader.acceptTurn(sottoTurn({ utteranceId: "hello", text: "Hi, I'm Sotto.", startMs: 0, interrupted: false }));
    t.reader.acceptTurn(turn("0:1", "A", "I'm Craig."));
    t.clock.advanceBy(INTRO_SETTLE_MS);
    await t.reader.flush();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.user).not.toContain("Sotto:");
    expect(t.renames).toEqual([]);
    expect(t.timing.at(-1)).toMatchObject({ stage: "introductions", failed: true });
  });

  it("does nothing after stop", async () => {
    const t = setup();
    t.reader.acceptTurn(turn("0:1", "A", "I'm Craig."));
    t.reader.stop();
    t.clock.advanceBy(INTRO_SETTLE_MS);
    await t.reader.flush();
    expect(t.calls).toEqual([]);
  });
});

describe("aboutAName", () => {
  it("notices a current name, the word name near the start, or a correction", () => {
    const speakers = { A: "Craig", B: "AJ" };
    expect(aboutAName("No, that was EJ.", speakers)).toBe(true);
    expect(aboutAName("you got her name wrong", speakers)).toBe(true);
    expect(aboutAName("AJ, what do you think?", speakers)).toBe(true);
    expect(aboutAName("the bus leaves at ten", speakers)).toBe(false);
    expect(aboutAName("we should put the sign at the very end and the company name on it", speakers)).toBe(false);
  });
});

describe("renderIntroductionsRequest", () => {
  it("lists the labels with their names so far, then the turns", () => {
    const text = renderIntroductionsRequest(
      [turn("0:1", "A", "I'm Craig."), turn("0:2", "B", "And I'm AJ.")],
      ["A", "B"],
      { A: "Craig" },
    );
    expect(text).toBe("Labels and the names so far:\nA: Craig\nB: (no name yet)\n\nThe turns, in order:\nA: I'm Craig.\nB: And I'm AJ.");
  });
});
