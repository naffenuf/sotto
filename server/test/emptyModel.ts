/**
 * Offline model for session/route plumbing checks, corrected during V2-006.
 * A dummy API key still constructs a real SDK client; inject this instead so
 * replay tests exercise model-ready wiring without network retries or calls.
 */
import type { ModelClient } from "../model/client.js";

/** A configured model that proposes nothing; answer tests supply their own fake. */
export const emptyModel: ModelClient = {
  structured: async (call) => {
    if (call.label === "board") return { operations: [] };
    // V2-008c: nothing worth saying while it searches, which is a valid reply.
    if (call.label === "first_line") return { line: "" };
    // V2-012: the planner proposes nothing, which is its usual answer, and
    // the gate is never reached because there is nothing to score.
    if (call.label === "research-planner") return { ideas: [] };
    return { candidates: [] };
  },
  grounded: async () => {
    throw new Error("An empty observer has no facts to verify");
  },
  prose: async () => {
    throw new Error("Answer tests must inject an answering model");
  },
};
