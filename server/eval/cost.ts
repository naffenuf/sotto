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

/**
 * Realtime transcription, per hour of audio (`tasks/prd-sotto-core.md`).
 *
 * An eval replay pays none of this — the ASR bill for the captures was paid
 * once by `npm run capture` — but the end-to-end check (US-021) streams the
 * WAVs through the real API every time, so its estimate is tokens *plus*
 * audio. The price lives here because this is where Sotto's prices live.
 */
export const ASR_USD_PER_HOUR = 0.18;

/** The estimate, in US dollars. */
export function estimateCostUsd(usage: TokenUsage): number {
  return (
    (usage.inputTokens / 1_000_000) * SPARK_INPUT_USD_PER_MTOK +
    (usage.outputTokens / 1_000_000) * SPARK_OUTPUT_USD_PER_MTOK
  );
}

/** What `seconds` of audio cost to transcribe, in US dollars. */
export function estimateAsrCostUsd(seconds: number): number {
  return (seconds / 3600) * ASR_USD_PER_HOUR;
}

/**
 * ElevenLabs, per character of speech (V2-021).
 *
 * Billed in credits, and `eleven_flash_v2_5` — the model Sotto speaks with —
 * is "50% lower price per character for API generations"
 * (https://elevenlabs.io/docs/models), i.e. half a credit each. A credit's
 * price is the plan's: the Creator plan is $22 a month for 121,000 of them
 * (https://elevenlabs.io/pricing), so a character is about $0.00009 and a
 * thousand are about nine cents.
 *
 * Plan-dependent, which is the one reason this is an estimate rather than the
 * bill: a bigger plan buys the same characters cheaper. The characters
 * themselves are counted exactly, at the voice seam (`meteredVoice`), so the
 * report prints both and a reader can reprice it.
 */
export const TTS_CREDITS_PER_CHAR = 0.5;
export const TTS_USD_PER_CREDIT = 22 / 121_000;

/** What `characters` of Flash speech cost, in US dollars. */
export function estimateTtsCostUsd(characters: number): number {
  return characters * TTS_CREDITS_PER_CHAR * TTS_USD_PER_CREDIT;
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
