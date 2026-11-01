/**
 * The end-to-end check's judgement, without the network (PRD US-021).
 *
 * `npm run e2e` spends five minutes and real money producing two records —
 * what reached the event bus and what landed in the session folder — and then
 * decides everything from them. Those decisions are pure, so they are tested
 * here against hand-built records: a run that should pass, and then one thing
 * wrong at a time. The builders default to a passing `brainstorm`.
 */
import type { AnswerLogRecord } from "../../shared/answers.js";
import { emptyBoard, type Board, type Item } from "../../shared/board.js";
import type { DecisionLogRecord } from "../../shared/candidates.js";
import type { StageCard } from "../../shared/cards.js";
import type { E2eFiles, E2eObserved, Stamped } from "../../shared/e2e.js";
import type { MomentRecord } from "../../shared/eval.js";
import { DEFAULT_CHATTINESS, thresholdsFor } from "../../shared/policy.js";
import type { SessionRecord } from "../../shared/session.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { defaultSettings } from "../../shared/session.js";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_WAKE_TRIGGERS,
  MIN_TRANSCRIPT_LINES,
  candidateIdOf,
  checkFixture,
  finalCards,
  interjections,
  spokenTriggers,
  type E2eCheckInput,
} from "./checks.js";
import { answerLatency, fixtureLatency, onWall, wallOffsetMs } from "./latency.js";
import { E2E_USAGE, parseE2eArgs } from "./options.js";
import { MAX_RUN_COST_USD, renderFixture, renderRun, runPassed } from "./report.js";

function turn(overrides: Partial<TurnUpdate> = {}): TurnUpdate {
  return {
    turnId: "s1:0",
    speaker: "A",
    text: "we should keep it simple",
    final: true,
    startMs: 0,
    endMs: 2_000,
    speakerMappingUncertain: false,
    ...overrides,
  };
}

