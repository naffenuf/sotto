/**
 * Which prompts produced a run's numbers (PRD US-016 part 2).
 *
 * The whole point of keeping prompts in `server/prompts/*.md` is that tuning
 * them is the work (US-023), so a report that does not say which version of
 * them it measured is not comparable to the next one. Twelve hex digits of
 * sha256 per file, over the text the model is actually given — trimmed, as
 * {@link loadPrompt} hands it over.
 */
import type { PromptHash } from "../../shared/eval.js";
import { PROMPTS, loadPrompt, type PromptName } from "../prompts/index.js";
import { hashOf } from "./judge.js";

/** Every prompt in `server/prompts/`, hashed, in the order {@link PROMPTS} lists. */
export function promptHashes(): PromptHash[] {
  return Object.values(PROMPTS).map((name: PromptName) => ({
    file: `server/prompts/${name}.md`,
    hash: hashOf(loadPrompt(name)),
  }));
}
