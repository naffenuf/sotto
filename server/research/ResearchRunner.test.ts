import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Artifact } from "../../shared/artifacts.js";
import { SHOW_HTML_TOOL } from "../../shared/artifacts.js";
import {
  RESEARCH_PACKET_SCHEMA_NAME,
  researchPacketJsonSchema,
  type ResearchIdea,
  type ResearchPacketRecord,
} from "../../shared/research.js";
import { SEARCH_KNOWLEDGE_TOOL } from "../../shared/knowledge.js";
import { SimulatedClock } from "../clock.js";
import { KnowledgeIndex } from "../knowledge/KnowledgeIndex.js";
import {
  ModelCallError,
  type GroundedCall,
  type GroundedReply,
  type ModelClient,
} from "../model/client.js";
import { PACKET_HTML_DESCRIPTION, ResearchRunner, renderPacketRequest } from "./ResearchRunner.js";

const quiet = { log: () => {}, warn: () => {} };

const idea = (overrides: Partial<ResearchIdea> = {}): ResearchIdea => ({
  id: "idea-1",
  topic: "competitor pricing",
  question: "What do Otter and Fireflies charge per seat per month?",
  why: "the pricing argument rests on a number nobody has",
  sourceTurnIds: ["0:4"],
  ...overrides,
});

const packetReply = (overrides: Record<string, unknown> = {}): unknown => ({
  title: "Otter and Fireflies charge $8-19 a seat",
  teaser: "Otter Pro is $16.99 monthly or $8.33 annual; Fireflies Pro is $18 or $10.",
  keyPoints: ["Otter Pro: $16.99 monthly", "Fireflies Pro: $18 monthly"],
  sources: [{ url: "https://otter.ai/pricing", title: "Pricing | Otter.ai" }],
  ...overrides,
});

/**
 * A model whose grounded calls are answered from a script.
 *
 * Each reply is handed the call, so a test can run the `show_html` handler
 * from inside it — which is where it really runs: the client calls the tool
 * and asks again, and both rounds are one {@link ModelClient.grounded} call
 * from the runner's side.
 */
class FakeModel implements ModelClient {
  readonly calls: GroundedCall[] = [];

  constructor(private readonly replies: Reply[]) {}

  async structured(): Promise<never> {
    throw new Error("a research job is a grounded call");
  }

  async prose(): Promise<never> {
    throw new Error("a research job is a grounded call");
  }

  async grounded(call: GroundedCall): Promise<GroundedReply> {
    this.calls.push(call);
    const next = this.replies[this.calls.length - 1];
    if (next === undefined) throw new Error(`unexpected grounded call ${this.calls.length}`);
    return next(call);
  }
}

/** One scripted reply, with the call it is answering. */
type Reply = (call: GroundedCall) => Promise<GroundedReply>;

function reply(overrides: Partial<GroundedReply> & { value: unknown }): GroundedReply {
  return {
    citations: [],
    searchedUrls: ["https://otter.ai/pricing", "https://fireflies.ai/pricing"],
    searched: true,
    functionCalls: 0,
    ...overrides,
  };
}

interface Harness {
  runner: ResearchRunner;
  model: FakeModel;
  records: ResearchPacketRecord[];
  written: { id: string; markdown: string }[];
  saved: { title: string; html: string }[];
  clock: SimulatedClock;
  wallClock: SimulatedClock;
}

function harness(
  replies: Reply[],
  options: { artifacts?: "none" | "fails"; knowledge?: string } = {},
): Harness {
  const clock = new SimulatedClock(60_000);
  const wallClock = new SimulatedClock(1_000);
  const model = new FakeModel(replies);
  const records: ResearchPacketRecord[] = [];
  const written: { id: string; markdown: string }[] = [];
  const saved: { title: string; html: string }[] = [];
  const runner = new ResearchRunner({
    clock,
    model,
    wallClock,
    logger: quiet,
    onRecord: (record) => records.push(record),
    onPacket: (packet, markdown) => written.push({ id: packet.id, markdown }),
    ...(options.artifacts === "none"
      ? {}
      : {
          onArtifact: ({ title, html }): Artifact | null => {
            saved.push({ title, html });
            if (options.artifacts === "fails") return null;
            return {
              title,
              path: `artifacts/0${saved.length}-visual.html`,
              url: `/api/sessions/s1/artifacts/0${saved.length}-visual.html`,
            };
          },
        }),
    ...(options.knowledge === undefined
      ? {}
      : { knowledge: KnowledgeIndex.load(options.knowledge, { logger: quiet }) }),
  });
  return { runner, model, records, written, saved, clock, wallClock };
}

