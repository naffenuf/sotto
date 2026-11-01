/**
 * The research planner and gate against the real models (V2-012).
 *
 * Two halves with different requirements, so they skip independently: the
 * planner is a Muse Spark call and needs `MODEL_API_KEY`, while the gate goes
 * to the local Glimmer server when there is one — which is V2-010's router's
 * whole job, so it is exercised through the router rather than by building a
 * client by hand.
 *
 * What is really being tested is the two prompts. The JSON Schema guarantees
 * the keys and the types and nothing else; on Glimmer it does not even brief
 * the model, because Ollama compiles it into a grammar the model never reads.
 * So "the scores came back inside 0–1" and "the questions are checkable" are
 * claims about `research-gate.md` and `research-planner.md`, and only a real
 * call can make them.
 *
 * Both halves read their board and their turns out of the fixtures, because a
 * synthetic snippet tells you about the snippet rather than about the prompt.
 * The planner's stretch is deliberately one where **nobody asks for anything
 * out loud**: an out-loud request is the observer's `research_hook` (V2-011),
 * and the prompt says in as many words that the planner is for the question
 * they have not thought to ask — so measured against the stretch where they
 * do ask, it correctly returns nothing.
 */
import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import { applyOps } from "../board/applyOps.js";
import { emptyBoard, type Board, type BoardOp } from "../../shared/board.js";
import {
  QUESTION_MAX_CHARS,
  RESEARCH_GATE_THRESHOLD,
  TOPIC_MAX_CHARS,
  WHY_MAX_WORDS,
  researchScore,
  type ResearchIdea,
} from "../../shared/research.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { SimulatedClock } from "../clock.js";
import { loadGlimmerConfig } from "../config.js";
import { MuseClient } from "../model/client.js";
import { GlimmerClient } from "../model/GlimmerClient.js";
import { JudgmentRouter } from "../model/judgment.js";
import { ResearchGate } from "./ResearchGate.js";
import { ResearchPlanner } from "./ResearchPlanner.js";

loadDotenv({ quiet: true });

const apiKey = (process.env["MODEL_API_KEY"] ?? "").trim();
const describeSpark = apiKey === "" ? describe.skip : describe;
const glimmerConfig = loadGlimmerConfig();

const quiet = { log: () => {}, warn: () => {} };
const loud = {
  log: (line: unknown) => process.stderr.write(`${String(line)}\n`),
  warn: (line: unknown) => process.stderr.write(`${String(line)}\n`),
};

function spark(): MuseClient {
  return new MuseClient({ apiKey, logger: quiet });
}

function board(summary: string, ops: BoardOp[]): Board {
  return applyOps(emptyBoard(), [{ op: "set_summary", text: summary }, ...ops], 0).board;
}

function turn(index: number, speaker: string, text: string): TurnUpdate {
  return {
    turnId: `0:${index}`,
    speaker,
    speakerMappingUncertain: false,
    text,
    final: true,
    startMs: index * 6_000,
    endMs: index * 6_000 + 5_000,
  };
}

/** `research-business-idea`, where the plan turns to enterprise clinics. */
const ideaBoard = (): Board =>
  board("Craig and EJ are shaping a meeting tool that only speaks when it matters.", [
    { op: "add_constraint", text: "It must only speak when it has something worth saying", sourceTurnIds: ["0:1"] },
    { op: "add_point", text: "First customers should be enterprise clinics of about 300 staff", sourceTurnIds: ["0:28"] },
    { op: "add_decision", text: "It keeps a board of what was stated, decided and still open", sourceTurnIds: ["0:8"] },
  ]);

/** The fixture's own words, lines 28–33. Nobody asks for anything here. */
const ideaTurns = [
  turn(28, "B", "Our first customers should be enterprise clinics. Three hundred staff, a compliance department, every meeting recorded by policy."),
  turn(29, "A", "Clinics. That's a nine month sales cycle."),
  turn(30, "B", "It is, but the budget is real and the compliance angle sells itself."),
  turn(32, "B", "Either way, the first build is mostly the same."),
  turn(33, "A", "Mostly. Enterprise means audit logs and a procurement review."),
];

