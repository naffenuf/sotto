/**
 * Offline model for session/route plumbing checks, corrected during V2-006.
 * A dummy API key still constructs a real SDK client; inject this instead so
 * replay tests exercise model-ready wiring without network retries or calls.
 */
import type { ModelClient } from "../model/client.js";

/** A configured model that proposes nothing; answer tests supply their own fake. */
export const emptyModel: ModelClient = {
  structured: async (call) => call.label === "board" ? { operations: [] } : { candidates: [] },
  grounded: async () => {
    throw new Error("An empty observer has no facts to verify");
  },
  prose: async () => {
    throw new Error("Answer tests must inject an answering model");
  },
};
