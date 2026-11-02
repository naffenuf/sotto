/**
 * Writing the ideas for a group that is stuck (PRD V3-007).
 *
 * One Muse Spark call, no tools and no search: the material is the group's own
 * conversation, and the thing that makes an idea useful here is that it is
 * *theirs* — their options, their constraints, their words — rather than
 * anything the web could add. It is made before the offer is spoken, so "I've
 * got a few ideas on the name if they'd help" is true when it is said and the
 * yes costs nothing (V3-005's window answers in milliseconds).
 *
 * The observer's `stall` candidate carries what they are stuck on and what has
 * already been ruled out, which is exactly the brief: the headline is the
 * question going round, the detail is the list of dead ends, and the prompt's
 * first rule is not to hand any of them back.
 */
import type { Board, Item } from "../../shared/board.js";
import { boardSections } from "../../shared/board.js";
import type { Candidate } from "../../shared/candidates.js";
import {
  StallIdeasReplySchema,
  STALL_IDEAS_SCHEMA_NAME,
  stallIdeasJsonSchema,
  type StallIdeasReply,
} from "../../shared/stall.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { ModelCallError, type ModelClient } from "../model/client.js";
import { loadPrompt, PROMPTS } from "../prompts/index.js";

/** The label the ideas call is tracked under on the clock. */
export const STALL_TRACK_LABEL = "stall";

/** How many recent turns the ideas are written against. */
export const STALL_CONTEXT_TURNS = 10;

/** Everything one set of ideas is written from. */
export interface StallIdeasInput {
  /** The `stall` the observer noticed. */
  candidate: Candidate;
  /** The board, read the way the observer and the planner read it. */
  board: Board;
  /** The last few final turns, oldest first. */
  turns: readonly TurnUpdate[];
}

/** The manager injects this seam, so an offline check builds no SDK client. */
export type StallIdeasWriter = (input: StallIdeasInput) => Promise<unknown>;

/** One set of ideas. The caller validates, as every model call in here does. */
export async function writeStallIdeas(
  model: ModelClient,
  input: StallIdeasInput,
): Promise<StallIdeasReply> {
  const reply = await model.structured({
    label: STALL_TRACK_LABEL,
    system: loadPrompt(PROMPTS.stallIdeas),
    user: renderStallRequest(input),
    schemaName: STALL_IDEAS_SCHEMA_NAME,
    schema: stallIdeasJsonSchema,
    reasoningEffort: "low",
  });
  const parsed = StallIdeasReplySchema.safeParse(reply);
  if (!parsed.success) {
    throw new ModelCallError(
      `stall ideas reply did not match the schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * The user message: what they are stuck on, what is already ruled out, the
 * board, and the last stretch of talk.
 *
 * The dead ends come first and are labelled as such, because the one failure
 * mode that makes the whole feature worthless is handing the group back an
 * option it spent three turns rejecting.
 */
export function renderStallRequest(input: StallIdeasInput): string {
  const { candidate } = input;
  const blocks = [
    "## What they are stuck on",
    candidate.headline,
    "## What has already been tried or ruled out",
    candidate.detail.trim() === "" ? "_not recorded_" : candidate.detail,
  ];
  if (candidate.evidence.length > 0) {
    blocks.push(
      "## In their own words",
      candidate.evidence
        .map((quote) => `- ${quote.speaker ?? "?"}: ${quote.quote.replace(/\s+/g, " ").trim()}`)
        .join("\n"),
    );
  }
  blocks.push("## The board right now", renderBoard(input.board));
  const turns = input.turns.slice(-STALL_CONTEXT_TURNS);
  blocks.push(
    "## The last stretch of transcript",
    turns.length === 0 ? "_nothing yet_" : turns.map(renderTurn).join("\n"),
    "Reply with at most three ideas, and nothing they have already tried. " +
      "An empty list is a real answer.",
  );
  return blocks.join("\n\n");
}

/** The board as lines rather than JSON, as the planner's request renders it. */
function renderBoard(board: Board): string {
  const lines = [board.summary.trim() === "" ? "_no summary yet_" : board.summary.trim()];
  for (const section of boardSections) {
    const items = board[section].filter((item) => item.status !== "dropped");
    if (items.length === 0) continue;
    lines.push(`### ${section}`, items.map(renderItem).join("\n"));
  }
  return lines.join("\n\n");
}

function renderItem(item: Item): string {
  return `- [${item.id}] ${item.text}${item.status === "open" ? "" : ` (${item.status})`}`;
}

function renderTurn(turn: TurnUpdate): string {
  return `${turn.speaker ?? "?"}: ${turn.text.replace(/\s+/g, " ").trim()}`;
}