describe("ResearchRunner", () => {
  it("asks for the packet with the prompt, the schema and show_html on the table", async () => {
    const { runner, model } = harness([() => Promise.resolve(reply({ value: packetReply() }))]);
    await runner.run(idea());

    const call = model.calls[0] as GroundedCall;
    expect(call.label).toBe("research-packet");
    expect(call.schemaName).toBe(RESEARCH_PACKET_SCHEMA_NAME);
    expect(call.schema).toBe(researchPacketJsonSchema);
    expect(call.system).toContain("Search the web");
    expect(call.user).toContain("What do Otter and Fireflies charge per seat per month?");
    expect(call.functions?.map((tool) => tool.name)).toEqual([SHOW_HTML_TOOL]);
    expect(call.functions?.[0]?.description).toBe(PACKET_HTML_DESCRIPTION);
  });

  it("builds a sourced packet, writes it and records it as ready", async () => {
    const { runner, records, written, clock, wallClock } = harness([
      () => {
        wallClock.advanceBy(14_200);
        return Promise.resolve(reply({ value: packetReply() }));
      },
    ]);
    const packet = await runner.run(idea());

    expect(packet).not.toBeNull();
    expect(packet?.id).toBe("packet-1");
    expect(packet?.ideaId).toBe("idea-1");
    expect(packet?.title).toBe("Otter and Fireflies charge $8-19 a seat");
    expect(packet?.keyPoints).toHaveLength(2);
    expect(packet?.sources).toEqual([
      { url: "https://otter.ai/pricing", title: "Pricing | Otter.ai" },
    ]);
    expect(packet?.visual).toBeUndefined();
    // The session clock for the conversation, real time for the search.
    expect(packet?.createdAtMs).toBe(clock.now());
    expect(packet?.latencyMs).toBe(14_200);

    expect(runner.packets()).toEqual([packet]);
    expect(written).toHaveLength(1);
    expect(written[0]?.id).toBe("packet-1");
    expect(written[0]?.markdown).toContain("# Otter and Fireflies charge $8-19 a seat");
    expect(written[0]?.markdown).toContain("https://otter.ai/pricing");

    const record = records[0] as ResearchPacketRecord;
    expect(record.kind).toBe("packet");
    expect(record.outcome).toBe("ready");
    expect(record.ideaId).toBe("idea-1");
    expect(record.question).toBe(idea().question);
    expect(record.searched).toBe(true);
    expect(record.packet?.id).toBe("packet-1");
  });

  it("numbers the packets it produces", async () => {
    const { runner } = harness([
      () => Promise.resolve(reply({ value: packetReply() })),
      () => Promise.resolve(reply({ value: packetReply({ title: "Fireflies is $18" }) })),
    ]);
    await runner.run(idea());
    await runner.run(idea({ id: "idea-2" }));
    expect(runner.packets().map((packet) => packet.id)).toEqual(["packet-1", "packet-2"]);
  });

  it("keeps only the sources the search really returned", async () => {
    const { runner, records } = harness([
      () =>
        Promise.resolve(
          reply({
            value: packetReply({
              sources: [
                // Named exactly: kept.
                { url: "https://otter.ai/pricing", title: "Pricing | Otter.ai" },
                // The host of a page the search did return: resolved to it.
                { url: "fireflies.ai", title: "Fireflies pricing" },
                // Never in front of the model: dropped, however plausible.
                { url: "https://granola.ai/pricing", title: "Granola pricing" },
                // Unreadable: dropped on its own.
                { nonsense: true },
              ],
            }),
          }),
        ),
    ]);
    const packet = await runner.run(idea());
    expect(packet?.sources.map((source) => source.url)).toEqual([
      "https://otter.ai/pricing",
      "https://fireflies.ai/pricing",
    ]);
    expect(records[0]?.outcome).toBe("ready");
  });

  it("discards a packet with no source at all and logs it as unsourced", async () => {
    const { runner, records, written } = harness([
      () =>
        Promise.resolve(
          reply({
            value: packetReply({
              sources: [{ url: "https://invented.example/pricing", title: "Pricing" }],
            }),
          }),
        ),
    ]);
    const packet = await runner.run(idea());

    expect(packet).toBeNull();
    expect(runner.packets()).toEqual([]);
    expect(written).toEqual([]);
    const record = records[0] as ResearchPacketRecord;
    expect(record.outcome).toBe("unsourced");
    expect(record.title).toBe("Otter and Fireflies charge $8-19 a seat");
    expect(record.packet).toBeUndefined();
  });

  it("records a call that did not come back, and does not throw out of the job", async () => {
    const { runner, records, written } = harness([
      () => Promise.reject(new ModelCallError("research-packet: the model returned no text")),
    ]);
    const packet = await runner.run(idea());

    expect(packet).toBeNull();
    expect(written).toEqual([]);
    const record = records[0] as ResearchPacketRecord;
    expect(record.outcome).toBe("failed");
    expect(record.error).toContain("no text");
    expect(record.searched).toBe(false);
  });

  it("records a reply that did not fit the schema as a failure", async () => {
    const { runner, records } = harness([
      () => Promise.resolve(reply({ value: { title: "", teaser: "", keyPoints: [], sources: [] } })),
    ]);
    expect(await runner.run(idea())).toBeNull();
    expect(records[0]?.outcome).toBe("failed");
    expect(records[0]?.error).toContain("did not match the schema");
  });

  it("saves a visual drawn during the call and hangs it on the packet", async () => {
    let drew: string | undefined;
    const { runner, saved, written } = harness([
      async (call) => {
        drew = await call.functions?.[0]?.run({
          title: "Pricing table",
          html: "<!doctype html><table></table>",
        });
        return reply({ value: packetReply(), functionCalls: 1 });
      },
    ]);
    const packet = await runner.run(idea());

    expect(drew).toContain("Pricing table");
    expect(saved).toEqual([
      { title: "Pricing table", html: "<!doctype html><table></table>" },
    ]);
    expect(packet?.visual?.title).toBe("Pricing table");
    expect(packet?.visual?.path).toBe("artifacts/01-visual.html");
    expect(written[0]?.markdown).toContain("## Visual");
  });

  it("refuses a second visual in words rather than drawing over the first", async () => {
    const answers: (string | undefined)[] = [];
    const { runner } = harness([
      async (call) => {
        const tool = call.functions?.[0];
        answers.push(await tool?.run({ title: "First", html: "<table/>" }));
        answers.push(await tool?.run({ title: "Second", html: "<table/>" }));
        return reply({ value: packetReply() });
      },
    ]);
    const packet = await runner.run(idea());

    expect(answers[1]).toContain("already a visual");
    expect(packet?.visual?.title).toBe("First");
  });

  it("tells the model in words when a visual could not be saved, and still packs the finding", async () => {
    let answer: string | undefined;
    const { runner } = harness(
      [
        async (call) => {
          answer = await call.functions?.[0]?.run({ title: "Table", html: "<table/>" });
          return reply({ value: packetReply() });
        },
      ],
      { artifacts: "fails" },
    );
    const packet = await runner.run(idea());

    expect(answer).toContain("unavailable");
    expect(packet?.visual).toBeUndefined();
    expect(packet?.title).toBe("Otter and Fireflies charge $8-19 a seat");
  });

  it("tells the model in words when the document itself was unusable", async () => {
    let answer: string | undefined;
    const { runner } = harness([
      async (call) => {
        answer = await call.functions?.[0]?.run({ title: "Table", html: "" });
        return reply({ value: packetReply() });
      },
    ]);
    await runner.run(idea());
    expect(answer).toContain("could not be saved");
  });

  it("offers no tool at all when there is nowhere to write one", async () => {
    const { runner, model } = harness(
      [() => Promise.resolve(reply({ value: packetReply() }))],
      { artifacts: "none" },
    );
    await runner.run(idea());
    expect(model.calls[0]?.functions).toBeUndefined();
  });
});