/** `n` final turns, one every two seconds, each arriving 700 ms after its end. */
function turns(count: number): Stamped<TurnUpdate>[] {
  return Array.from({ length: count }, (_, index) => {
    const startMs = index * 2_000;
    const endMs = startMs + 1_500;
    return {
      value: turn({ turnId: `s1:${index}`, startMs, endMs }),
      atMs: endMs + 700,
    };
  });
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "p1",
    text: "ship a read-only version first",
    status: "open",
    sourceTurnIds: ["s1:0"],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

/** A board that satisfies US-009's `brainstorm` criteria. */
function fullBoard(): Board {
  return {
    ...emptyBoard(),
    summary: "The group is scoping a small tool.",
    points: [1, 2, 3, 4].map((n) => item({ id: `p${n}`, text: `point number ${n}` })),
    decisions: [item({ id: "d1", text: "build it in a week" })],
    questions: [item({ id: "q1", text: "who pays for it" })],
  };
}

function card(overrides: Partial<StageCard> = {}): StageCard {
  return {
    id: "card-cand-1",
    variant: "interject",
    state: "ready",
    createdAtMs: 10_000,
    headline: "the budget was $4,000, not $9,000",
    ...overrides,
  };
}

function answer(overrides: Partial<AnswerLogRecord> = {}): AnswerLogRecord {
  return {
    kind: "answer",
    id: "ans-1",
    turnId: "s1:9",
    question: "what do the main competitors charge per month",
    askedBy: "A",
    headline: "Rivals charge $12 to $30 a month",
    detailMd: "Most sit near $20.",
    citations: [{ url: "https://example.com/pricing", title: "Pricing" }],
    artifacts: [],
    status: "done",
    spokenText: "Rivals charge twelve to thirty dollars a month.",
    ackMs: 420,
    firstAudioMs: 2_100,
    firstLineMs: 2_100,
    continuationMs: 18_600,
    createdAtMs: 40_000,
    latencyMs: 19_000,
    packetIds: [],
    usedPacketIds: [],
    ...overrides,
  };
}

function decision(overrides: Partial<DecisionLogRecord> = {}): DecisionLogRecord {
  return {
    kind: "decision",
    atMs: 10_000,
    candidateId: "cand-1",
    headline: "the budget was $4,000, not $9,000",
    type: "contradiction",
    decision: "interject",
    reason: "delivered",
    score: 0.86,
    level: "interject",
    thresholds: thresholdsFor(DEFAULT_CHATTINESS),
    chattiness: DEFAULT_CHATTINESS,
    heldForMs: 8_000,
    turnsWaited: 2,
    ...overrides,
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "wav-brainstorm-1",
    startedAt: "2026-10-29T10:00:00.000Z",
    endedAt: "2026-10-29T10:02:05.000Z",
    source: { kind: "wav", fixture: "brainstorm" },
    speakers: { A: { name: null }, B: { name: null } },
    asrSessions: ["asr-1"],
    settings: defaultSettings(),
    ...overrides,
  };
}

function observed(overrides: Partial<E2eObserved> = {}): E2eObserved {
  return {
    fixture: "brainstorm",
    turns: turns(12),
    cards: [],
    wakeAtMs: [],
    boardPushes: 3,
    audioSeconds: 120,
    errors: [],
    sessionDir: "/tmp/e2e/wav-brainstorm-1",
    elapsedMs: 126_000,
    ...overrides,
  };
}

function files(overrides: Partial<E2eFiles> = {}): E2eFiles {
  return {
    session: session(),
    transcriptLines: 12,
    events: 1_900,
    board: fullBoard(),
    boardMarkdown: ["# Board", ...fullBoard().points.map((one) => `- ${one.text}`)].join("\n"),
    answers: [],
    decisions: {},
    candidates: 0,
    artifacts: [],
    artifactHtml: {},
    ...overrides,
  };
}

/** The `moment-contradiction` moment, as a run would resolve it. */
function moment(overrides: Partial<MomentRecord> = {}): MomentRecord {
  return {
    id: "budget-contradiction",
    type: "contradiction",
    expectedLevel: "interject",
    description: "A $4,000 budget is stated early and contradicted later.",
    triggerLine: 18,
    deadlineLine: 22,
    triggerEndMs: 90_000,
    deadlineEndMs: 104_000,
    setupTurnIds: ["s1:2"],
    triggerTurnIds: ["s1:9"],
    triggerTurnEndMs: 18_500,
    deadlineTurnEndMs: 22_500,
    ...overrides,
  };
}

/** The check input for a fixture, with whatever this test wants different. */
function input(
  fixture: string,
  observedOverrides: Partial<E2eObserved> = {},
  filesOverrides: Partial<E2eFiles> = {},
  moments: MomentRecord[] = [],
): E2eCheckInput {
  return {
    observed: observed({ fixture, ...observedOverrides }),
    files: files(filesOverrides),
    moments,
  };
}

/** Which checks failed, by name: what a failure message would say. */
function failures(checks: ReturnType<typeof checkFixture>): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.name);
}

