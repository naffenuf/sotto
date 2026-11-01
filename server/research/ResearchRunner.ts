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
 * Two rules decide what a packet is worth:
 *
 *   - **Sources or nothing.** Every URL the model lists is resolved against
 *     the pages the search really returned, exactly as a verification's
 *     citations are (US-013), and a packet left with none is discarded and
 *     logged as `unsourced`. A research card is a claim about the world; a
 *     group that cannot follow it back is worse off than one that never saw
 *     it.
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
import { ModelCallError, type ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";

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
    this.options.onModelState?.("connecting", `looking up ${idea.topic}`);

    let reply: PacketReply;
    let searched = false;
    let sources: Citation[];
    try {
      const result = await this.request(id, idea, artifacts);
      reply = result.reply;
      searched = result.searched;
      sources = result.sources;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[research] ${id} (${idea.id}) failed: ${detail}`);
      this.options.onModelState?.("error", detail);
      this.record({
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
      this.record({
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
      ...(artifacts[0] === undefined ? {} : { visual: artifacts[0] }),
      createdAtMs: this.clock.now(),
      latencyMs,
    };
    this.ready.push(packet);
    this.options.onPacket?.(packet, renderPacketMarkdown(packet, idea.question));
    this.record({
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
    artifacts: Artifact[],
  ): Promise<{ reply: PacketReply; sources: Citation[]; searched: boolean }> {
    const functions = this.functions(id, artifacts);
    const result = await this.model.grounded({
      label: RUNNER_TRACK_LABEL,
      system: loadPrompt(PROMPTS.researchPacket),
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
      sources: this.sources(id, parsed.data.sources, result.citations, result.searchedUrls),
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
   * `show_html`, or nothing when there is nowhere to write it.
   *
   * The handler never throws, for the reason the answer agent's does not: a
   * packet in words is a far better outcome than no packet because a table
   * would not save.
   */
  private functions(id: string, artifacts: Artifact[]) {
    const save = this.options.onArtifact;
    if (save === undefined) return undefined;
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

  private record(record: Omit<ResearchPacketRecord, "kind" | "atMs">): void {
    this.options.onRecord({ kind: "packet", atMs: this.clock.now(), ...record });
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
