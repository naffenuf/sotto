/**
 * The spoken briefing, against the real model and the real voice (PRD V2-015).
 *
 * `research-business-idea` ends with somebody saying "Sotto, what did you find
 * on competitors?" — a question whose whole point is that the work is already
 * done. So the fixture is replayed at `max` through an ordinary session, which
 * researches in the background exactly as V2-012 and V2-013 left it, and the
 * answer that question produces is read back out of `answers.jsonl`: it has to
 * name the packets it used and carry their pages as its sources.
 *
 * The second half is the measurement the PRD asks for. A briefing says
 * something real within a few hundred milliseconds — the opener is the answer's
 * own utterance, so there is no acknowledgment to wait through and no holding
 * line to write (V2-008c) — while the same question with no research behind it
 * has to search first. Both numbers are logged, and they are compared rather
 * than asserted on in the abstract: the control is the *same* question, the
 * same board and the same transcript, with nothing but the packets taken away.
 *
 * The speech is real throughout, through a null sink: the ElevenLabs socket,
 * the streaming and the latencies are the live ones and nothing comes out of a
 * speaker. With no `ELEVENLABS_API_KEY` the replay still runs and only the
 * spoken comparison is skipped.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnswerLogRecord } from "../../shared/answers.js";
import type { Board } from "../../shared/board.js";
import type { StageCard } from "../../shared/cards.js";
import { FixtureScriptSchema } from "../../shared/fixtures.js";
import {
  packetsForBriefing,
  type ResearchCardRecord,
  type ResearchLogLine,
  type ResearchPacket,
  type ResearchPacketRecord,
} from "../../shared/research.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { AnswerAgent } from "../answer/AnswerAgent.js";
import { systemClock } from "../clock.js";
import { loadSottoVoiceId } from "../config.js";
import { EventBus } from "../events/bus.js";
import { MuseClient } from "../model/client.js";
import { glimmerFromEnv } from "../model/GlimmerClient.js";
import { SessionManager } from "../session/SessionManager.js";
import { SESSION_FILES, SessionStore } from "../session/SessionStore.js";
import { Speaker } from "../voice/Speaker.js";
import { nullSinkVoice } from "../voice/voiceOut.js";

// `globalSetup` runs in the main process; a test file runs in a worker.
loadDotenv({ quiet: true });

const apiKey = (process.env["MODEL_API_KEY"] ?? "").trim();
const voiceKey = (process.env["ELEVENLABS_API_KEY"] ?? "").trim();
const describeSpark = apiKey === "" ? describe.skip : describe;

const fixture = "research-business-idea";

const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const loud = {
  log: (line: unknown) => process.stderr.write(`${String(line)}\n`),
  warn: (line: unknown) => process.stderr.write(`${String(line)}\n`),
  error: (line: unknown) => process.stderr.write(`${String(line)}\n`),
};

/** Real synthesis with the audio thrown away, or screen only with no key. */
function voice() {
  return voiceKey === ""
    ? null
    : nullSinkVoice(
        () => new Speaker({ apiKey: voiceKey, voiceId: loadSottoVoiceId(), logger: quiet }),
      );
}

let root: string;
let dir: string;
let answers: AnswerLogRecord[] = [];
let research: ResearchLogLine[] = [];
let packets: ResearchPacket[] = [];
let cards: StageCard[] = [];
let finals: TurnUpdate[] = [];
let board: Board;
/** The control answer: the same question with no research behind it. */
let control: AnswerLogRecord | undefined;

/** The question the script has somebody ask at the end of the conversation. */
const question = FixtureScriptSchema.parse(
  JSON.parse(readFileSync(join("fixtures/scripts", `${fixture}.json`), "utf8")),
).wakeQuestions[0]?.question as string;

