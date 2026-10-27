/**
 * The living board: the organized form of the conversation, and the memory the
 * interjection engine reasons over (PRD US-009).
 *
 * The board is never replaced wholesale. Every update is a small list of
 * {@link BoardOp}s, which `server/board/applyOps.ts` folds into a new board, so
 * an item keeps its id and its `createdAtMs` from the moment it first appeared
 * — which is what lets the UI highlight what changed, and lets a candidate
 * (US-012) point at a board item that is still there a minute later.
 *
 * Asking the model for operations instead of a board is also the only way to
 * stop it quietly rewriting everything on every call. {@link boardOpsJsonSchema}
 * is that request's structured-output schema.
 */
import { z } from "zod";

/** Where an item lives. Each section numbers its items with its own prefix. */
export const boardSections = ["constraints", "points", "questions", "decisions"] as const;
export type BoardSection = (typeof boardSections)[number];

/**
 * - `open`: still live. For a question, still unanswered.
 * - `covered`: the conversation clearly addressed it. For a question, answered.
 * - `dropped`: no longer relevant. Items are never deleted, only dropped.
 */
export const itemStatuses = ["open", "covered", "dropped"] as const;
export type ItemStatus = (typeof itemStatuses)[number];

/** One line on the board. */
export interface Item {
  /** Stable for the life of the session: the section's prefix plus a number (`c1`, `p4`). */
  id: string;
  text: string;
  status: ItemStatus;
  /** `turnId`s of the turns the item came from, oldest first. */
  sourceTurnIds: string[];
  /** When the item was added, on the session clock. */
  createdAtMs: number;
  /** When its text or status last changed; equal to `createdAtMs` until it does. */
  updatedAtMs: number;
}

/**
 * The whole board.
 *
 * `constraints` holds stated limits — budget, deadline, audience, must-haves —
 * separately from `points`, because contradiction detection (US-012) is mostly
 * a matter of reading a new turn against them.
 */
export interface Board {
  /** Two sentences at most; empty until the first update. */
  summary: string;
  constraints: Item[];
  points: Item[];
  questions: Item[];
  decisions: Item[];
}

/** The id prefix each section gives its items. */
export const sectionIdPrefixes: Record<BoardSection, string> = {
  constraints: "c",
  points: "p",
  questions: "q",
  decisions: "d",
};

/** A board with nothing on it: the state every session starts from. */
export function emptyBoard(): Board {
  return { summary: "", constraints: [], points: [], questions: [], decisions: [] };
}

/** The `add_*` op that puts an item in each section. */
export const sectionAddOps: Record<BoardSection, AddOpKind> = {
  constraints: "add_constraint",
  points: "add_point",
  questions: "add_question",
  decisions: "add_decision",
};

/** Which section each `add_*` op writes to. */
export const addOpSections: Record<AddOpKind, BoardSection> = {
  add_constraint: "constraints",
  add_point: "points",
  add_question: "questions",
  add_decision: "decisions",
};

export type AddOpKind = "add_constraint" | "add_point" | "add_question" | "add_decision";

/** Every operation name, in the order the schema offers them to the model. */
export const boardOpKinds = [
  "add_constraint",
  "add_point",
  "add_question",
  "add_decision",
  "set_status",
  "edit_text",
  "set_summary",
] as const;
export type BoardOpKind = (typeof boardOpKinds)[number];

const TextSchema = z.string();
const SourceTurnIdsSchema = z.array(z.string());

const AddOpSchema = z.strictObject({
  op: z.enum(["add_constraint", "add_point", "add_question", "add_decision"]),
  text: TextSchema,
  sourceTurnIds: SourceTurnIdsSchema,
});

const SetStatusOpSchema = z.strictObject({
  op: z.literal("set_status"),
  id: z.string(),
  status: z.enum(itemStatuses),
});

const EditTextOpSchema = z.strictObject({
  op: z.literal("edit_text"),
  id: z.string(),
  text: TextSchema,
});

const SetSummaryOpSchema = z.strictObject({
  op: z.literal("set_summary"),
  text: TextSchema,
});

/**
 * One operation on the board, as the model returns it.
 *
 * Nothing here is validated beyond its shape: a blank text or an id that no
 * longer exists is the model being the model, and `applyOps` reports those
 * rather than rejecting the whole update.
 */
export const BoardOpSchema = z.discriminatedUnion("op", [
  AddOpSchema,
  SetStatusOpSchema,
  EditTextOpSchema,
  SetSummaryOpSchema,
]);
export type BoardOp = z.infer<typeof BoardOpSchema>;
export type AddOp = z.infer<typeof AddOpSchema>;

/** The model's whole reply to a board update request. */
export const BoardUpdateSchema = z.strictObject({
  operations: z.array(BoardOpSchema),
});
export type BoardUpdate = z.infer<typeof BoardUpdateSchema>;

/** The `json_schema.name` the board update request sends. */
export const BOARD_OPS_SCHEMA_NAME = "board_operations";

const addOpVariant = (kind: AddOpKind, what: string) =>
  ({
    type: "object",
    properties: {
      op: { type: "string", enum: [kind] },
      text: { type: "string", description: `${what} Twelve words at most.` },
      sourceTurnIds: {
        type: "array",
        description: "Ids of the turns this came from.",
        items: { type: "string" },
      },
    },
    required: ["op", "text", "sourceTurnIds"],
    additionalProperties: false,
  }) as const;

/**
 * {@link BoardUpdateSchema} as a JSON Schema, written to the subset strict
 * structured output accepts: every object closed and fully `required`, unions
 * as `anyOf`, and no `minItems`/`maxItems`/`maxLength` (unsupported keywords
 * make the request fail, so limits are asked for in prose and enforced by the
 * prompt). Zod's own emitter produces `oneOf` and length keywords, so this is
 * written by hand and `shared/board.test.ts` holds the two in agreement.
 */
export const boardOpsJsonSchema = {
  type: "object",
  properties: {
    operations: {
      type: "array",
      description:
        "The changes this update makes to the board. Empty when nothing new was said.",
      items: {
        anyOf: [
          addOpVariant("add_constraint", "A limit the group stated: budget, deadline, audience, a must-have."),
          addOpVariant("add_point", "An idea or argument the group made."),
          addOpVariant("add_question", "Something the group asked and has not answered."),
          addOpVariant("add_decision", "Something the group settled on."),
          {
            type: "object",
            properties: {
              op: { type: "string", enum: ["set_status"] },
              id: { type: "string", description: "Id of an item already on the board." },
              status: {
                type: "string",
                description:
                  "open: still live. covered: the conversation addressed it. dropped: no longer relevant.",
                enum: [...itemStatuses],
              },
            },
            required: ["op", "id", "status"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              op: { type: "string", enum: ["edit_text"] },
              id: { type: "string", description: "Id of an item already on the board." },
              text: { type: "string", description: "Its new wording. Twelve words at most." },
            },
            required: ["op", "id", "text"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              op: { type: "string", enum: ["set_summary"] },
              text: {
                type: "string",
                description: "What the group is working on, in two sentences at most.",
              },
            },
            required: ["op", "text"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ["operations"],
  additionalProperties: false,
} as const;
