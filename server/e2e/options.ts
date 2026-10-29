/**
 * What `npm run e2e` was asked to do (PRD US-021).
 *
 * Pure, like the eval's: argv in, a plan out, and a reason when there is no
 * plan. The default is the whole set, which is the only form the story's
 * criterion is about; `--fixtures` exists because diagnosing one failing
 * conversation should not cost the other three.
 */
import { E2E_FIXTURES } from "../../shared/e2e.js";

export const E2E_USAGE = `usage: npm run e2e -- [--fixtures <name,name>]\n  fixtures: ${E2E_FIXTURES.join(", ")}`;

export interface E2eOptions {
  /** The conversations to run, in order. */
  fixtures: string[];
}

/** What the arguments meant, or the first thing wrong with them. */
export function parseE2eArgs(argv: readonly string[]): E2eOptions | { error: string } {
  const options: E2eOptions = { fixtures: [...E2E_FIXTURES] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg !== "--fixtures") return { error: `unknown argument ${JSON.stringify(arg)}` };
    const asked = argv[++index];
    if (asked === undefined) return { error: "--fixtures needs a value" };
    const names = asked
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    if (names.length === 0) return { error: "--fixtures was empty" };
    const unknown = names.filter((name) => !(E2E_FIXTURES as readonly string[]).includes(name));
    if (unknown.length > 0) {
      return { error: `not an end-to-end fixture: ${unknown.join(", ")}` };
    }
    // Kept in the set's own order, so the two long conversations still run
    // first and the output reads the same whatever was typed.
    options.fixtures = E2E_FIXTURES.filter((name) => names.includes(name));
  }
  return options;
}