describe("the checks common to every fixture", () => {
  it("passes a brainstorm run that did everything right", () => {
    expect(failures(checkFixture(input("brainstorm")))).toEqual([]);
  });

  it("fails when a status dot went into error", () => {
    const checks = checkFixture(input("brainstorm", { errors: ["transcription: closed 1011"] }));
    expect(failures(checks)).toEqual(["no errors"]);
    expect(checks[0]?.detail).toContain("1011");
  });

  it("fails when the session folder has no endedAt", () => {
    const checks = checkFixture(input("brainstorm", {}, { session: session({ endedAt: null }) }));
    expect(failures(checks)).toEqual(["session folder"]);
  });

  it("fails when there is no session folder at all", () => {
    expect(
      failures(checkFixture(input("brainstorm", { sessionDir: null }, { session: null }))),
    ).toContain("session folder");
  });

  it("holds brainstorm to ten transcript lines and ask-search to five", () => {
    expect(MIN_TRANSCRIPT_LINES["brainstorm"]).toBe(10);
    expect(
      failures(checkFixture(input("brainstorm", {}, { transcriptLines: 9 }))),
    ).toEqual(["transcript"]);
    // Nine is plenty for a 45-second conversation.
    const short = input("ask-search", { turns: turns(9) }, { transcriptLines: 9, answers: [answer()] });
    expect(failures(checkFixture(short))).not.toContain("transcript");
  });

  it("fails when a final turn came through empty", () => {
    const blank = turns(12);
    blank[4] = { value: turn({ turnId: "s1:4", text: "  " }), atMs: 9_000 };
    expect(failures(checkFixture(input("brainstorm", { turns: blank })))).toEqual(["transcript"]);
  });

  it("fails when the final turns arrived out of time order", () => {
    const shuffled = turns(12);
    shuffled[3] = { value: turn({ turnId: "s1:3", startMs: 0, endMs: 500 }), atMs: 7_000 };
    const checks = checkFixture(input("brainstorm", { turns: shuffled }));
    expect(failures(checks)).toEqual(["transcript"]);
    expect(checks[2]?.detail).toContain("OUT OF ORDER");
  });

  it("wants one wake trigger from the ask fixtures and none from the rest", () => {
    expect(EXPECTED_WAKE_TRIGGERS).toEqual({
      brainstorm: 0,
      "moment-contradiction": 0,
      "ask-search": 1,
      "ask-diagram": 1,
    });
    // A conversation nobody addressed Sotto in that answered anyway.
    expect(
      failures(checkFixture(input("brainstorm", {}, { answers: [answer()] }))),
    ).toContain("wake triggers");
  });

  it("counts a typed answer as no trigger at all", () => {
    expect(spokenTriggers(files({ answers: [answer({ turnId: null })] }))).toBe(0);
    expect(spokenTriggers(files({ answers: [answer()] }))).toBe(1);
  });
});

describe("the board checks", () => {
  it("fails when there is no board.json", () => {
    expect(failures(checkFixture(input("brainstorm", {}, { board: null })))).toEqual([
      "board updated",
    ]);
  });

  it("fails when nothing was ever pushed to the browser", () => {
    expect(failures(checkFixture(input("brainstorm", { boardPushes: 0 })))).toEqual([
      "board updated",
    ]);
  });

  it("fails an item that is a paragraph or cites nothing", () => {
    const wordy = fullBoard();
    wordy.points = [...wordy.points, item({ id: "p5", text: "word ".repeat(25).trim() })];
    expect(failures(checkFixture(input("brainstorm", {}, { board: wordy })))).toContain(
      "board items",
    );

    const unsourced = fullBoard();
    unsourced.points = [...unsourced.points, item({ id: "p5", sourceTurnIds: [] })];
    expect(failures(checkFixture(input("brainstorm", {}, { board: unsourced })))).toContain(
      "board items",
    );
  });

  it("holds brainstorm to US-009's shape but not the other fixtures", () => {
    const thin = { ...fullBoard(), points: [item()], summary: "" };
    expect(failures(checkFixture(input("brainstorm", {}, { board: thin })))).toEqual([
      "board shape",
      "board.md",
    ]);
    const asked = input("ask-search", { turns: turns(9) }, { board: thin, answers: [answer()] });
    expect(failures(checkFixture(asked))).not.toContain("board shape");
  });

  it("fails when board.md is missing a point that is on the board", () => {
    expect(
      failures(checkFixture(input("brainstorm", {}, { boardMarkdown: "# Board\n" }))),
    ).toEqual(["board.md"]);
  });

  it("ignores dropped items when counting the shape", () => {
    const dropped = fullBoard();
    dropped.points = dropped.points.map((one) => ({ ...one, status: "dropped" as const }));
    expect(failures(checkFixture(input("brainstorm", {}, { board: dropped })))).toContain(
      "board shape",
    );
  });
});

describe("brainstorm's silence", () => {
  it("fails when Sotto raised its hand in a conversation with no moments", () => {
    const loud = [{ value: card(), atMs: 60_000 }];
    const checks = checkFixture(input("brainstorm", { cards: loud }));
    expect(failures(checks)).toEqual(["no interjections"]);
  });

  it("allows a glow, which is not an interjection", () => {
    const quiet = [{ value: card({ variant: "glow" }), atMs: 60_000 }];
    expect(failures(checkFixture(input("brainstorm", { cards: quiet })))).toEqual([]);
  });
});