function lines<T>(file: string): T[] {
  const at = join(dir, file);
  if (!existsSync(at)) return [];
  return readFileSync(at, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

describeSpark(`briefing from the research in ${fixture}`, () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sotto-briefing-"));
    const bus = new EventBus(quiet);
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
      if (event.type === "turn" && event.turn.final && !isSottoTurn(event.turn)) {
        finals.push(event.turn);
      }
    });
    const sessions = new SessionManager({
      bus,
      apiKey,
      logger: loud,
      replaySpeed: "max",
      createStore: (info) => SessionStore.create(info, { root, logger: quiet }),
      createGlimmer: () => glimmerFromEnv(quiet),
      createVoice: voice,
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

    const folders = readdirSync(root);
    dir = join(root, folders[0] as string);
    answers = lines<AnswerLogRecord>(SESSION_FILES.answers);
    research = lines<ResearchLogLine>(SESSION_FILES.research);
    packets = research
      .filter((record): record is ResearchPacketRecord => record.kind === "packet")
      .flatMap((record) => (record.packet === undefined ? [] : [record.packet]));
    board = JSON.parse(readFileSync(join(dir, SESSION_FILES.board), "utf8")) as Board;

    // The control: the same question, the same board, the same conversation,
    // and no research at all. One extra answer call, outside the replay, so
    // the only difference between the two numbers is the packets.
    const sink = voice();
    if (sink !== null) {
      const records: AnswerLogRecord[] = [];
      const agent = new AnswerAgent({
        clock: systemClock,
        model: new MuseClient({ apiKey, logger: quiet }),
        logger: loud,
        board: () => board,
        transcript: () => finals,
        speakers: () => ({}),
        packets: () => [],
        voice: sink,
        onCard: () => {},
        onRecord: (record) => records.push(record),
      });
      agent.ask({ question, askedBy: "A", turnId: "control:1" });
      await agent.flush();
      control = records[0];
    }
  }, 25 * 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("had research ready before anybody asked for it", () => {
    process.stderr.write(
      `[briefing] ${packets.length} packet(s): ${packets
        .map((one) => `${one.id} at ${Math.round(one.createdAtMs / 1000)}s — ${one.title}`)
        .join(" | ")}\n`,
    );
    expect(packets.length, "nothing was researched, so there is nothing to brief").toBeGreaterThan(0);
    // The selection the agent makes is pure, so it can be checked against the
    // packets this run really produced.
    expect(packetsForBriefing(question, packets).length).toBeGreaterThan(0);
  });

  it("answers the wake question from at least one packet, and cites its sources", () => {
    const spoken = answers.find((record) => record.turnId !== null);
    process.stderr.write(
      `[briefing] ${JSON.stringify({
        question: spoken?.question,
        usedPacketIds: spoken?.usedPacketIds,
        packetIds: spoken?.packetIds,
        citations: spoken?.citations.map((one) => one.url),
        ackMs: spoken?.ackMs,
        firstAudioMs: spoken?.firstAudioMs,
        firstLineMs: spoken?.firstLineMs,
        latencyMs: spoken?.latencyMs,
      })}\n[briefing] said: ${spoken?.spokenText}\n`,
    );
    expect(spoken, "the wake question was never answered").toBeDefined();
    expect(spoken?.status, spoken?.error).toBe("done");
    expect(spoken?.packetIds).toEqual(packets.map((one) => one.id));
    expect((spoken?.usedPacketIds ?? []).length, "the briefing used no research").toBeGreaterThan(0);

    const used = packets.filter((one) => spoken?.usedPacketIds.includes(one.id));
    const cited = new Set(spoken?.citations.map((one) => one.url));
    expect(
      used.some((one) => one.sources.some((source) => cited.has(source.url))),
      "none of the research's sources reached the card",
    ).toBe(true);
    for (const citation of spoken?.citations ?? []) {
      expect(citation.url).toMatch(/^https?:\/\//);
    }
  });

  it("brings the research it briefed from forward on the stage, open", () => {
    const forward = cards.filter((card) => card.forward === true);
    const asked = research.filter(
      (record): record is ResearchCardRecord =>
        record.kind === "card" && record.broughtForward === true,
    );
    process.stderr.write(
      `[briefing] brought forward: ${forward.map((card) => card.id).join(", ")}\n`,
    );
    expect(forward.length, "no card came forward while Sotto spoke").toBeGreaterThan(0);
    expect(asked.map((record) => `research-${record.packetId}`)).toEqual(
      forward.map((card) => card.id),
    );
    for (const card of forward) {
      expect(card.variant).toBe("research");
      // Open means the whole of it: the key points and the sources the group
      // asked to see, and the visual when the search drew one.
      expect(card.citations?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it.skipIf(voiceKey === "")(
    "starts speaking sooner than the same question without the research",
    () => {
      const spoken = answers.find((record) => record.turnId !== null);
      process.stderr.write(
        `[briefing] firstAudioMs with packets ${spoken?.firstAudioMs} ` +
          `(ack ${spoken?.ackMs}, line ${spoken?.firstLineMs}), ` +
          `without ${control?.firstAudioMs} (ack ${control?.ackMs}, line ${control?.firstLineMs})\n` +
          `[briefing] control said: ${control?.spokenText}\n`,
      );
      expect(control?.status, control?.error).toBe("done");
      expect(spoken?.firstAudioMs).not.toBeNull();
      expect(control?.firstAudioMs).not.toBeNull();
      expect(spoken?.firstAudioMs as number).toBeLessThan(control?.firstAudioMs as number);
      // The control had nothing to brief from, so it researched nothing.
      expect(control?.usedPacketIds).toEqual([]);
    },
  );
});
