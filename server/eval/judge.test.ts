import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeliveryRecord } from "../../shared/eval.js";
import type { FixtureScript, PlantedMoment } from "../../shared/fixtures.js";
import type { GroundedCall, GroundedReply, ModelClient, StructuredCall } from "../model/client.js";
import { Judge, JudgeCache, judgeKey, renderJudgeRequest } from "./judge.js";

const quiet = { log: () => {}, warn: () => {} };

/** A model that answers whatever it is told to, and counts the asking. */
class FakeModel implements ModelClient {
  readonly calls: StructuredCall[] = [];
  constructor(private reply: unknown | (() => unknown)) {}

  structured(call: StructuredCall): Promise<unknown> {
    this.calls.push(call);
    const reply = typeof this.reply === "function" ? (this.reply as () => unknown)() : this.reply;
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply);
  }

  grounded(_call: GroundedCall): Promise<GroundedReply> {
    throw new Error("the judge never searches");
  }
}

const moment: PlantedMoment = {
  id: "budget-contradiction",
  type: "contradiction",
  setupLines: [1],
  triggerLine: 3,
  deadlineLine: 5,
  expectedLevel: "interject",
  description: "A $4,000 budget is agreed early and contradicted later.",
};

const script: FixtureScript = {
  lines: [
    { speaker: "A", text: "Right, where are we.", pauseAfterMs: 400 },
    { speaker: "B", text: "We have four thousand dollars and that is the lot.", pauseAfterMs: 400 },
    { speaker: "A", text: "Understood.", pauseAfterMs: 400 },
    { speaker: "B", text: "So the booth alone is five thousand, fine.", pauseAfterMs: 400 },
    { speaker: "A", text: "Sure.", pauseAfterMs: 400 },
    { speaker: "B", text: "Moving on.", pauseAfterMs: 400 },
  ],
  wakeQuestions: [],
  moments: [moment],
};

const delivery: DeliveryRecord = {
  cardId: "card-cand-1",
  candidateId: "cand-1",
  type: "contradiction",
  level: "interject",
  headline: "The booth is $5,000 against a $4,000 budget",
  detail: "B set the budget at $4,000 and has just costed the booth above it.",
  whyNow: "before the booth is agreed",
  deliveredAtMs: 41_000,
  inPause: true,
  pause: { speaking: false, silentForMs: 2_000 },
  reason: "delivered",
  score: 0.8,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sotto-judge-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("judgeKey", () => {
  const base = {
    headline: "h",
    detail: "d",
    fixture: "moment-contradiction",
    momentId: "m1",
    promptHash: "abc",
  };

  it("is the same for the same card, moment and prompt", () => {
    expect(judgeKey(base)).toBe(judgeKey({ ...base }));
  });

  it("changes with the card's words, the moment, the fixture and the prompt", () => {
    const keys = new Set([
      judgeKey(base),
      judgeKey({ ...base, headline: "other" }),
      judgeKey({ ...base, detail: "other" }),
      judgeKey({ ...base, momentId: "m2" }),
      judgeKey({ ...base, fixture: "moment-mixed" }),
      judgeKey({ ...base, promptHash: "def" }),
    ]);
    expect(keys.size).toBe(6);
  });
});

describe("JudgeCache", () => {
  it("stores and returns a verdict", () => {
    const cache = new JudgeCache(dir);
    expect(cache.get("nothing-here")).toBeNull();
    cache.put({
      key: "k1",
      fixture: "moment-contradiction",
      momentId: "m1",
      cardId: "card-cand-1",
      headline: "h",
      matches: true,
      reason: "same issue",
      judgedAt: "2026-10-28T00:00:00.000Z",
      model: "muse-spark-1.3",
      promptHash: "abc",
    });
    expect(cache.get("k1")?.matches).toBe(true);
    expect(cache.get("k1")?.reason).toBe("same issue");
  });

  it("re-judges rather than trusting a file it cannot read", () => {
    const cache = new JudgeCache(dir);
    cache.put({
      key: "k2",
      fixture: "f",
      momentId: "m",
      cardId: "c",
      headline: "h",
      matches: true,
      reason: "r",
      judgedAt: "",
      model: "",
      promptHash: "",
    });
    rmSync(join(dir, "k2.json"));
    expect(cache.get("k2")).toBeNull();
  });
});

describe("Judge", () => {
  const pair = { fixture: "moment-contradiction", moment, script, delivery };

  it("asks the model once and serves the second ask from disk", async () => {
    const model = new FakeModel({ matches: true, reason: "the same budget clash" });
    const judge = new Judge({
      model,
      cache: new JudgeCache(dir),
      modelName: "muse-spark-1.3",
      logger: quiet,
    });

    const first = await judge.judge(pair);
    expect(first).toEqual({
      cardId: "card-cand-1",
      momentId: "budget-contradiction",
      matches: true,
      reason: "the same budget clash",
      cached: false,
    });
    expect(model.calls).toHaveLength(1);
    expect(readdirSync(dir)).toHaveLength(1);

    // A second judge, with the same cache: the verdict comes off disk.
    const second = new Judge({
      model,
      cache: new JudgeCache(dir),
      modelName: "muse-spark-1.3",
      logger: quiet,
    });
    const again = await second.judge(pair);
    expect(again.matches).toBe(true);
    expect(again.cached).toBe(true);
    expect(model.calls).toHaveLength(1);
    expect(second.counts()).toEqual({ calls: 0, cacheHits: 1 });
  });

  it("sends the prompt, the schema and both sides of the comparison", async () => {
    const model = new FakeModel({ matches: false, reason: "a different problem" });
    const judge = new Judge({
      model,
      cache: new JudgeCache(dir),
      modelName: "muse-spark-1.3",
      logger: quiet,
    });
    await judge.judge(pair);
    const call = model.calls[0];
    expect(call?.schemaName).toBe("moment_match");
    expect(call?.system).toContain("planted");
    expect(call?.user).toContain(moment.description);
    expect(call?.user).toContain(delivery.headline);
  });

  it("records a failed call as a non-match rather than losing the run", async () => {
    const model = new FakeModel(new Error("gateway timeout"));
    const judge = new Judge({
      model,
      cache: new JudgeCache(dir),
      modelName: "muse-spark-1.3",
      logger: quiet,
    });
    const result = await judge.judge(pair);
    expect(result.matches).toBe(false);
    expect(result.error).toContain("gateway timeout");
    // Nothing is cached, so a rerun tries again.
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("treats a reply that does not fit the schema as a failure", async () => {
    const model = new FakeModel({ matches: "probably" });
    const judge = new Judge({
      model,
      cache: new JudgeCache(dir),
      modelName: "muse-spark-1.3",
      logger: quiet,
    });
    const result = await judge.judge(pair);
    expect(result.matches).toBe(false);
    expect(result.error).toContain("schema");
  });
});

describe("renderJudgeRequest", () => {
  it("quotes the conversation as well as the script's description", () => {
    const rendered = renderJudgeRequest({
      fixture: "moment-contradiction",
      moment,
      script,
      delivery,
    });
    expect(rendered).toContain("We have four thousand dollars");
    expect(rendered).toContain("So the booth alone is five thousand");
    expect(rendered).toContain(delivery.whyNow);
  });

  it("says so plainly when a card had no detail", () => {
    const rendered = renderJudgeRequest({
      fixture: "moment-contradiction",
      moment,
      script,
      delivery: { ...delivery, detail: "", whyNow: "" },
    });
    expect(rendered).toContain("Detail: _none_");
    expect(rendered).toContain("_not given_");
  });
});