describe("renderPacketRequest", () => {
  it("is the question and why it came up, and not the conversation", () => {
    const request = renderPacketRequest(idea());
    expect(request).toContain("## The question");
    expect(request).toContain(idea().question);
    expect(request).toContain("## Why it came up");
    expect(request).toContain(idea().why);
  });

  it("says so when nothing recorded why", () => {
    expect(renderPacketRequest(idea({ why: "  " }))).toContain("_not recorded_");
  });
});

/**
 * V3-003: the fast path's two additions, both read off one reply — the spoken
 * sentence V3-004 says to the room, and how long the room waited for it.
 */
describe("a packet for a question the room wondered aloud (V3-003)", () => {
  it("carries the spoken answer and the end-to-end latency", async () => {
    const { runner, records, clock } = harness([
      async () =>
        reply({
          value: packetReply({
            spokenAnswer: "About two hours fifteen each way, so a bit over four hours in the car.",
          }),
        }),
    ]);
    clock.advanceTo(80_000);
    const packet = await runner.run(idea({ askedAtMs: 60_000 }));

    expect(packet?.spokenAnswer).toBe(
      "About two hours fifteen each way, so a bit over four hours in the car.",
    );
    expect(records[0]?.questionToPacketMs).toBe(20_000);
  });

  it("leaves both off a packet nobody asked for out loud", async () => {
    const { runner, records } = harness([async () => reply({ value: packetReply() })]);
    const packet = await runner.run(idea());

    expect(packet).not.toBeNull();
    expect(packet?.spokenAnswer).toBeUndefined();
    expect(records[0]?.questionToPacketMs).toBeUndefined();
  });

  // V3-015 closes the loop out loud on a question it already claimed, so the
  // wait has to be recorded even when there is nothing to say at the end of it.
  it("records the latency of a search that came back with nothing", async () => {
    const { runner, records, clock } = harness([
      async () => reply({ value: packetReply({ sources: [] }), searchedUrls: [] }),
    ]);
    clock.advanceTo(75_000);
    expect(await runner.run(idea({ askedAtMs: 60_000 }))).toBeNull();

    expect(records[0]?.outcome).toBe("unsourced");
    expect(records[0]?.questionToPacketMs).toBe(15_000);
  });
});

