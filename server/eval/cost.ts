/**
 * What a run of the harness cost (PRD US-016).
 *
 * The report has to say what the numbers above it were bought for, so every
 * model call the run makes — the board updates, the observer's looks, the
 * verifier's searches and the judge's verdicts — reports its token usage to
 * one {@link UsageMeter}, and the estimate is those tokens at the published
 * prices.
 *
 * It is an *estimate* for two reasons worth remembering before trusting it to
 * the cent: hidden reasoning tokens are billed as output and are the bulk of
 * what this model emits, and the search the verifier and answer agent run has
 * a per-call price of its own that the usage object says nothing about. The
 * replays themselves cost no transcription at all — an eval replays captured
 * events, so the ASR bill was paid once by `npm run capture`.
 */
import type { RunTokenUsage } from "../../shared/eval.js";
import type { ModelUsage } from "../model/client.js";

/**
 * Muse Spark 1.3, per million tokens (`tasks/prd-sotto-core.md`). Reasoning
 * tokens are output tokens.
 */
export const SPARK_INPUT_USD_PER_MTOK = 1.25;
export const SPARK_OUTPUT_USD_PER_MTOK = 4.25;

/**
 * Everything one run asked the model for. The same shape a run record
 * stores, so a report can be rebuilt from `eval/runs/` without converting.
 */
export type TokenUsage = RunTokenUsage;

export function emptyUsage(): TokenUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** The estimate, in US dollars. */
export function estimateCostUsd(usage: TokenUsage): number {
  return (
    (usage.inputTokens / 1_000_000) * SPARK_INPUT_USD_PER_MTOK +
    (usage.outputTokens / 1_000_000) * SPARK_OUTPUT_USD_PER_MTOK
  );
}

/** `$0.0123`, or `$0.00` for nothing. Four places: a run is cents, not dollars. */
export function formatUsd(amount: number): string {
  return amount === 0 ? "$0.00" : `$${amount.toFixed(4)}`;
}

/**
 * Adds up what every call reported.
 *
 * {@link record} is bound, so it can be handed straight to `MuseClient`'s
 * `onUsage` without a wrapper.
 */
export class UsageMeter {
  private usage = emptyUsage();

  readonly record = (call: ModelUsage): void => {
    this.usage = addUsage(this.usage, {
      calls: 1,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      reasoningTokens: call.reasoningTokens,
    });
  };

  total(): TokenUsage {
    return { ...this.usage };
  }
}
