import { describe, expect, it } from "vitest";
import type { ModelClient, StructuredCall } from "./client.js";
import type { GlimmerClient, GlimmerHealth } from "./GlimmerClient.js";
import { JudgmentRouter, type JudgmentWhere } from "./judgment.js";

/** Records what it was asked, and which client was asked. */
function recorder(answer: unknown): { calls: StructuredCall[]; structured: (call: StructuredCall) => Promise<unknown> } {
  const calls: StructuredCall[] = [];
  return {
    calls,
    structured: async (call) => {
      calls.push(call);
      return answer;
    },
  };
}

function spark(answer: unknown = { from: "spark" }): ModelClient & { calls: StructuredCall[] } {
  const { calls, structured } = recorder(answer);
  return {
    calls,
    structured,
    grounded: async () => {
      throw new Error("a judgment call never searches");
    },
    prose: async () => {
      throw new Error("a judgment call is never prose");
    },
  };
}

/** Glimmer, down to the two methods the router touches. */
function glimmer(
  result: GlimmerHealth,
  answer: unknown = { from: "glimmer" },
): GlimmerClient & { calls: StructuredCall[]; warmed: number } {
  const { calls, structured } = recorder(answer);
  let warmed = 0;
  return {
    calls,
    get warmed() {
      return warmed;
    },
    health: async () => result,
    warm: () => {
      warmed += 1;
    },
    structured,
  } as unknown as GlimmerClient & { calls: StructuredCall[]; warmed: number };
}

const UP: GlimmerHealth = { ok: true, latencyMs: 4, detail: "muse-glimmer at 127.0.0.1" };
const DOWN: GlimmerHealth = { ok: false, latencyMs: 3_000, detail: "127.0.0.1 did not answer" };

const call: StructuredCall = {
  label: "research_gate",
  system: "Score it.",
  user: "An idea.",
  schemaName: "research_gate",
  schema: { type: "object" },
};

function logs(): { log: (line: string) => void; warn: (line: string) => void; lines: string[]; warnings: string[] } {
  const lines: string[] = [];
  const warnings: string[] = [];
  return { lines, warnings, log: (line) => lines.push(line), warn: (line) => warnings.push(line) };
}

describe("JudgmentRouter", () => {
  it("judges locally when Glimmer is serving the model, and warms it", async () => {
    const local = glimmer(UP);
    const cloud = spark();
    const where: (JudgmentWhere | null)[] = [];
    const router = new JudgmentRouter({ glimmer: local, spark: cloud, logger: logs(), onWhere: (one) => where.push(one) });

    const client = await router.client();

    expect(client?.where).toBe("local");
    expect(await client?.structured(call)).toEqual({ from: "glimmer" });
    expect(local.calls).toHaveLength(1);
    expect(cloud.calls).toHaveLength(0);
    // The first real call must not pay Glimmer's ~44 s cold load.
    expect(local.warmed).toBe(1);
    expect(where).toEqual(["local"]);
    expect(router.where()).toBe("local");
  });

  it("falls back to Muse Spark with a warning when Glimmer is unreachable", async () => {
    const local = glimmer(DOWN);
    const cloud = spark();
    const logger = logs();
    const router = new JudgmentRouter({ glimmer: local, spark: cloud, logger });

    const client = await router.client();

    expect(client?.where).toBe("cloud");
    expect(await client?.structured(call)).toEqual({ from: "spark" });
    expect(local.calls).toHaveLength(0);
    expect(cloud.calls).toHaveLength(1);
    // Nothing is loaded that could not be reached.
    expect(local.warmed).toBe(0);
    expect(logger.warnings.join("\n")).toMatch(/Glimmer is unavailable.*did not answer.*Muse Spark/s);
  });

  it("judges in the cloud without a warning when Glimmer was never configured", async () => {
    const cloud = spark();
    const logger = logs();
    const router = new JudgmentRouter({ spark: cloud, logger });

    expect((await router.client())?.where).toBe("cloud");
    expect(logger.warnings).toEqual([]);
    expect(logger.lines.join("\n")).toContain("GLIMMER_BASE_URL is not set");
  });

  it("has nothing to judge with when there is neither model", async () => {
    const where: (JudgmentWhere | null)[] = [];
    const router = new JudgmentRouter({ logger: logs(), onWhere: (one) => where.push(one) });

    expect(await router.client()).toBeNull();
    expect(where).toEqual([null]);
    expect(router.where()).toBeNull();
  });

  it("checks once however many roles ask", async () => {
    let checks = 0;
    const local = {
      health: async () => {
        checks += 1;
        return UP;
      },
      warm: () => {},
      structured: async () => ({}),
    } as unknown as GlimmerClient;
    const router = new JudgmentRouter({ glimmer: local, spark: spark(), logger: logs() });

    const [first, second] = await Promise.all([router.client(), router.client()]);

    expect(first).toBe(second);
    expect(checks).toBe(1);
  });

  it("says nothing about a check that lands after the session ended", async () => {
    const where: (JudgmentWhere | null)[] = [];
    const router = new JudgmentRouter({ glimmer: glimmer(UP), spark: spark(), logger: logs(), onWhere: (one) => where.push(one) });

    const checking = router.check();
    router.stop();
    await checking;

    expect(where).toEqual([]);
    // The verdict is still there for anything already waiting on it.
    expect(router.where()).toBe("local");
  });
});
