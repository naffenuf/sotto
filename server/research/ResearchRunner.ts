/**
 * One research job: a question in, a sourced packet out (PRD V2-013).
 *
 * The gate decided this question was worth a search and the budget let it
 * start (V2-012); this is the search itself. It is one grounded call — Muse
 * Spark with `web_search`, a strict schema for the packet, and `show_html`
 * on the table for the finding that reads better as a small table than as a
 * list — and what comes back is written to `research/<id>.json` and
 * `research/<id>.md` in the session folder, with any visual in `artifacts/`.
 *
 * What comes back also carries a **spoken** answer (V3-003): one or two
 * sentences written to be heard, which is what Sotto says to a room that
 * wondered the question aloud (V3-004). It is part of the same reply rather
 * than a second call, because the search is already the slow thing.
 *
 * Two rules decide what a packet is worth:
 *
 *   - **Sources or nothing.** Every URL the model lists is resolved against
 *     the pages the search really returned, exactly as a verification's
 *     citations are (US-013), and a packet left with none is discarded and
 *     logged as `unsourced`. A research card is a claim about the world; a
 *     group that cannot follow it back is worse off than one that never saw
 *     it.
 *   - **The group's own files come first.** When the session has a knowledge
 *     folder (V3-009) the model is handed a `search_knowledge` tool beside
 *     `web_search`, and what it reads out of a file is cited as
 *     `file: customers.csv` — resolved against the files the search really
 *     read, exactly as a URL is resolved against the pages it really opened.
 *   - **Nothing waits for it.** A job is never awaited by the pipeline. It
 *     registers itself with {@link Clock.track} so a `max`-speed replay stops
 *     for it, which is also what puts its `createdAtMs` at the moment the
 *     search was asked for rather than at the end of the conversation.
 *
 * The packets are kept here, in the order they finished: they are what a
 * research card is made of (V2-014) and what a spoken briefing is built from
 * (V2-015).
 */
import type { Artifact } from "../../shared/artifacts.js";
import {
  SHOW_HTML_TOOL,
  ShowHtmlArgsSchema,
  showHtmlJsonSchema,
  type ShowHtmlArgs,
} from "../../shared/artifacts.js";
import { ModelCitationSchema } from "../../shared/candidates.js";
import type { Citation } from "../../shared/cards.js";
import {
  SEARCH_KNOWLEDGE_TOOL,
  SearchKnowledgeArgsSchema,
  knowledgeCitation,
  renderKnowledgeResults,
  resolveKnowledgeCitation,
  searchKnowledgeDescription,
  searchKnowledgeJsonSchema,
} from "../../shared/knowledge.js";
import {
  MAX_PACKET_SOURCES,
  PacketReplySchema,
  RESEARCH_PACKET_SCHEMA_NAME,
  renderPacketMarkdown,
  researchPacketJsonSchema,
  type PacketReply,
  type ResearchIdea,
  type ResearchPacket,
  type ResearchPacketRecord,
} from "../../shared/research.js";
import { systemClock, type Clock } from "../clock.js";
import { resolveCitation, searchedIndex } from "../interject/Verifier.js";
import type { KnowledgeIndex } from "../knowledge/KnowledgeIndex.js";
import { mcpCitation, resolveMcpCitation } from "../../shared/mcp.js";
import type { McpClient } from "../mcp/McpClient.js";
import { ModelCallError, type FunctionTool, type ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt, withMcpPrompt } from "../prompts/index.js";

/** The label a research job is tracked under on the clock and in the logs. */
export const RUNNER_TRACK_LABEL = "research-packet";

/**
 * What the model is told `show_html` is for here.
 *
 * Deliberately narrower than the answer agent's: an answer is spoken and a
 * diagram is the half that cannot be said, while a packet is already written
 * down, so a visual has to earn a second round of searching.
 */
export const PACKET_HTML_DESCRIPTION =
  "Puts one small self-contained HTML document on the shared screen beside this finding: a comparison table, a timeline, a short sequence of steps. Call it at most once, and only when the finding is genuinely quicker to read as a table or a diagram than as a list.";

type Logger = Pick<Console, "log" | "warn">;