/**
 * V3-009: the group's own files on the table beside `web_search`.
 */
describe("ResearchRunner and the knowledge folder", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sotto-runner-files-"));
    writeFileSync(
      join(dir, "customers.csv"),
      ["customer,renews_on", "Harborview Clinic,2027-03-01"].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const renewal = (): ResearchIdea =>
    idea({
      id: "idea-9",
      topic: "Harborview renewal",
      question: "When does the Harborview Clinic contract renew?",
    });

  it("declares search_knowledge first, and names the files in its description", async () => {
    const { runner, model } = harness(
      [() => Promise.resolve(reply({ value: packetReply() }))],
      { knowledge: dir },
    );
    await runner.run(renewal());

    const tools = (model.calls[0] as GroundedCall).functions ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([SEARCH_KNOWLEDGE_TOOL, SHOW_HTML_TOOL]);
    expect(tools[0]?.description).toContain("customers.csv");
  });

  it("declares nothing when there is no folder and nowhere to draw", async () => {
    const { runner, model } = harness([() => Promise.resolve(reply({ value: packetReply() }))], {
      artifacts: "none",
    });
    await runner.run(renewal());
    expect((model.calls[0] as GroundedCall).functions).toBeUndefined();
  });

  it("cites a file the search really read, as `file: <name>`", async () => {
    const { runner, records } = harness(
      [
        async (call) => {
          const tool = call.functions?.find((one) => one.name === SEARCH_KNOWLEDGE_TOOL);
          const result = await tool?.run({ query: "Harborview renewal" });
          expect(result).toContain("2027-03-01");
          return reply({
            value: packetReply({
              title: "Harborview Clinic renews on 1 March 2027",
              spokenAnswer: "Harborview renews on the first of March 2027.",
              sources: [{ url: "file: customers.csv", title: "customers.csv" }],
            }),
            searchedUrls: [],
            searched: false,
          });
        },
      ],
      { knowledge: dir },
    );

    const packet = await runner.run(renewal());
    expect(packet?.sources).toEqual([{ url: "file:customers.csv", title: "file: customers.csv" }]);
    expect(packet?.spokenAnswer).toBe("Harborview renews on the first of March 2027.");
    expect(records[0]?.outcome).toBe("ready");
  });

  it("drops a file the search never returned, as it drops an unopened page", async () => {
    const { runner, records } = harness(
      [
        async () =>
          // Never searched the files, so nothing may be cited from them.
          reply({
            value: packetReply({ sources: [{ url: "file: revenue.csv", title: "revenue.csv" }] }),
            searchedUrls: [],
          }),
      ],
      { knowledge: dir },
    );
    expect(await runner.run(renewal())).toBeNull();
    expect(records[0]?.outcome).toBe("unsourced");
  });

  it("tells the model in words when a search cannot be run", async () => {
    const { runner } = harness(
      [
        async (call) => {
          const tool = call.functions?.find((one) => one.name === SEARCH_KNOWLEDGE_TOOL);
          expect(await tool?.run({ query: "   " })).toContain("could not be run");
          expect(await tool?.run({})).toContain("could not be run");
          return reply({ value: packetReply() });
        },
      ],
      { knowledge: dir },
    );
    expect(await runner.run(renewal())).not.toBeNull();
  });
});
