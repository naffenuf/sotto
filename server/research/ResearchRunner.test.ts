import { describe, expect, it } from "vitest";
import type { Artifact } from "../../shared/artifacts.js";
import { SHOW_HTML_TOOL } from "../../shared/artifacts.js";
import {
  RESEARCH_PACKET_SCHEMA_NAME,
  researchPacketJsonSchema,
  type ResearchIdea,
  type ResearchPacketRecord,
} from "../../shared/research.js";
import { SimulatedClock } from "../clock.js";
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

function harness(replies: Reply[], options: { artifacts?: "none" | "fails" } = {}): Harness {
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
