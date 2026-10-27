import { describe, expect, it } from "vitest";
import {
  BOARD_OPS_SCHEMA_NAME,
  BoardOpSchema,
  BoardUpdateSchema,
  addOpSections,
  boardOpKinds,
  boardOpsJsonSchema,
  boardSections,
  emptyBoard,
  itemStatuses,
  sectionAddOps,
  sectionIdPrefixes,
} from "./board.js";

/** Keywords strict structured output rejects, and the union form it wants. */
const unsupportedKeywords = [
  "oneOf",
  "allOf",
  "not",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "default",
];

type JsonSchemaNode = Record<string, unknown>;

/** Every object and array node in the schema, so a rule can be checked on all of them. */
function walk(node: unknown, path = "$", found: { path: string; node: JsonSchemaNode }[] = []) {
  if (node === null || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, `${path}[${index}]`, found));
    return found;
  }
  const schema = node as JsonSchemaNode;
  found.push({ path, node: schema });
  for (const [key, value] of Object.entries(schema)) walk(value, `${path}.${key}`, found);
  return found;
}

const variants = boardOpsJsonSchema.properties.operations.items.anyOf as readonly JsonSchemaNode[];

/** The `op` value a variant accepts, read off its single-value enum. */
function variantKind(variant: JsonSchemaNode): string {
  const op = (variant.properties as JsonSchemaNode).op as { enum: string[] };
  expect(op.enum).toHaveLength(1);
  return op.enum[0]!;
}

/** A minimal object satisfying one variant, built from the schema alone. */
function sample(variant: JsonSchemaNode): Record<string, unknown> {
  const properties = variant.properties as Record<string, JsonSchemaNode>;
  const value: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    const choices = property.enum as string[] | undefined;
    if (choices !== undefined) value[key] = choices[0];
    else if (property.type === "array") value[key] = ["0:1"];
    else value[key] = "something said";
  }
  return value;
}

describe("board model", () => {
  it("starts empty", () => {
    const board = emptyBoard();
    expect(board.summary).toBe("");
    for (const section of boardSections) expect(board[section]).toEqual([]);
  });

  it("gives every section its own id prefix and add op", () => {
    const prefixes = boardSections.map((section) => sectionIdPrefixes[section]);
    expect(prefixes).toEqual(["c", "p", "q", "d"]);
    for (const section of boardSections) {
      expect(addOpSections[sectionAddOps[section]]).toBe(section);
    }
  });
});

describe("BoardOpSchema", () => {
  it("accepts one of each operation", () => {
    const ops = [
      { op: "add_constraint", text: "under $20k", sourceTurnIds: ["0:1"] },
      { op: "add_point", text: "start with the mobile app", sourceTurnIds: [] },
      { op: "add_question", text: "who signs this off?", sourceTurnIds: ["0:2"] },
      { op: "add_decision", text: "ship the pilot in March", sourceTurnIds: ["0:3"] },
      { op: "set_status", id: "p1", status: "covered" },
      { op: "edit_text", id: "p1", text: "start with mobile" },
      { op: "set_summary", text: "The group is scoping a pilot." },
    ];
    expect(BoardUpdateSchema.parse({ operations: ops }).operations).toHaveLength(ops.length);
    expect(ops.map((op) => BoardOpSchema.parse(op).op)).toEqual([...boardOpKinds]);
  });

  it("rejects an unknown operation, a bad status and stray fields", () => {
    expect(BoardOpSchema.safeParse({ op: "delete_point", id: "p1" }).success).toBe(false);
    expect(BoardOpSchema.safeParse({ op: "set_status", id: "p1", status: "done" }).success).toBe(false);
    expect(
      BoardOpSchema.safeParse({ op: "set_summary", text: "fine", extra: true }).success,
    ).toBe(false);
    expect(BoardUpdateSchema.safeParse({ operations: {} }).success).toBe(false);
  });
});

describe("boardOpsJsonSchema", () => {
  it("is named, closed and fully required all the way down", () => {
    expect(BOARD_OPS_SCHEMA_NAME).toBe("board_operations");
    for (const { path, node } of walk(boardOpsJsonSchema)) {
      for (const keyword of unsupportedKeywords) {
        expect(node[keyword], `${path} uses ${keyword}`).toBeUndefined();
      }
      if (node.type !== "object") continue;
      expect(node.additionalProperties, `${path} is open`).toBe(false);
      const properties = Object.keys(node.properties as JsonSchemaNode);
      expect(node.required, `${path} does not require every property`).toEqual(properties);
    }
  });

  it("offers exactly the operations the zod union accepts", () => {
    expect(variants.map(variantKind)).toEqual([...boardOpKinds]);
  });

  it("describes operations zod then accepts", () => {
    for (const variant of variants) {
      const parsed = BoardOpSchema.safeParse(sample(variant));
      expect(parsed.success, `${variantKind(variant)} sample rejected`).toBe(true);
    }
  });

  it("requires exactly the fields zod requires", () => {
    for (const variant of variants) {
      const full = sample(variant);
      for (const key of Object.keys(full)) {
        const { [key]: _dropped, ...without } = full;
        expect(BoardOpSchema.safeParse(without).success, `${key} is optional to zod`).toBe(false);
      }
      expect(BoardOpSchema.safeParse({ ...full, extra: 1 }).success).toBe(false);
    }
  });

  it("offers the same statuses as the model type", () => {
    const setStatus = variants.find((variant) => variantKind(variant) === "set_status")!;
    const status = (setStatus.properties as Record<string, JsonSchemaNode>).status!;
    expect(status.enum).toEqual([...itemStatuses]);
  });
});
