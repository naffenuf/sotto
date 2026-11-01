/**
 * Matching what Sotto said to what the fixture planted (PRD US-016).
 *
 * A delivered card and a planted moment are written by different authors in
 * different words — "we agreed on $4,000 and this adds $1,800" against "the
 * budget constraint stated in line 4 is contradicted in line 17" — so the
 * match is a judgement, and a model makes it: one strict structured call per
 * (card, moment) pair, with `server/prompts/judge.md` as the system prompt.
 *
 * Every verdict is cached on disk under `eval/cache/`, keyed by what it
 * depends on: the card's words, the moment it was judged against, and a hash
 * of the judge prompt. Tuning the observer and re-running costs judge calls
 * only for the cards that changed; editing `judge.md` invalidates the lot,
 * which is the point of having the prompt in the key.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  JUDGE_SCHEMA_NAME,
  JudgeReplySchema,
  judgeMatchJsonSchema,
  type DeliveryRecord,
  type JudgeMatchRecord,
} from "../../shared/eval.js";
import type { FixtureScript, PlantedMoment } from "../../shared/fixtures.js";
import { ModelCallError, type ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";
import { momentLines } from "./moments.js";

type Logger = Pick<Console, "log" | "warn">;

/** The label the call is logged under. */
export const JUDGE_LABEL = "judge";

/** Where cached verdicts live, relative to the repo root. */
export const JUDGE_CACHE_DIR = "eval/cache";

/**
 * One card as the judge reads it: what it said, and why it said it then.
 *
 * Narrower than a {@link DeliveryRecord} on purpose, so that a research-ready
 * card — which has no candidate, no level and no policy reason behind it
 * (V2-019) — can be judged by the same prompt without pretending to be a
 * decision the policy took.
 */
export type JudgeCard = Pick<DeliveryRecord, "cardId" | "headline" | "detail" | "whyNow">;

/** One thing to judge: a card Sotto showed, against a moment that was planted. */
export interface JudgePair {
  fixture: string;
  moment: PlantedMoment;
  script: FixtureScript;
  delivery: JudgeCard;
}

/** A verdict as it is stored, with everything needed to read the file later. */
export interface CachedVerdict {
  key: string;
  fixture: string;
  momentId: string;
  cardId: string;
  headline: string;
  matches: boolean;
  reason: string;
  judgedAt: string;
  model: string;
  promptHash: string;
}

/** Short, stable hash of some text. Twelve hex digits is plenty for a key. */
export function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * The cache key for one pair: the card's words, the moment, and the prompt.
 *
 * The moment id is qualified by its fixture because ids are only unique
 * within a script, and the moment's own wording is in the request, so two
 * fixtures that both call a moment `m1` must not share a verdict.
 */
export function judgeKey(input: {
  headline: string;
  detail: string;
  fixture: string;
  momentId: string;
  promptHash: string;
}): string {
  return hashOf(
    [
      input.headline,
      input.detail,
      `${input.fixture}/${input.momentId}`,
      input.promptHash,
    ].join("\n--\n"),
  );
}

/** Verdicts on disk, one small JSON file each. */
export class JudgeCache {
  constructor(private readonly dir: string) {}

  /** The verdict stored under `key`, or `null` if there isn't a usable one. */
  get(key: string): CachedVerdict | null {
    try {
      const parsed = JSON.parse(readFileSync(this.pathFor(key), "utf8")) as CachedVerdict;
      return typeof parsed.matches === "boolean" ? parsed : null;
    } catch {
      // A missing file is the normal case; a corrupt one is judged again.
      return null;
    }
  }

  /** Stores a verdict. A cache that cannot be written is not an error. */
  put(verdict: CachedVerdict): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.pathFor(verdict.key), `${JSON.stringify(verdict, null, 2)}\n`);
    } catch {
      // Re-running costs a call instead. Losing the run would cost more.
    }
  }

  private pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }
}

export interface JudgeOptions {
  model: ModelClient;
  cache: JudgeCache;
  /** The model name, recorded with each verdict. */
  modelName: string;
  logger?: Logger;
}

/** How many calls a judge made, and how many it did not have to. */
export interface JudgeCounts {
  calls: number;
  cacheHits: number;
}