describe("moment-contradiction", () => {
  const delivered = [
    {
      value: card({ evidence: [{ turnId: "s1:9", quote: "let us spend nine thousand" }] }),
      atMs: 30_000,
    },
  ];
  const contradicted = (): Partial<E2eFiles> => ({
    board: {
      ...fullBoard(),
      constraints: [item({ id: "c1", text: "budget is $4,000", sourceTurnIds: ["s1:2"] })],
    },
    decisions: { "cand-1": decision() },
    candidates: 1,
  });

  it("passes when the constraint is on the board and the card cites the trigger", () => {
    const checks = checkFixture(
      input("moment-contradiction", { cards: delivered }, contradicted(), [moment()]),
    );
    expect(failures(checks)).toEqual([]);
    expect(checks.map((one) => one.name)).toContain("budget-contradiction caught");
  });

  it("fails when the constraint is on the board but cites no setup turn", () => {
    const elsewhere = contradicted();
    elsewhere.board = {
      ...fullBoard(),
      constraints: [item({ id: "c1", text: "budget is $4,000", sourceTurnIds: ["s1:7"] })],
    };
    expect(
      failures(
        checkFixture(input("moment-contradiction", { cards: delivered }, elsewhere, [moment()])),
      ),
    ).toEqual(["planted constraint"]);
  });

  it("fails when the board records a budget but not the planted number", () => {
    const vague = contradicted();
    vague.board = {
      ...fullBoard(),
      constraints: [item({ id: "c1", text: "we agreed a budget", sourceTurnIds: ["s1:2"] })],
    };
    expect(
      failures(
        checkFixture(input("moment-contradiction", { cards: delivered }, vague, [moment()])),
      ),
    ).toContain("planted constraint");
  });

  it("fails when nothing was delivered about the moment", () => {
    const checks = checkFixture(
      input("moment-contradiction", { cards: [] }, contradicted(), [moment()]),
    );
    expect(failures(checks)).toEqual(["budget-contradiction caught"]);
    expect(checks.at(-1)?.detail).toContain("1 candidate(s)");
  });

  it("does not accept a card of another type, however well evidenced", () => {
    const wrongType = contradicted();
    wrongType.decisions = { "cand-1": decision({ type: "untested_assumption" }) };
    expect(
      failures(
        checkFixture(input("moment-contradiction", { cards: delivered }, wrongType, [moment()])),
      ),
    ).toEqual(["budget-contradiction caught"]);
  });

  it("does not accept the right type resting on an unrelated turn", () => {
    const elsewhere = [
      { value: card({ evidence: [{ turnId: "s1:20", quote: "something else" }] }), atMs: 30_000 },
    ];
    expect(
      failures(
        checkFixture(input("moment-contradiction", { cards: elsewhere }, contradicted(), [moment()])),
      ),
    ).toEqual(["budget-contradiction caught"]);
  });

  it("accepts a glow for it: delivery is the question, not the level", () => {
    const glowed = [
      {
        value: card({ variant: "glow", evidence: [{ turnId: "s1:2", quote: "four thousand" }] }),
        atMs: 30_000,
      },
    ];
    expect(
      failures(
        checkFixture(input("moment-contradiction", { cards: glowed }, contradicted(), [moment()])),
      ),
    ).toEqual([]);
  });
});

