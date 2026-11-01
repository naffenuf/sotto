/**
 * The real local Glimmer server (V2-010).
 *
 * Skipped with a message when `GLIMMER_BASE_URL`/`GLIMMER_MODEL` are not in
 * `.env`, because Glimmer is optional: a Sotto that cannot find it judges with
 * Muse Spark instead. Nothing here calls a cloud API, but it is still an
 * integration test — it needs a 16 GB model loaded on this Mac, and a cold
 * load is ~44 s, which is why the hook timeout below is generous.
 */
import { config as loadDotenv } from "dotenv";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadGlimmerConfig } from "../config.js";
import { GlimmerClient, type GlimmerHealth } from "./GlimmerClient.js";
import { JudgmentRouter } from "./judgment.js";

loadDotenv({ quiet: true });

const config = loadGlimmerConfig();
const describeGlimmer = config === null ? describe.skip : describe;
if (config === null) {
  process.stderr.write(
    "\nSkipping the Glimmer integration tests: GLIMMER_BASE_URL or GLIMMER_MODEL is missing.\n" +
      "Serve Muse Glimmer locally (see tasks/prd-sotto-v2.md Prerequisites) and set both in .env.\n\n",
  );
}

/**
 * A gate-shaped reply: three scores and a reason. The same zod validation a
 * judgment role will do (V2-012) — the schema constrains the keys and the
 * types, and nothing else, so the *ranges* still have to be checked here.
 */
const GateSchema = z.object({
  useful: z.number(),
  already_known: z.number(),
  answerable: z.number(),
  why: z.string(),
});

const gateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["useful", "already_known", "answerable", "why"],
  properties: {
    useful: { type: "number" },
    already_known: { type: "number" },
    answerable: { type: "number" },
    why: { type: "string" },
  },
};

/**
 * The ranges live in the prompt, not in the schema's descriptions: Ollama
 * turns the schema into a grammar the model never reads.
 */
const SYSTEM = [
  "You score one research idea for a group that is brainstorming out loud.",
  "Give three scores, each a number between 0 and 1 (not a percentage, not out of ten):",
  "- useful: how much an answer would help this group right now",
  "- already_known: how much the group has already said the answer",
  "- answerable: how well a web search could answer it",
  "Then one short sentence for why. Reply with the JSON object only.",
].join("\n");

const USER = [
  "The group is deciding what to charge for a meal-planning app.",
  "They said: \"Mealime is like three bucks a month, I think?\" and nobody knew.",
  "",
  "Idea: look up what the main meal-planning apps charge per month.",
].join("\n");

describeGlimmer("Glimmer, against the real local server", () => {
  const glimmer = new GlimmerClient({
    baseUrl: config?.baseUrl ?? "",
    model: config?.model ?? "",
  });
  let health: GlimmerHealth;
  let gate: z.infer<typeof GateSchema>;
  let gateMs = 0;

  // A cold model load is ~44 s and generation runs at ~13 tokens a second,
  // so the work happens once, here, where the hook's own timeout applies.
  beforeAll(async () => {
    health = await glimmer.health();
    const startedAt = Date.now();
    const reply = await glimmer.structured({
      label: "glimmer_gate",
      system: SYSTEM,
      user: USER,
      schemaName: "research_gate",
      schema: gateJsonSchema,
    });
    gateMs = Date.now() - startedAt;
    gate = GateSchema.parse(reply);
    // The latency is the point of the measurement, so it is logged rather
    // than only asserted on: V2-012's gate has to stay off the critical path.
    process.stderr.write(
      `\n[glimmer] health ${health.latencyMs} ms (${health.detail})\n` +
        `[glimmer] gate ${gateMs} ms -> ${JSON.stringify(gate)}\n\n`,
    );
  }, 5 * 60_000);

  it("is serving the configured model", () => {
    expect(health.ok).toBe(true);
    expect(health.detail).toContain(config?.model ?? "");
    // A models listing, not a generation: it runs at session start.
    expect(health.latencyMs).toBeLessThan(1_000);
  });

  it("answers a structured request with valid JSON", () => {
    expect(gate.why.trim()).not.toBe("");
    for (const score of [gate.useful, gate.already_known, gate.answerable]) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("judges this idea worth looking up", () => {
    // Not a precision claim about the model, just that a sane prompt gets a
    // sane verdict: the group guessed at a price nobody knew, and a search
    // would settle it.
    expect(gate.useful).toBeGreaterThan(0.5);
    expect(gate.answerable).toBeGreaterThan(0.5);
  });

  it("is what the judgment router picks when it is there", async () => {
    const router = new JudgmentRouter({
      glimmer: new GlimmerClient({ baseUrl: config?.baseUrl ?? "", model: config?.model ?? "" }),
      // A cloud client it must not reach for: Glimmer is up.
      spark: {
        structured: async () => {
          throw new Error("judgment should have stayed local");
        },
        grounded: async () => {
          throw new Error("unused");
        },
        prose: async () => {
          throw new Error("unused");
        },
      },
      // The warm-up is the same call the gate above already paid for.
      warm: false,
    });

    expect((await router.client())?.where).toBe("local");
  });

  it("falls back to the cloud when nothing is listening on the port", async () => {
    const calls: string[] = [];
    const router = new JudgmentRouter({
      // Port 1 on loopback: a connection refused as fast as the OS can.
      glimmer: new GlimmerClient({ baseUrl: "http://127.0.0.1:1/v1", model: config?.model ?? "" }),
      spark: {
        structured: async (call) => {
          calls.push(call.label);
          return {};
        },
        grounded: async () => {
          throw new Error("unused");
        },
        prose: async () => {
          throw new Error("unused");
        },
      },
      logger: { log: () => {}, warn: () => {} },
    });

    const client = await router.client();
    expect(client?.where).toBe("cloud");
    await client?.structured({
      label: "research_gate",
      system: "x",
      user: "y",
      schemaName: "research_gate",
      schema: gateJsonSchema,
    });
    expect(calls).toEqual(["research_gate"]);
  });
});
