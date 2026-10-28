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
