/**
 * V3-013 against the real model: a decision the group settles out loud, read
 * back with whatever of theirs is still open.
 *
 * `decision-closings` settles three things, and the three are the PRD's three
 * cases in one conversation. The launch costs (line 10) only *Sotto* sees a
 * problem with — twelve hundred of kits and a hundred of insurance leave a
 * hundred of the fourteen hundred, and the mechanic and the coffee cart are
 * four hundred and fifty — so that one belongs on the screen and is pinned
 * beside the decision rather than said. The six sheds (line 20) are what the
 * group itself asked a question about at line 13 and never came back to, so
 * that read-back carries their own words. The paper sheets (line 25) have
 * nothing hanging off them.
 *
 * Everything here is real: the question classifier's `closing` verdict, the
 * observer's candidates, the gate and the policy. The voice is a recorder, so
 * what the room would have heard is readable without anything being
 * synthesized. `brainstorm` is the control — it settles one thing ("decided
 * then, photo to three suggestions") and has nothing of the room's hanging off
 * it.
 *
 * One replay per fixture in `beforeAll` with the assertions in instant `it`
 * blocks, for `fastPath.integration.test.ts`'s reason: a conversation's worth
 * of sequential calls to a reasoning model blows past the per-test timeout,
 * and only `beforeAll`'s own matters.
 */
import { config as loadDotenv } from "dotenv";
import { beforeAll, describe, expect, it } from "vitest";
import type { StageCard } from "../../shared/cards.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import type { SessionWriter } from "../session/SessionStore.js";
import { EventBus } from "../events/bus.js";
import { glimmerFromEnv } from "../model/GlimmerClient.js";
import { SessionManager } from "../session/SessionManager.js";
import type { VoiceOut, VoiceUtterance } from "../voice/voiceOut.js";

loadDotenv({ quiet: true });

const apiKey = (process.env["MODEL_API_KEY"] ?? "").trim();
const describeSpark = apiKey === "" ? describe.skip : describe;

const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const loud = {
  log: (line: unknown) => process.stderr.write(`${String(line)}\n`),
  warn: (line: unknown) => process.stderr.write(`${String(line)}\n`),
  error: (line: unknown) => process.stderr.write(`${String(line)}\n`),
};

/** A voice that keeps every utterance rather than synthesizing it. */
class RecordingVoice implements VoiceOut {
  private count = 0;
  readonly utterances: string[] = [];

  begin(): Promise<VoiceUtterance | null> {
    const parts: string[] = [];
    const spoken = (): string => parts.join(" ");
    return Promise.resolve({
      id: `v${(this.count += 1)}`,
      append: (text) => parts.push(text.trim()),
      firstAudioMs: () => (parts.length === 0 ? null : 10),
      cancel: () => {},
      finish: () => {
        this.utterances.push(spoken());
        return Promise.resolve({
          reason: "complete" as const,
          text: spoken(),
          spokenSoFar: spoken(),
          firstAudioMs: parts.length === 0 ? null : 10,
        });
      },
    });
  }
}

interface Run {
  timing: Record<string, unknown>[];
  cards: StageCard[];
  turns: TurnUpdate[];
  voice: RecordingVoice;
}

function writer(timing: Record<string, unknown>[]): SessionWriter {
  return {
    dir: "/tmp/not-a-real-folder",
    appendEvent: () => {},
    appendTurn: () => {},
    renameSpeaker: () => {},
    setSettings: () => {},
    writeBoard: () => {},
    appendCandidate: () => {},
    appendFeedback: () => {},
    appendAnswer: () => {},
    appendResearch: () => {},
    writePacket: () => {},
    writeDigest: () => {},
    appendTiming: (record: Record<string, unknown>) => timing.push(record),
    writeArtifact: (fileName: string) => `artifacts/${fileName}`,
    end: () => {},
  } satisfies SessionWriter;
}

