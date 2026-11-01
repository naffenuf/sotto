import { describe, expect, it } from "vitest";
import { defaultPolicySettings } from "../../shared/policy.js";
import { SPOKEN_CONTRIBUTION_STAGE } from "../../shared/spoken.js";
import { renderShadowReport, shadowReportPath, VERDICTS } from "./report.js";
import type { ShadowRunRecord, ShadowSpoken } from "./shadow.js";

function run(over: Partial<ShadowRunRecord> = {}): ShadowRunRecord {
  return {
    session: "2026-10-30_0919-mic",
    source: "mic",
    recordedAt: "2026-10-30T09:19:00.000Z",
    runAt: "2026-11-01T11:00:00.000Z",
    gitCommit: "abc1234",
    settings: defaultPolicySettings(),
    gate: "spark",
    voice: "null sink",
    sessionDir: "shadow/sessions/2026-11-01_1100-events-2026-10-30_0919-mic",
    durationMs: 230_000,
    finalTurns: 24,
    elapsedMs: 180_000,
    spoken: [],
    questions: [],
    addressedTurns: 0,
    cards: [],
    suppressed: [],
    ...over,
  };
}

function spoken(over: Partial<ShadowSpoken["record"]> = {}): ShadowSpoken {
  return {
    record: {
      stage: SPOKEN_CONTRIBUTION_STAGE,
      kind: "answer",
      atMs: 95_000,
      ideaId: "idea-1",
      turnId: "0:7",
      topic: "the gate code",
      spoken: true,
      text: "On the gate code: most gardens rotate it every season.",
      questionToSpeechMs: 18_400,
      pauseWaitMs: 1_200,
      stillCurrent: { verdict: "current", agrees: false, latencyMs: 1_500, fallback: false, turns: 2 },
      ...over,
    },
    trigger: {
      turnId: "0:7",
      speaker: "Sam",
      text: "Has the gate code changed again?",
      startMs: 70_000,
      endMs: 76_600,
    },
    sinceTriggerMs: 18_400,
    inPause: true,
  };
}

describe("renderShadowReport", () => {
  it("names the file after the session it replayed", () => {
    expect(shadowReportPath("2026-10-30_0919-mic")).toBe("tasks/shadow-2026-10-30_0919-mic.md");
  });

  it("leads with the unprompted lines, each with its trigger and a verdict blank", () => {
    const report = renderShadowReport(run({ spoken: [spoken()] }));

    expect(report).toContain("# Shadow run: 2026-10-30_0919-mic");
    expect(report).toContain("## What Sotto would have said out loud");
    // The trigger turn is quoted, so a reader judges the line against what
    // was actually said rather than against the topic.
    expect(report).toContain("> **Sam** (01:10): Has the gate code changed again?");
    expect(report).toContain("On the gate code: most gardens rotate it every season.");
    expect(report).toContain("- From the trigger turn: 18.4s");
    expect(report).toContain("really quiet");
    expect(report).toContain("- Still current: current, over 2 turn(s), 1.5s call");
    expect(report).toContain(`_(${VERDICTS})_`);
  });

  it("puts a line that was not said in the same list, with the reason", () => {
    const quiet = spoken({ spoken: false, reason: "no_gap" });
    delete quiet.record.pauseWaitMs;
    const report = renderShadowReport(run({ spoken: [quiet] }));

    expect(report).toContain("**not said** (no_gap)");
    expect(report).toContain("- Pause: none was found (no_gap)");
  });

  it("lists every classification, not only the open questions", () => {
    const report = renderShadowReport(
      run({
        addressedTurns: 2,
        questions: [
          {
            turnId: "0:3",
            kind: "rhetorical",
            atMs: 40_000,
            latencyMs: 1_900,
            fallback: false,
            turn: { turnId: "0:3", speaker: "Alex", text: "Who even uses fax?", startMs: 36_000, endMs: 39_000 },
          },
          {
            turnId: "0:9",
            kind: "decision",
            atMs: 120_000,
            latencyMs: 2_100,
            fallback: false,
            closing: true,
            decision: "six gardens, next Monday",
            turn: null,
          },
        ],
      }),
    );

    expect(report).toContain("2 classification(s): 1 rhetorical, 1 decision");
    expect(report).toContain("2 further turn(s) addressed Sotto by name");
    // The last cell is left empty for the reader's own verdict.
    expect(report).toContain("| 00:40 | rhetorical | Alex | Who even uses fax? | 1.9s |  |");
    expect(report).toContain("decision + closing");
  });

  it("says plainly when Sotto would have stayed silent throughout", () => {
    const report = renderShadowReport(run());

    expect(report).toContain("_Sotto would have said nothing out loud in this conversation._");
    expect(report).toContain("_Nothing reached the stage._");
    expect(report).toContain("_The policy held nothing back._");
  });

  it("ends with the policy's silent decisions, scored and reasoned", () => {
    const report = renderShadowReport(
      run({
        suppressed: [
          {
            candidateId: "cand-2",
            headline: "Do volunteers want a board at all?",
            type: "untested_assumption",
            score: 0.58,
            reason: "below threshold",
          },
        ],
      }),
    );

    expect(report).toContain("## What Sotto almost said");
    expect(report).toContain(
      "- **Do volunteers want a board at all?** — below threshold _(untested assumption, score 0.58)_",
    );
  });

  it("reports a replay that could not start instead of an empty run", () => {
    const report = renderShadowReport(run({ error: "ENOENT: no such file" }));

    expect(report).toContain("## The replay failed");
    expect(report).toContain("ENOENT: no such file");
    expect(report).not.toContain("## Questions the classifier heard");
  });
});