export class Judge {
  private readonly model: ModelClient;
  private readonly cache: JudgeCache;
  private readonly modelName: string;
  private readonly logger: Logger;
  private readonly prompt: string;
  readonly promptHash: string;
  private callCount = 0;
  private hitCount = 0;

  constructor(options: JudgeOptions) {
    this.model = options.model;
    this.cache = options.cache;
    this.modelName = options.modelName;
    this.logger = options.logger ?? console;
    this.prompt = loadPrompt(PROMPTS.judge);
    this.promptHash = hashOf(this.prompt);
  }

  counts(): JudgeCounts {
    return { calls: this.callCount, cacheHits: this.hitCount };
  }

  /**
   * Whether `pair`'s card raises `pair`'s moment.
   *
   * A call that fails comes back as `matches: false` with the error recorded
   * rather than thrown: one unreachable judgement must not throw away a run
   * that took twenty minutes of replaying to produce.
   */
  async judge(pair: JudgePair): Promise<JudgeMatchRecord> {
    const key = judgeKey({
      headline: pair.delivery.headline,
      detail: pair.delivery.detail,
      fixture: pair.fixture,
      momentId: pair.moment.id,
      promptHash: this.promptHash,
    });
    const cached = this.cache.get(key);
    if (cached !== null) {
      this.hitCount += 1;
      return {
        cardId: pair.delivery.cardId,
        momentId: pair.moment.id,
        matches: cached.matches,
        reason: cached.reason,
        cached: true,
      };
    }

    this.callCount += 1;
    let verdict: { matches: boolean; reason: string };
    try {
      verdict = await this.ask(pair);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[judge] ${pair.fixture}/${pair.moment.id} vs ${pair.delivery.cardId} failed: ${detail}`,
      );
      return {
        cardId: pair.delivery.cardId,
        momentId: pair.moment.id,
        matches: false,
        reason: "the judge call failed",
        cached: false,
        error: detail,
      };
    }

    this.cache.put({
      key,
      fixture: pair.fixture,
      momentId: pair.moment.id,
      cardId: pair.delivery.cardId,
      headline: pair.delivery.headline,
      matches: verdict.matches,
      reason: verdict.reason,
      judgedAt: new Date().toISOString(),
      model: this.modelName,
      promptHash: this.promptHash,
    });
    this.logger.log(
      `[judge] ${pair.fixture}/${pair.moment.id} vs ${pair.delivery.cardId}: ` +
        `${verdict.matches ? "match" : "no match"} — ${verdict.reason}`,
    );
    return {
      cardId: pair.delivery.cardId,
      momentId: pair.moment.id,
      matches: verdict.matches,
      reason: verdict.reason,
      cached: false,
    };
  }

  private async ask(pair: JudgePair): Promise<{ matches: boolean; reason: string }> {
    const reply = await this.model.structured({
      label: JUDGE_LABEL,
      system: this.prompt,
      user: renderJudgeRequest(pair),
      schemaName: JUDGE_SCHEMA_NAME,
      schema: judgeMatchJsonSchema,
    });
    const parsed = JudgeReplySchema.safeParse(reply);
    if (!parsed.success) {
      throw new ModelCallError(
        `judge reply did not match the schema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  }
}

/**
 * The user message for one judgement: the moment as the script planted it,
 * then the card as the group saw it.
 *
 * The moment is given in the words of the conversation as well as in the
 * script's own description, because a description is written for a human
 * reading the fixture and the card is about what was actually said.
 */
export function renderJudgeRequest(pair: JudgePair): string {
  const lines = momentLines(pair.moment, pair.script);
  const delivery = pair.delivery;
  const blocks = [
    "## The planted moment",
    `Type: ${pair.moment.type}`,
    `What was planted: ${pair.moment.description}`,
    "Where it was set up, in the speakers' own words:",
    lines.setup.map((line) => `- ${line}`).join("\n"),
    "The line that makes it live:",
    `- ${lines.trigger}`,
    "## The card the assistant showed",
    `Headline: ${delivery.headline}`,
    `Detail: ${delivery.detail.trim() === "" ? "_none_" : delivery.detail}`,
    `Why it said it now: ${delivery.whyNow.trim() === "" ? "_not given_" : delivery.whyNow}`,
    "Does this card raise the planted moment?",
  ];
  return blocks.join("\n\n");
}