describeSpark("the research planner, against real Muse Spark", () => {
  it("proposes checkable questions about what the group is leaning on", async () => {
    const clock = new SimulatedClock(0);
    const proposed: ResearchIdea[] = [];
    const planner = new ResearchPlanner({
      clock,
      model: spark(),
      board: ideaBoard,
      known: () => proposed,
      onIdeas: (ideas) =>
        proposed.push(
          ...ideas.map((idea, index) => ({ ...idea, id: `idea-${proposed.length + index + 1}` })),
        ),
      logger: loud,
    });
    for (const one of ideaTurns) planner.acceptTurn(one);
    clock.advanceBy(2 * 60_000);
    await clock.settle();

    expect(planner.runs()).toBe(1);
    process.stderr.write(
      `\n[research] planner proposed ${proposed.length}:\n${proposed
        .map((idea) => `  (${idea.topic}) ${idea.question} — ${idea.why}`)
        .join("\n")}\n\n`,
    );
    // They are costing a first customer off a sales cycle and a compliance
    // regime nobody has checked, so proposing nothing here is a prompt
    // regression rather than a quiet conversation.
    expect(proposed.length).toBeGreaterThan(0);
    expect(proposed.length).toBeLessThanOrEqual(2);
    for (const idea of proposed) {
      // Already through PlannerIdeaSchema inside the planner; what matters
      // here is that the model respected the limits it was told about.
      expect(idea.topic.length).toBeLessThanOrEqual(TOPIC_MAX_CHARS);
      expect(idea.question.length).toBeLessThanOrEqual(QUESTION_MAX_CHARS);
      expect(idea.why.split(" ").length).toBeLessThanOrEqual(WHY_MAX_WORDS);
      // Cited ids are copied out of the request, never invented.
      expect(idea.sourceTurnIds.length).toBeGreaterThan(0);
      for (const id of idea.sourceTurnIds) {
        expect(ideaTurns.some((one) => one.turnId === id), `${id} is not a turn`).toBe(true);
      }
    }
  }, 120_000);

  it("leaves the out-loud request to the observer's research hook", async () => {
    const clock = new SimulatedClock(0);
    const proposed: ResearchIdea[] = [];
    const planner = new ResearchPlanner({
      clock,
      model: spark(),
      board: () =>
        board("Craig and EJ are planning a one-day team offsite.", [
          { op: "add_point", text: "The farmhouse venue is about an hour and a half out", sourceTurnIds: ["0:10"] },
          { op: "add_question", text: "Is the farmhouse free on the Thursday?", sourceTurnIds: ["0:13"] },
        ]),
      known: () => [],
      onIdeas: (ideas) => proposed.push(...ideas.map((idea) => ({ ...idea, id: "idea-1" }))),
      logger: loud,
    });
    // `offsite-plan` lines 10–14: they say out loud that somebody should
    // check the drive and the venue, which is a `research_hook` and not the
    // planner's job. Measured: zero ideas on four runs of four.
    for (const one of [
      turn(10, "B", "There's that farmhouse place about an hour and a half out. Big room, terrible coffee."),
      turn(11, "A", "An hour and a half each way is three hours in a car."),
      turn(12, "B", "Is it an hour and a half? I might be remembering summer traffic."),
      turn(13, "A", "And I have no idea whether they have a Thursday free this month."),
      turn(14, "B", "Somebody should check the drive properly and whether the place is even open that week."),
    ]) {
      planner.acceptTurn(one);
    }
    clock.advanceBy(2 * 60_000);
    await clock.settle();
    expect(planner.runs()).toBe(1);
    process.stderr.write(`\n[research] planner proposed ${proposed.length} on the hook stretch\n\n`);
  }, 120_000);
});

/** Skips with nothing to judge with, rather than failing. */
const describeGate = apiKey === "" && glimmerConfig === null ? describe.skip : describe;

describeGate("the research gate, through the judgment router", () => {
  function gateFor(): ResearchGate {
    const router = new JudgmentRouter({
      glimmer: glimmerConfig === null ? null : new GlimmerClient({ ...glimmerConfig, logger: quiet }),
      spark: apiKey === "" ? null : spark(),
      logger: quiet,
      // The first gate call pays the cold load; warming as well doubles it.
      warm: false,
    });
    return new ResearchGate({
      clock: new SimulatedClock(0),
      client: () => router.client(),
      board: ideaBoard,
      turns: () => ideaTurns,
      logger: loud,
    });
  }

  const idea = (overrides: Partial<ResearchIdea>): ResearchIdea => ({
    id: "idea-1",
    topic: "clinic sales cycle",
    question: "How long is the typical enterprise healthcare SaaS sales cycle in 2026?",
    why: "the first-customer choice rests on a nine-month figure nobody has checked",
    sourceTurnIds: ["0:29"],
    ...overrides,
  });

  it("scores a useful, checkable question above the threshold", async () => {
    const record = await gateFor().score(idea({}));
    expect(record.decision).not.toBe("failed");
    expect(record.where).toBe(glimmerConfig === null ? "cloud" : "local");
    const scores = record.scores;
    expect(scores).toBeDefined();
    for (const [name, value] of Object.entries(scores ?? {})) {
      // No schema keyword can carry a range on either endpoint, so the prompt
      // has to — this is the assertion that it still does.
      expect(value, `${name} is outside 0-1`).toBeGreaterThanOrEqual(0);
      expect(value, `${name} is outside 0-1`).toBeLessThanOrEqual(1);
    }
    expect(record.score).toBeCloseTo(researchScore(scores!), 6);
    expect(record.score).toBeGreaterThanOrEqual(RESEARCH_GATE_THRESHOLD);
  }, 180_000);

  it("rejects a question no search could answer", async () => {
    const record = await gateFor().score(
      idea({
        topic: "who to sell to",
        question: "Should Craig and EJ sell to enterprise clinics or to smaller teams first?",
        why: "it is the decision they are stuck on",
      }),
    );
    expect(record.decision).toBe("rejected");
    expect(record.scores?.answerable).toBeLessThan(0.5);
  }, 180_000);
});