async function replay(fixture: string): Promise<Run> {
  const bus = new EventBus(quiet);
  const timing: Record<string, unknown>[] = [];
  const cards: StageCard[] = [];
  const turns: TurnUpdate[] = [];
  const voice = new RecordingVoice();
  bus.subscribe((event) => {
    if (event.type === "card") cards.push(event.card);
    if (event.type === "turn") turns.push(event.turn);
  });
  const sessions = new SessionManager({
    bus,
    apiKey,
    logger: loud,
    replaySpeed: "max",
    createStore: () => writer(timing),
    createVoice: () => voice,
    // Exactly what the server does: Glimmer when this Mac is serving one. It
    // gates the research ideas this conversation throws up and nothing else.
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
  sessions.start({ kind: "events", fixture });
  await ended;
  return { timing, cards, turns, voice };
}

const closings = (run: Run): Record<string, unknown>[] =>
  run.timing.filter((record) => record["stage"] === "decision_closing");

const readBacks = (run: Run): Record<string, unknown>[] =>
  run.timing.filter(
    (record) => record["stage"] === "spoken_contribution" && record["kind"] === "readback",
  );

/** The closing whose decision mentions one of these words. */
function about(run: Run, ...words: string[]): Record<string, unknown> | undefined {
  return closings(run).find((record) =>
    words.some((word) => String(record["decision"]).toLowerCase().includes(word)),
  );
}

describeSpark("read-backs at decision points, against the real model (V3-013)", () => {
  let decisions: Run;
  let control: Run;

  beforeAll(async () => {
    decisions = await replay("decision-closings");
    control = await replay("brainstorm");
    process.stderr.write(
      `[readback] closings: ${JSON.stringify(closings(decisions), null, 1)}\n` +
        `[readback] read-backs: ${JSON.stringify(readBacks(decisions), null, 1)}\n` +
        `[readback] said: ${JSON.stringify(decisions.voice.utterances, null, 1)}\n` +
        `[readback] brainstorm closings: ${JSON.stringify(closings(control))}\n`,
    );
  }, 25 * 60_000);

  it("notices every decision the group settles out loud", () => {
    // Three closings, and no extra call: the question classifier answered
    // both questions at once (V3-002's call, V3-013's field).
    expect(closings(decisions)).toHaveLength(3);
    expect(about(decisions, "saturday", "mechanic", "coffee", "launch")).toBeDefined();
    expect(about(decisions, "shed")).toBeDefined();
    expect(about(decisions, "paper")).toBeDefined();
  });

  it("carries the room's own unsettled question, in their words", () => {
    const sheds = about(decisions, "shed");
    expect(sheds, "the six sheds were not read back").toMatchObject({ attached: "group" });
    const said = readBacks(decisions).find((record) => record["attached"] === "group");
    expect(said, "no read-back carried the group's own question").toBeDefined();
    expect(String(said?.["text"])).toContain("Got it:");
    expect(String(said?.["text"])).toContain("Did that get settled?");
    // Quoted rather than paraphrased, so the words are somebody else's.
    expect(String(said?.["text"])).toMatch(/\b(sign|signs|signed|signing)\b/);
    expect(said).toMatchObject({ spoken: true });
    expect(
      decisions.turns.filter(isSottoTurn).map((turn) => turn.text),
    ).toContainEqual(expect.stringContaining("Got it:"));
  });

  it("keeps its own arithmetic on the screen, pinned to the decision", () => {
    const launch = about(decisions, "saturday", "mechanic", "coffee", "launch");
    expect(launch?.["found"], "Sotto saw nothing wrong with the launch costs").toBe("own");
    const pinned = decisions.cards.filter(
      (card) => card.note !== undefined && card.raised === true,
    );
    expect(pinned.length, "the correction was not pinned beside the decision").toBeGreaterThan(0);
    expect(pinned.at(-1)?.note).toContain("Still open against");
    expect(pinned.at(-1)?.forward).toBe(true);
    // And nothing of Sotto's own reading was said at the default boldness.
    expect(readBacks(decisions).filter((record) => record["attached"] === "own")).toEqual([]);
  });

  it("attaches nothing to a decision with nothing open against it", () => {
    expect(about(decisions, "paper")).toMatchObject({ found: null, attached: null });
  });

  it("attaches nothing on a conversation that left nothing open", () => {
    for (const closing of closings(control)) {
      expect(closing, String(closing["decision"])).toMatchObject({ attached: null });
    }
    expect(readBacks(control).filter((record) => record["attached"] !== null)).toEqual([]);
  });
});