export interface ResearchRunnerOptions {
  /** The session's clock: what a packet's `createdAtMs` is on. */
  clock: Clock;
  /** Muse Spark, with the web. */
  model: ModelClient;
  /** One line of `research.jsonl`: every job, sourced or not. */
  onRecord: (record: ResearchPacketRecord) => void;
  /**
   * Writes `research/<id>.json` and `research/<id>.md`. Absent — or a session
   * whose folder could not be opened — loses the files, not the packet: the
   * card and the briefing are served from memory.
   */
  onPacket?: (packet: ResearchPacket, markdown: string) => void;
  /**
   * Writes one HTML artifact and returns it, or `null` when there is nowhere
   * to put it (US-020's seam, shared with the answer agent).
   */
  onArtifact?: (args: ShowHtmlArgs) => Artifact | null;
  /** The model status dot, shared with every other loop. */
  onModelState?: (state: "connecting" | "active" | "error", detail: string) => void;
  /** Real time, for how long the search took. */
  wallClock?: Clock;
  logger?: Logger;
  /** How much search context the model is given. */
  searchContextSize?: "low" | "medium" | "high";
  /**
   * The group's own files (V3-009), when the session has a knowledge folder.
   *
   * Present means one more tool on the table beside `web_search`, and a
   * packet that may cite `file: customers.csv`; absent means the web alone,
   * which is every session without a `knowledge/` folder.
   */
  knowledge?: KnowledgeIndex | null;
  /**
   * The company's own systems over MCP (post-V3-011), when the session has
   * servers configured. Present means their tools go on the table beside
   * `web_search`, and a packet may cite `mcp:crm/lookup_customer`; absent
   * means exactly what every session before it had.
   */
  mcp?: McpClient | null;
}

export class ResearchRunner {
  private readonly clock: Clock;
  private readonly model: ModelClient;
  private readonly options: ResearchRunnerOptions;
  private readonly wallClock: Clock;
  private readonly logger: Logger;

  /** Sourced packets, in the order they finished. */
  private readonly ready: ResearchPacket[] = [];
  private packetCount = 0;

  constructor(options: ResearchRunnerOptions) {
    this.options = options;
    this.clock = options.clock;
    this.model = options.model;
    this.wallClock = options.wallClock ?? systemClock;
    this.logger = options.logger ?? console;
  }

  /** Every sourced packet this session has produced, oldest first. */
  packets(): readonly ResearchPacket[] {
    return this.ready;
  }