describe("the ask fixtures", () => {
  const spoken = (overrides: Partial<StageCard> = {}): Stamped<StageCard>[] => [
    { value: card({ id: "card-ans-1", variant: "answer", state: "thinking", headline: "" }), atMs: 40_000 },
    {
      value: card({
        id: "card-ans-1",
        variant: "answer",
        state: "ready",
        headline: answer().headline,
        ...overrides,
      }),
      atMs: 59_000,
    },
  ];

  it("passes ask-search with one cited answer", () => {
    const checks = checkFixture(
      input("ask-search", { turns: turns(9), cards: spoken() }, { answers: [answer()], transcriptLines: 9 }),
    );
    expect(failures(checks)).toEqual([]);
  });

  it("fails when the answer came back as an error", () => {
    const broken = answer({ status: "error", error: "the model stopped early" });
    const checks = checkFixture(
      input("ask-search", { turns: turns(9), cards: spoken() }, { answers: [broken], transcriptLines: 9 }),
    );
    expect(failures(checks)).toContain("one answer");
    expect(checks.find((one) => one.name === "one answer")?.detail).toContain("stopped early");
  });

  it("fails a headline over the stage's limit", () => {
    const long = answer({ headline: "x".repeat(91) });
    expect(
      failures(
        checkFixture(
          input("ask-search", { turns: turns(9), cards: spoken({ headline: long.headline }) }, { answers: [long], transcriptLines: 9 }),
        ),
      ),
    ).toEqual(["answer shape"]);
  });

  it("fails when the answer named no page it had read", () => {
    const uncited = answer({ citations: [] });
    expect(
      failures(
        checkFixture(
          input("ask-search", { turns: turns(9), cards: spoken() }, { answers: [uncited], transcriptLines: 9 }),
        ),
      ),
    ).toEqual(["citations"]);
  });

  it("fails when the card did not stream under one id, thinking then ready", () => {
    const twoIds = spoken();
    twoIds[1] = { value: { ...(twoIds[1] as Stamped<StageCard>).value, id: "card-ans-2" }, atMs: 59_000 };
    expect(
      failures(
        checkFixture(
          input("ask-search", { turns: turns(9), cards: twoIds }, { answers: [answer()], transcriptLines: 9 }),
        ),
      ),
    ).toEqual(["answer card"]);
  });

  it("passes ask-diagram when the drawing is on disk and self-contained", () => {
    const drawn = answer({
      question: "can you sketch the user flow we just described as a diagram",
      artifacts: [
        {
          title: "User flow",
          path: "artifacts/01-user-flow.html",
          url: "/api/sessions/wav-ask-diagram-1/artifacts/01-user-flow.html",
        },
      ],
    });
    const checks = checkFixture(
      input(
        "ask-diagram",
        { turns: turns(9), cards: spoken({ headline: drawn.headline }) },
        {
          answers: [drawn],
          transcriptLines: 9,
          artifacts: ["01-user-flow.html"],
          artifactHtml: { "01-user-flow.html": "<html><body><svg></svg></body></html>" },
        },
      ),
    );
    expect(failures(checks)).toEqual([]);
  });

  it("fails ask-diagram when the answer drew nothing", () => {
    const words = answer({ question: "can you sketch the user flow" });
    expect(
      failures(
        checkFixture(
          input("ask-diagram", { turns: turns(9), cards: spoken() }, { answers: [words], transcriptLines: 9 }),
        ),
      ),
    ).toEqual(["one artifact", "artifact is a drawing"]);
  });

  it("fails a drawing that fetches anything", () => {
    const drawn = answer({
      question: "can you sketch the user flow",
      artifacts: [
        {
          title: "User flow",
          path: "artifacts/01-user-flow.html",
          url: "/api/sessions/wav-ask-diagram-1/artifacts/01-user-flow.html",
        },
      ],
    });
    expect(
      failures(
        checkFixture(
          input(
            "ask-diagram",
            { turns: turns(9), cards: spoken() },
            {
              answers: [drawn],
              transcriptLines: 9,
              artifacts: ["01-user-flow.html"],
              artifactHtml: {
                "01-user-flow.html": '<div><script src="https://cdn.example.com/d3.js"></script></div>',
              },
            },
          ),
        ),
      ),
    ).toEqual(["artifact is a drawing"]);
  });
});

