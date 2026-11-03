/**
 * Loads the prompts in this folder.
 *
 * Prompts are `.md` files next to this module rather than template literals in
 * TypeScript, so they can be read, diffed and tuned without touching code —
 * which is most of what the eval harness (US-016) is for. They are read from
 * disk once and cached, so a prompt is one file read per process.
 *
 * `npm run build` copies the `.md` files next to the compiled `index.js`
 * (`dist/server/server/prompts/`, since `tsconfig.server.json` keeps the repo
 * root as its `rootDir`); the path is resolved from `import.meta.url`, so it
 * works from either place.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Every prompt file in this folder, so each name is spelled once. */
export const PROMPTS = {
  /** Keeping the living board up to date (US-009). */
  board: "board",
  /** Noticing things worth raising, and scoring them (US-012). */
  observer: "observer",
  /** Scoring one candidate before the policy sees it (V2-016). */
  gate: "gate",
  /** Proposing things worth looking up in the background (V2-012). */
  researchPlanner: "research-planner",
  /** Deciding whether one research idea is worth a search (V2-012). */
  researchGate: "research-gate",
  /** Looking one research idea up and packaging what it found (V2-013). */
  researchPacket: "research-packet",
  /** Checking a claim against the web before raising it (US-013). */
  verify: "verify",
  /** Checking a claim against the group's own files, before the web (V3-009). */
  verifyKnowledge: "verify-knowledge",
  /** Answering a question somebody asked Sotto out loud (US-018). */
  answer: "answer",
  /** The holding sentence said while a searched answer is written (V2-008c). */
  firstLine: "firstline",
  /** Classifies a spoken interruption without answering it (V2-007). */
  command: "command",
  /** Distinguishes a spoken request from a mention despite missing punctuation (V2-008). */
  address: "address",
  /** Tells a question the room needs looked up from one it is thinking aloud (V3-002). */
  question: "question",
  /** Whether the room is still talking to Sotto after it answered (V3-014). */
  followUp: "followup",
  /** Who each voice is, read off the first turns and any corrections (post-V3-011). */
  introductions: "introductions",
  /** What the room made of an offer Sotto volunteered (V3-005). */
  offerReply: "offer-reply",
  /** A few ideas for a group going round in circles (V3-007). */
  stallIdeas: "stall-ideas",
  /** Whether the room is still waiting for an answer Sotto went and found (V3-004). */
  stillCurrent: "still-current",
  /** Deciding whether a delivered card raises a planted moment (US-016). */
  judge: "judge",
  /**
   * The opening hello, said out loud at the start of a session (V2-009).
   *
   * The one prompt that is not a prompt: it is read verbatim rather than sent
   * to a model, so that what the room hears can be edited in the same place
   * as everything else Sotto says, and so that it is the same every time.
   */
  hello: "hello",
} as const;

export type PromptName = (typeof PROMPTS)[keyof typeof PROMPTS];

const cache = new Map<string, string>();

/** The text of `server/prompts/<name>.md`. */
export function loadPrompt(name: PromptName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const path = fileURLToPath(new URL(`./${name}.md`, import.meta.url));
  const text = readFileSync(path, "utf8").trim();
  if (text === "") throw new Error(`prompt ${path} is empty`);
  cache.set(name, text);
  return text;
}
