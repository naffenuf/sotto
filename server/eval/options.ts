/**
 * What `npm run eval` was asked to do (PRD US-016).
 *
 * Pure: it turns argv into a plan and says why when it cannot, so the script
 * around it does nothing but I/O.
 */
import { DEFAULT_GATE_MODE, gateModes, type GateMode } from "../../shared/candidates.js";
import { chattinessLevels, DEFAULT_CHATTINESS, type Chattiness } from "../../shared/policy.js";

/** The conversations the harness measures: the two quiet ones, then the moments. */
export function isEvalFixture(name: string): boolean {
  return name === "brainstorm" || name === "no-wake" || name.startsWith("moment-");
}

/**
 * The eval set, in the order it is run: `brainstorm` and `no-wake` first —
 * they are the ones a false interjection is a gate failure on — then every
 * `moment-*` fixture alphabetically.
 */
export function evalFixtures(available: readonly string[]): string[] {
  const chosen = available.filter(isEvalFixture);
  const rank = (name: string): number => (name === "brainstorm" ? 0 : name === "no-wake" ? 1 : 2);
  return [...chosen].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export interface EvalOptions {
  /** The settings to run, in order. `--chattiness all` gives all three. */
  chattiness: Chattiness[];
  /**
   * Who scores the candidates (V2-016): `glimmer` for the local gate, `spark`
   * for the observer's own scores, which is the baseline it is measured
   * against. One per run — two gates are two experiments.
   */
  gate: GateMode;
  /** Fixture names, or `null` for "the whole eval set that is captured". */
  fixtures: string[] | null;
  /** Skip the judge: replay and record, matching nothing. For a quick look. */
  skipJudge: boolean;
}

export const EVAL_USAGE =
  "usage: npm run eval -- [--chattiness quiet|normal|active|all] " +
  "[--gate glimmer|spark] [--fixtures <name,name>] [--no-judge]";

/** What the arguments meant, or the first thing wrong with them. */
export function parseEvalArgs(argv: readonly string[]): EvalOptions | { error: string } {
  const options: EvalOptions = {
    chattiness: [DEFAULT_CHATTINESS],
    gate: DEFAULT_GATE_MODE,
    fixtures: null,
    skipJudge: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const value = (): string | undefined => argv[++index];
    if (arg === "--chattiness") {
      const asked = value();
      if (asked === undefined) return { error: "--chattiness needs a value" };
      if (asked === "all") {
        options.chattiness = [...chattinessLevels];
        continue;
      }
      if (!isChattiness(asked)) {
        return { error: `unknown chattiness ${JSON.stringify(asked)}; ${EVAL_USAGE}` };
      }
      options.chattiness = [asked];
    } else if (arg === "--gate") {
      const asked = value();
      if (asked === undefined) return { error: "--gate needs a value" };
      if (!isGateMode(asked)) {
        return { error: `unknown gate ${JSON.stringify(asked)}; ${EVAL_USAGE}` };
      }
      options.gate = asked;
    } else if (arg === "--fixtures") {
      const asked = value();
      if (asked === undefined) return { error: "--fixtures needs a value" };
      const names = asked
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");
      if (names.length === 0) return { error: "--fixtures was empty" };
      options.fixtures = names;
    } else if (arg === "--no-judge") {
      options.skipJudge = true;
    } else {
      return { error: `unknown argument ${JSON.stringify(arg)}; ${EVAL_USAGE}` };
    }
  }
  return options;
}

function isChattiness(value: string): value is Chattiness {
  return (chattinessLevels as readonly string[]).includes(value);
}

function isGateMode(value: string): value is GateMode {
  return (gateModes as readonly string[]).includes(value);
}

/**
 * A run's id, which is also its file name: `YYYY-MM-DD_HHMMSS`, in local
 * time, like a session folder's but with seconds — two runs a minute apart
 * are ordinary.
 */
export function runTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