describe("reading the records", () => {
  it("keeps only the last push of each card", () => {
    const pushes: Stamped<StageCard>[] = [
      { value: card({ id: "card-ans-1", state: "thinking", headline: "" }), atMs: 1_000 },
      { value: card({ id: "card-ans-1", state: "ready", headline: "done" }), atMs: 2_000 },
      { value: card({ id: "card-cand-2" }), atMs: 3_000 },
    ];
    expect(finalCards(pushes).map((one) => [one.id, one.state])).toEqual([
      ["card-ans-1", "ready"],
      ["card-cand-2", "ready"],
    ]);
  });

  it("finds the candidate behind a delivered card's id", () => {
    expect(candidateIdOf("card-cand-1")).toBe("cand-1");
    // An id that was never prefixed is its own candidate id.
    expect(candidateIdOf("cand-1")).toBe("cand-1");
  });

  it("counts an answer card as neither an interjection nor a glow", () => {
    const mixed = observed({
      cards: [
        { value: card({ id: "card-ans-1", variant: "answer" }), atMs: 1_000 },
        { value: card({ variant: "glow" }), atMs: 2_000 },
      ],
    });
    expect(interjections(mixed).map((one) => one.variant)).toEqual(["glow"]);
  });
});

describe("the latencies", () => {
  it("measures the lag between the audio timeline and the wall", () => {
    // Every builder turn arrives 700 ms after the audio position it reports.
    expect(wallOffsetMs(observed())).toBe(700);
    expect(onWall(observed(), 10_000)).toBe(10_700);
  });

  it("cannot place a scripted instant with no turns to measure against", () => {
    expect(wallOffsetMs(observed({ turns: [] }))).toBeNull();
    expect(onWall(observed({ turns: [] }), 10_000)).toBeNull();
  });

  it("measures wake to headline and wake to done from the indicator going up", () => {
    const run = observed({
      fixture: "ask-search",
      wakeAtMs: [38_000],
      cards: [
        { value: card({ id: "card-ans-1", variant: "answer", state: "thinking", headline: "" }), atMs: 40_000 },
        { value: card({ id: "card-ans-1", variant: "answer", state: "thinking" }), atMs: 56_400 },
        { value: card({ id: "card-ans-1", variant: "answer", state: "ready" }), atMs: 57_200 },
      ],
    });
    expect(answerLatency(run)).toEqual({ wakeToHeadlineMs: 18_400, wakeToDoneMs: 19_200 });
  });

  it("reports nothing when the answer never arrived", () => {
    expect(answerLatency(observed({ wakeAtMs: [38_000] }))).toEqual({
      wakeToHeadlineMs: null,
      wakeToDoneMs: null,
    });
  });

  it("measures a moment from its trigger turn to the card, and says if it was late", () => {
    const cards = [
      {
        value: card({ evidence: [{ turnId: "s1:9", quote: "nine thousand" }] }),
        atMs: 22_000,
      },
    ];
    const run = input(
      "moment-contradiction",
      { cards },
      { decisions: { "cand-1": decision() } },
      [moment()],
    );
    // The trigger turn ends at 18,500 in the audio, i.e. 19,200 on the wall.
    expect(fixtureLatency(run).moments).toEqual([
      { momentId: "budget-contradiction", deliveredAfterMs: 2_800, beforeDeadline: true },
    ]);
  });

  it("calls a card after the deadline line late", () => {
    const cards = [
      {
        value: card({ evidence: [{ turnId: "s1:9", quote: "nine thousand" }] }),
        atMs: 30_000,
      },
    ];
    const run = input(
      "moment-contradiction",
      { cards },
      { decisions: { "cand-1": decision() } },
      [moment()],
    );
    expect(fixtureLatency(run).moments[0]?.beforeDeadline).toBe(false);
  });

  it("reports nothing for a moment nothing was delivered about", () => {
    expect(fixtureLatency(input("moment-contradiction", {}, {}, [moment()])).moments).toEqual([
      { momentId: "budget-contradiction", deliveredAfterMs: null, beforeDeadline: null },
    ]);
  });
});

