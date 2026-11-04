import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionLogRecord } from "../../shared/candidates.js";
import type { ResearchLogLine, ResearchPacket } from "../../shared/research.js";
import type { StageCard } from "../../shared/cards.js";
import { FREQUENCY_LIMITS } from "../../shared/policy.js";
import {
  SPOKEN_CONTRIBUTION_STAGE,
  type SpokenContributionRecord,
} from "../../shared/spoken.js";
import { sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { PAUSE_MS } from "../interject/policy.js";
import { SESSION_FILES } from "../session/SessionStore.js";
import { loadTiming } from "./moments.js";
import {
  answersFrom,
  asJudgeCard,
  deliveredDecisions,
  deliveriesFrom,
  readCandidateLog,
  readResearchLog,
  readSpokenLog,
  replayFixture,
  researchFrom,
  runFixture,
  spokenFrom,
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
      sottoTurns: [],
      cards: [],
      sessionDir: null,
      durationMs: 9_000,
      candidates: 0,
      decisions: 0,
      gateCalls: [],
      researchLog: [],
      spokenLog: [],
      delivered: new Map(),
      answerLog: [],
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
      silentForMs: 3_000,
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
    const tooSoonAtMs = 9_000 + PAUSE_MS - 1;
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

/**
 * What the research pipeline did, read back off `research.jsonl` (V2-019).
 *
 * The counts come off the log rather than off the stage because two of the
 * three outcomes never reach the stage at all: an unsourced packet is thrown
 * away (V2-013) and a rejected idea never becomes one (V2-012).
 */
describe("readResearchLog and researchFrom", () => {
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

  function packet(overrides: Partial<ResearchPacket> = {}): ResearchPacket {
    return {
      id: "packet-1",
      ideaId: "idea-1",
      title: "Meeting-tool market size",
      teaser: "About $2bn in 2025.",
      keyPoints: ["two vendors hold most of it", "clinics are a small slice"],
      sources: [
        { title: "A report", url: "https://example.com/report" },
        { title: "Another", url: "https://example.com/other" },
      ],
      createdAtMs: 60_000,
      latencyMs: 15_000,
      ...overrides,
    };
  }

  const log: ResearchLogLine[] = [
    { kind: "idea", atMs: 10_000, origin: "hook", idea: idea("idea-1") },
    { kind: "idea", atMs: 11_000, origin: "planner", idea: idea("idea-2") },
    { kind: "idea", atMs: 12_000, origin: "planner", idea: idea("idea-3") },
    gateLine("idea-1", "queued", "local"),
    gateLine("idea-2", "rejected", "local"),
    gateLine("idea-3", "failed", null),
    { kind: "start", atMs: 20_000, ideaId: "idea-1", question: "how big?", running: 1, startedInWindow: 1 },
    {
      kind: "packet",
      atMs: 60_000,
      ideaId: "idea-1",
      question: "how big is the market?",
      outcome: "ready",
      packet: packet(),
      latencyMs: 15_000,
      searched: true,
    },
    {
      kind: "card",
      atMs: 12_000,
      packetId: "packet-1",
      ideaId: "idea-1",
      title: "Meeting-tool market size",
      heldForMs: 500,
      waiting: 0,
      shownInWindow: 1,
    },
  ];

  function idea(id: string) {
    return {
      id,
      topic: "market size",
      question: "how big is the market?",
      why: "they are guessing",
      sourceTurnIds: ["0:4"],
      origin: "hook" as const,
      createdAtMs: 10_000,
    };
  }

  function gateLine(
    ideaId: string,
    decision: "queued" | "rejected" | "failed",
    where: "local" | "cloud" | null,
  ): ResearchLogLine {
    return {
      kind: "gate",
      atMs: 15_000,
      ideaId,
      question: "how big is the market?",
      decision,
      where,
      score: decision === "queued" ? 0.8 : 0.2,
      threshold: 0.6,
      latencyMs: 20_000,
    };
  }

  function replay(lines: ResearchLogLine[]): ReplayResult {
    return {
      turns: [turn("0:0", 1_000, 4_000), turn("0:1", 6_000, 9_000)],
      sottoTurns: [],
      cards: [],
      sessionDir: null,
      durationMs: 9_000,
      candidates: 0,
      decisions: 0,
      gateCalls: [],
      researchLog: lines,
      spokenLog: [],
      delivered: new Map(),
      answerLog: [],
    };
  }

  it("is empty for a session that never looked anything up", () => {
    expect(readResearchLog(null)).toEqual([]);
    expect(readResearchLog(root)).toEqual([]);
  });

  it("reads the lines a session wrote, skipping a half-written last one", () => {
    const dir = join(root, "session");
    mkdirSync(dir);
    const lines = [JSON.stringify(log[0]), JSON.stringify(log[3]), '{"kind":"gate",'];
    writeFileSync(join(dir, SESSION_FILES.research), `${lines.join("\n")}\n`);
    expect(readResearchLog(dir)).toHaveLength(2);
  });

  it("counts the ideas, the verdicts and the packets, and places each card", () => {
    const research = researchFrom(replay(log));
    expect(research).toMatchObject({
      ideas: 3,
      queued: 1,
      rejected: 1,
      gateFailed: 1,
      localGateCalls: 2,
      packets: 1,
      unsourced: 0,
      failed: 0,
    });
    expect(research.cards).toHaveLength(1);
    expect(research.cards[0]).toMatchObject({
      cardId: "research-packet-1",
      packetId: "packet-1",
      ideaId: "idea-1",
      question: "how big is the market?",
      teaser: "About $2bn in 2025.",
      sources: 2,
      deliveredAtMs: 12_000,
      // The room had been quiet since the last turn closed at 9 s.
      inPause: true,
      atSessionEnd: false,
    });
  });

  it("counts an unsourced packet, which never became a card at all", () => {
    const research = researchFrom(
      replay([
        {
          kind: "packet",
          atMs: 60_000,
          ideaId: "idea-1",
          question: "how big?",
          outcome: "unsourced",
          title: "Market size",
          latencyMs: 12_000,
          searched: true,
        },
        {
          kind: "packet",
          atMs: 70_000,
          ideaId: "idea-2",
          question: "and who funds it?",
          outcome: "failed",
          latencyMs: 9_000,
          searched: false,
          error: "the call did not come back",
        },
      ]),
    );
    expect(research).toMatchObject({ packets: 0, unsourced: 1, failed: 1 });
    expect(research.cards).toEqual([]);
  });

  it("keeps a packet's first appearance, not the moment it was asked for", () => {
    const broughtForward = [
      ...log,
      {
        kind: "card" as const,
        atMs: 150_000,
        packetId: "packet-1",
        ideaId: "idea-1",
        title: "Meeting-tool market size",
        heldForMs: 0,
        waiting: 0,
        shownInWindow: 1,
        broughtForward: true as const,
      },
    ];
    const research = researchFrom(replay(broughtForward));
    expect(research.cards).toHaveLength(1);
    expect(research.cards[0]?.deliveredAtMs).toBe(12_000);
  });

  it("measures the card's pause itself, as a delivery's is measured", () => {
    const midTurn = log.map((line) =>
      line.kind === "card" ? { ...line, atMs: 7_000 } : line,
    );
    const research = researchFrom(replay(midTurn));
    expect(research.cards[0]?.inPause).toBe(false);
    expect(research.cards[0]?.pause.speaking).toBe(true);
  });

  it("gives the judge the card's own words, with the question as the reason", () => {
    const [card] = researchFrom(replay(log)).cards;
    expect(card).toBeDefined();
    expect(asJudgeCard(card!)).toEqual({
      cardId: "research-packet-1",
      headline: "Research ready: Meeting-tool market size",
      detail:
        "About $2bn in 2025.\n\n- two vendors hold most of it\n- clinics are a small slice",
      whyNow: "how big is the market?",
    });
  });
});

/**
 * Reading unprompted speech back off the session folder (PRD V3-010).
 *
 * `timing.jsonl` is the pipeline's whole diary — two dozen stages, written as
 * `unknown` — so what is checked here is that the reader takes exactly the
 * `spoken_contribution` lines out of it, in order, and places each against
 * the turns the replay produced.
 */
describe("readSpokenLog", () => {
  function spokenLine(
    overrides: Partial<SpokenContributionRecord> = {},
  ): SpokenContributionRecord {
    return {
      stage: SPOKEN_CONTRIBUTION_STAGE,
      kind: "reserve",
      atMs: 60_000,
      ideaId: "idea-1",
      turnId: "0:7",
      topic: "the drive time",
      spoken: true,
      text: "I'll check the drive time.",
      questionToReserveMs: 2_400,
      ...overrides,
    };
  }

  function write(lines: unknown[]): string {
    const dir = join(root, "session");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, SESSION_FILES.timing),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    return dir;
  }

  it("takes the spoken lines out of the diary and leaves the rest", () => {
    const dir = write([
      { stage: "turn_final", atMs: 59_000, turnId: "0:7" },
      spokenLine(),
      { stage: "board_complete", atMs: 61_000 },
      spokenLine({ kind: "answer", atMs: 81_000, text: "About two hours fifteen." }),
    ]);
    const log = readSpokenLog(dir);
    expect(log.map((one) => one.kind)).toEqual(["reserve", "answer"]);
  });

  it("is empty for a session with no folder and for one that said nothing", () => {
    expect(readSpokenLog(null)).toEqual([]);
    expect(readSpokenLog(root)).toEqual([]);
  });

  it("drops a line from a version of the pipeline this one does not know", () => {
    const dir = write([spokenLine({ kind: "serenade" as never }), spokenLine()]);
    expect(readSpokenLog(dir)).toHaveLength(1);
  });

  it("places each line against the turns, in log order", () => {
    const claim = spokenLine();
    const replay: ReplayResult = {
      turns: [
        {
          turnId: "0:7",
          speaker: "A",
          text: "and I have no idea how long the drive is",
          final: true,
          startMs: 4_000,
          endMs: 9_000,
          speakerMappingUncertain: false,
        },
      ],
      sottoTurns: [
        sottoTurn({
          utteranceId: "reserve-idea-1",
          text: claim.text,
          startMs: 7_000,
          interrupted: false,
        }),
      ],
      cards: [],
      sessionDir: null,
      durationMs: 9_000,
      candidates: 0,
      decisions: 0,
      gateCalls: [],
      researchLog: [],
      spokenLog: [claim],
      delivered: new Map(),
      answerLog: [],
    };
    const [one] = spokenFrom(replay);
    expect(one?.id).toBe("spoken-0");
    expect(one?.atStreamMs).toBe(7_000);
    // The room was still mid-turn at 7s, so Sotto spoke into it.
    expect(one?.inPause).toBe(false);
  });
});

/**
 * V3-014: whether the script asked for each answer, read off the one fixture
 * built for it. `followups` addresses Sotto by name on lines 3 and 18 and
 * carries on without the name on lines 4 and 5; every other line is somebody
 * talking to somebody else.
 */
describe("answersFrom", () => {
  const timing = loadTiming("followups");
  /** One final turn per scripted line, named after its index. */
  const finals: TurnUpdate[] = timing.lines.map((line) => ({
    turnId: `0:${line.index}`,
    speaker: line.speaker,
    text: `line ${line.index}`,
    final: true,
    startMs: line.startMs,
    endMs: line.endMs,
    speakerMappingUncertain: false,
  }));

  function answered(turnId: string | null): ReturnType<typeof answersFrom>[number] | undefined {
    const replay = {
      turns: finals,
      sottoTurns: [],
      cards: [],
      sessionDir: null,
      durationMs: 126_000,
      candidates: 0,
      decisions: 0,
      gateCalls: [],
      researchLog: [],
      spokenLog: [],
      delivered: new Map(),
      answerLog: [
        {
          kind: "answer" as const,
          id: "ans-1",
          question: "what should drinks cost?",
          askedBy: "A",
          headline: "about £15 a head",
          detailMd: "",
          citations: [],
          artifacts: [],
          status: "done" as const,
          createdAtMs: 20_000,
          latencyMs: 1_000,
          spokenText: "",
          ackMs: null,
          firstAudioMs: null,
          firstLineMs: null,
          continuationMs: null,
          packetIds: [],
          usedPacketIds: [],
          turnId,
        },
      ],
    } satisfies ReplayResult;
    return answersFrom("followups", replay, finals)[0];
  }

  it("counts an answer to a line that says Sotto's name as asked for", () => {
    expect(answered("0:3")?.addressed).toBe(true);
    expect(answered("0:18")?.addressed).toBe(true);
  });

  it("counts an answer to a scripted follow-up as asked for", () => {
    expect(answered("0:4")?.addressed).toBe(true);
    expect(answered("0:5")?.addressed).toBe(true);
  });

  it("counts an answer to the turn the pair addressed to each other as false", () => {
    expect(answered("0:6")?.addressed).toBe(false);
    expect(answered("0:12")?.addressed).toBe(false);
  });

  it("takes a typed question as addressed, since somebody typed it", () => {
    expect(answered(null)?.addressed).toBe(true);
  });
});