  /**
   * Looks one idea up.
   *
   * Resolves when the job is over, whatever became of it: the budget counts
   * jobs by their promises (V2-012), so a failure has to settle rather than
   * hang. Nothing throws out of here — a search that did not come back is a
   * `failed` line in `research.jsonl`, not an unhandled rejection in the
   * middle of a conversation.
   */
  async run(idea: ResearchIdea): Promise<ResearchPacket | null> {
    const startedAt = this.wallClock.now();
    const id = `packet-${(this.packetCount += 1)}`;
    const artifacts: Artifact[] = [];
    // The knowledge files this search actually read, which is what decides
    // whether a `file:` citation may be shown (V3-009).
    const read = new Set<string>();
    // And the company tools this search actually called, for the same reason.
    const invoked = new Set<string>();
    this.options.onModelState?.("connecting", `looking up ${idea.topic}`);

    let reply: PacketReply;
    let searched = false;
    let sources: Citation[];
    try {
      const result = await this.request(id, idea, read, invoked, artifacts);
      reply = result.reply;
      searched = result.searched;
      sources = result.sources;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[research] ${id} (${idea.id}) failed: ${detail}`);
      this.options.onModelState?.("error", detail);
      this.record(idea, {
        ideaId: idea.id,
        question: idea.question,
        outcome: "failed",
        latencyMs: this.sinceMs(startedAt),
        searched: false,
        error: detail,
      });
      return null;
    }
    this.options.onModelState?.("active", "model client ready");

    const latencyMs = this.sinceMs(startedAt);
    // A finding the group cannot trace back is not a finding. The PRD asks
    // for this to be logged by name rather than silently dropped.
    if (sources.length === 0) {
      this.logger.warn(
        `[research] ${id} (${idea.id}) came back unsourced after ${latencyMs} ms: ${reply.title}`,
      );
      this.record(idea, {
        ideaId: idea.id,
        question: idea.question,
        outcome: "unsourced",
        title: reply.title,
        latencyMs,
        searched,
      });
      return null;
    }

    const packet: ResearchPacket = {
      id,
      ideaId: idea.id,
      title: reply.title,
      teaser: reply.teaser,
      keyPoints: reply.keyPoints,
      sources,
      // V3-003: the one or two sentences V3-004 says out loud. Absent when the
      // model left it blank, which a card and a briefing do not need.
      ...(reply.spokenAnswer === "" ? {} : { spokenAnswer: reply.spokenAnswer }),
      ...(artifacts[0] === undefined ? {} : { visual: artifacts[0] }),
      createdAtMs: this.clock.now(),
      latencyMs,
    };
    this.ready.push(packet);
    this.options.onPacket?.(packet, renderPacketMarkdown(packet, idea.question));
    this.record(idea, {
      ideaId: idea.id,
      question: idea.question,
      outcome: "ready",
      packet,
      latencyMs,
      searched,
    });
    this.logger.log(
      `[research] ${id} (${idea.id}) ready in ${latencyMs} ms` +
        `, ${packet.sources.length} source(s)` +
        `, ${packet.keyPoints.length} key point(s)` +
        (packet.visual === undefined ? "" : `, visual "${packet.visual.title}"`) +
        `: ${packet.title}`,
    );
    return packet;
  }

  /** One grounded call, validated, with its sources resolved. */
  private async request(
    id: string,
    idea: ResearchIdea,
    read: Set<string>,
    invoked: Set<string>,
    artifacts: Artifact[],
  ): Promise<{ reply: PacketReply; sources: Citation[]; searched: boolean }> {
    // The company tools are listed once per session, at its start; a search
    // in the first seconds waits for that rather than going out without them.
    // Nothing to wait for when no servers are configured.
    if (this.options.mcp) await this.options.mcp.ready();
    const company = this.options.mcp?.functionTools(invoked, RUNNER_TRACK_LABEL) ?? [];
    const functions = this.functions(id, read, company, artifacts);
    const result = await this.model.grounded({
      label: RUNNER_TRACK_LABEL,
      // The MCP section rides only on a call that carries a company tool:
      // without one this is V2-013's prompt, byte for byte.
      system: withMcpPrompt(PROMPTS.researchPacket, PROMPTS.mcpResearchPacket, company.length > 0),
      user: renderPacketRequest(idea),
      schemaName: RESEARCH_PACKET_SCHEMA_NAME,
      schema: researchPacketJsonSchema,
      ...(this.options.searchContextSize === undefined
        ? {}
        : { searchContextSize: this.options.searchContextSize }),
      ...(functions === undefined ? {} : { functions }),
    });
    const parsed = PacketReplySchema.safeParse(result.value);
    if (!parsed.success) {
      throw new ModelCallError(
        `research packet reply did not match the schema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return {
      reply: parsed.data,
      sources: this.sources(id, parsed.data.sources, result.citations, result.searchedUrls, read, invoked),
      searched: result.searched,
    };
  }

  /**
   * The sources a packet may be shown with.
   *
   * The same rule a verdict's citations follow: the reply's own
   * `url_citation` annotations first — a structured reply usually has none,
   * since an annotation is a range into prose — then every URL the model
   * listed, **resolved against the pages the search actually returned**. A
   * page the search never produced is dropped, and a packet that loses all of
   * them is discarded.
   */
  private sources(
    id: string,
    listed: readonly unknown[],
    annotated: readonly Citation[],
    searchedUrls: readonly string[],
    read: ReadonlySet<string>,
    invoked: ReadonlySet<string> = new Set(),
  ): Citation[] {
    const byUrl = new Map<string, Citation>();
    for (const citation of annotated) byUrl.set(citation.url, citation);
    const searched = searchedIndex(searchedUrls);
    for (const raw of listed) {
      // One bad entry drops on its own, as one bad candidate does.
      const one = ModelCitationSchema.safeParse(raw);
      if (!one.success) {
        this.logger.warn(`[research] ${id} listed an unreadable source`);
        continue;
      }
      const named = one.data.url.trim();
      // One of the group's own files (V3-009), which has no URL to resolve:
      // the test is whether this search really read it.
      const file = resolveKnowledgeCitation(named, read);
      if (file !== undefined) {
        const citation = knowledgeCitation(file);
        if (!byUrl.has(citation.url)) byUrl.set(citation.url, citation);
        continue;
      }
      // Or one of the company's tools (post-V3-011), by the same rule: only
      // a tool this search really called.
      const tool = resolveMcpCitation(named, invoked);
      if (tool !== undefined) {
        const slash = tool.indexOf("/");
        const citation = mcpCitation(tool.slice(0, slash), tool.slice(slash + 1));
        if (!byUrl.has(citation.url)) byUrl.set(citation.url, citation);
        continue;
      }
      const url = resolveCitation(named, searched);
      if (url === undefined) {
        this.logger.warn(`[research] ${id} cited a page it never opened: ${named}`);
        continue;
      }
      if (byUrl.has(url)) continue;
      byUrl.set(url, { url, title: sourceTitle(one.data.title, url) });
    }
    return [...byUrl.values()].slice(0, MAX_PACKET_SOURCES);
  }

  /**
   * The tools on the table for one search: `search_knowledge` when the
   * session has a knowledge folder (V3-009), `show_html` when there is
   * somewhere to write a visual, and nothing at all when neither applies —
   * which is the `web_search`-only request V2-013 measured.
   *
   * Neither handler ever throws, for the reason the answer agent's does not:
   * a packet in words is a far better outcome than no packet because a table
   * would not save or a file would not read.
   */
  private functions(id: string, read: Set<string>, company: readonly FunctionTool[], artifacts: Artifact[]) {
    const tools = [
      ...this.knowledgeTool(id, read),
      // The company's own systems (post-V3-011), each tool its own function.
      ...company,
      ...this.htmlTool(id, artifacts),
    ];
    return tools.length === 0 ? undefined : tools;
  }

  /** `search_knowledge`, or nothing when there are no files to search. */
  private knowledgeTool(id: string, read: Set<string>): FunctionTool[] {
    const knowledge = this.options.knowledge;
    if (knowledge === undefined || knowledge === null) return [];
    return [
      {
        name: SEARCH_KNOWLEDGE_TOOL,
        description: searchKnowledgeDescription(knowledge.files()),
        parameters: searchKnowledgeJsonSchema,
        run: (args: unknown): string => {
          const parsed = SearchKnowledgeArgsSchema.safeParse(args);
          if (!parsed.success) {
            const why = parsed.error.issues.map((issue) => issue.message).join("; ");
            this.logger.warn(`[research] ${id} searched the files with nothing: ${why}`);
            return `That search could not be run (${why}). Search again with a few words, or answer from the web instead.`;
          }
          const snippets = knowledge.search(parsed.data.query);
          // Only a file the search really returned may be cited, exactly as
          // only a page the web search returned may be (US-013).
          for (const snippet of snippets) read.add(snippet.file);
          this.logger.log(
            `[research] ${id} searched the files for "${parsed.data.query}": ${snippets.length} line(s)`,
          );
          return renderKnowledgeResults(parsed.data.query, snippets);
        },
      },
    ];
  }

  /** `show_html`, or nothing when there is nowhere to write it. */
  private htmlTool(id: string, artifacts: Artifact[]): FunctionTool[] {
    const save = this.options.onArtifact;
    if (save === undefined) return [];
    return [
      {
        name: SHOW_HTML_TOOL,
        description: PACKET_HTML_DESCRIPTION,
        parameters: showHtmlJsonSchema,
        run: (args: unknown): string => {
          const parsed = ShowHtmlArgsSchema.safeParse(args);
          if (!parsed.success) {
            const why = parsed.error.issues.map((issue) => issue.message).join("; ");
            this.logger.warn(`[research] ${id} drew something unusable: ${why}`);
            return `That document could not be saved (${why}). Reply with the packet instead.`;
          }
          if (artifacts.length > 0) {
            return "There is already a visual for this finding. Reply with the packet now.";
          }
          const artifact = save(parsed.data);
          if (artifact === null) {
            this.logger.warn(`[research] ${id} could not save "${parsed.data.title}"`);
            return "The shared screen is unavailable in this session, so nothing was saved. Reply with the packet instead.";
          }
          artifacts.push(artifact);
          this.logger.log(`[research] ${id} drew "${artifact.title}" (${artifact.path})`);
          return `"${artifact.title}" is saved and will be shown beside the finding. Reply with the packet now.`;
        },
      },
    ];
  }

  /**
   * One `packet` line, with the fast path's end-to-end latency on it when the
   * room is what asked (V3-003).
   *
   * Both ends of `questionToPacketMs` are read off the *session* clock: the
   * classifier stamped the question with it and this is the same clock the
   * packet's `createdAtMs` is on, so the two subtract. It is recorded on every
   * outcome rather than only on a packet, because "the room wondered and
   * nothing came back" is a latency somebody has to be told about too
   * (V3-015).
   */
  private record(idea: ResearchIdea, record: Omit<ResearchPacketRecord, "kind" | "atMs">): void {
    const atMs = this.clock.now();
    this.options.onRecord({
      kind: "packet",
      atMs,
      ...record,
      ...(idea.askedAtMs === undefined
        ? {}
        : { questionToPacketMs: Math.max(0, Math.round(atMs - idea.askedAtMs)) }),
    });
  }

  private sinceMs(startedAt: number): number {
    return Math.max(0, Math.round(this.wallClock.now() - startedAt));
  }
}

/**
 * The user message for one job: the question, why it came up, and nothing
 * else.
 *
 * The conversation is deliberately not in here. A packet is read minutes
 * later by somebody who was in the room, so what it has to be is *right about
 * the world* — and a model given six turns of brainstorm starts answering the
 * brainstorm instead of the question. The gate has already decided this
 * question is the one worth asking (V2-012).
 */
export function renderPacketRequest(idea: ResearchIdea): string {
  return [
    "## The question",
    idea.question,
    "## Why it came up",
    idea.why.trim() === "" ? "_not recorded_" : idea.why,
    "Search, then reply with the packet.",
  ].join("\n\n");
}

/** A source's title, falling back to its host when the model left it blank. */
function sourceTitle(title: string, url: string): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (trimmed !== "") return trimmed;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