describe("the arguments", () => {
  it("runs all four conversations by default", () => {
    expect(parseE2eArgs([])).toEqual({
      fixtures: ["brainstorm", "moment-contradiction", "ask-search", "ask-diagram"],
    });
  });

  it("takes a subset, in the set's own order", () => {
    expect(parseE2eArgs(["--fixtures", "ask-diagram,brainstorm"])).toEqual({
      fixtures: ["brainstorm", "ask-diagram"],
    });
  });

  it("refuses a fixture that is not in the set, and says what is", () => {
    expect(parseE2eArgs(["--fixtures", "moment-fact"])).toEqual({
      error: 'not an end-to-end fixture: moment-fact',
    });
    expect(E2E_USAGE).toContain("ask-search");
  });

  it("refuses an empty or missing value and an unknown flag", () => {
    expect(parseE2eArgs(["--fixtures"])).toEqual({ error: "--fixtures needs a value" });
    expect(parseE2eArgs(["--fixtures", " , "])).toEqual({ error: "--fixtures was empty" });
    expect(parseE2eArgs(["--speed", "max"])).toEqual({ error: 'unknown argument "--speed"' });
  });
});

describe("the report", () => {
  const passing = (): Parameters<typeof renderRun>[0] => {
    const observedRun = observed({ fixture: "ask-search", wakeAtMs: [38_000] });
    return {
      id: "2026-10-29_120000",
      fixtures: [
        {
          fixture: "ask-search",
          sessionDir: "/tmp/e2e/wav-ask-search-1",
          elapsedMs: 70_000,
          audioSeconds: 48,
          finalTurns: 9,
          cards: 1,
          candidates: 0,
          checks: [{ name: "one answer", ok: true, detail: "1 answer(s), status done" }],
          latency: { wakeToHeadlineMs: 18_400, wakeToDoneMs: 19_200, moments: [] },
          moments: [],
        },
      ],
      usage: { calls: 6, inputTokens: 12_000, outputTokens: 9_000, reasoningTokens: 7_000 },
      audioSeconds: observedRun.audioSeconds,
      modelCostUsd: 0.053,
      asrCostUsd: 0.006,
      totalCostUsd: 0.059,
      passed: true,
    };
  };

  it("prints every check, the latencies and where the folder is", () => {
    const text = renderFixture(passing().fixtures[0]!);
    expect(text).toContain("ask-search: 9 turn(s)");
    expect(text).toContain("ok    one answer");
    expect(text).toContain("wake -> headline 18.4s, wake -> done 19.2s");
    expect(text).toContain("/tmp/e2e/wav-ask-search-1");
  });

  it("prints a moment's delay and whether it beat the deadline", () => {
    const report = passing().fixtures[0]!;
    const text = renderFixture({
      ...report,
      latency: {
        ...report.latency,
        moments: [
          { momentId: "budget-contradiction", deliveredAfterMs: 2_800, beforeDeadline: false },
        ],
      },
    });
    expect(text).toContain("budget-contradiction: trigger -> delivery 2.8s (after the deadline)");
  });

  it("says a fixture did not run rather than pretending it passed", () => {
    const report = passing().fixtures[0]!;
    const text = renderFixture({ ...report, checks: [], error: "fixture WAV is missing" });
    expect(text).toContain("FAIL  did not run: fixture WAV is missing");
  });

  it("passes only when every check held, every fixture ran and the cost fits", () => {
    const run = passing();
    expect(runPassed(run)).toBe(true);
    expect(runPassed({ ...run, fixtures: [] })).toBe(false);
    expect(
      runPassed({
        ...run,
        fixtures: [{ ...run.fixtures[0]!, error: "did not run", checks: [] }],
      }),
    ).toBe(false);
    expect(
      runPassed({
        ...run,
        fixtures: [
          {
            ...run.fixtures[0]!,
            checks: [{ name: "citations", ok: false, detail: "none" }],
          },
        ],
      }),
    ).toBe(false);
    expect(runPassed({ ...run, totalCostUsd: MAX_RUN_COST_USD })).toBe(false);
  });

  it("names the failures and prices the run", () => {
    const run = passing();
    const text = renderRun({
      ...run,
      fixtures: [
        {
          ...run.fixtures[0]!,
          checks: [
            { name: "one answer", ok: true, detail: "" },
            { name: "citations", ok: false, detail: "none" },
          ],
        },
      ],
      passed: false,
    });
    expect(text).toContain("1/2 check(s) passed; failed: ask-search: citations");
    expect(text).toContain("$0.0590");
    expect(text).toContain("of transcription");
    expect(text).toContain("E2E FAILED");
  });
});
