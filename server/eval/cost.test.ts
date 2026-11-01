import { describe, expect, it } from "vitest";
import {
  SPARK_INPUT_USD_PER_MTOK,
  SPARK_OUTPUT_USD_PER_MTOK,
  UsageMeter,
  addUsage,
  emptyUsage,
  TTS_CREDITS_PER_CHAR,
  TTS_USD_PER_CREDIT,
  estimateCostUsd,
  estimateTtsCostUsd,
  formatUsd,
} from "./cost.js";

describe("estimateCostUsd", () => {
  it("prices a million of each at the published rates", () => {
    const usage = {
      calls: 1,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 900_000,
    };
    expect(estimateCostUsd(usage)).toBeCloseTo(
      SPARK_INPUT_USD_PER_MTOK + SPARK_OUTPUT_USD_PER_MTOK,
    );
  });

  it("does not bill reasoning tokens twice: they are part of the output", () => {
    const thinking = { calls: 1, inputTokens: 0, outputTokens: 2_000, reasoningTokens: 1_800 };
    const silent = { calls: 1, inputTokens: 0, outputTokens: 2_000, reasoningTokens: 0 };
    expect(estimateCostUsd(thinking)).toBe(estimateCostUsd(silent));
  });

  it("costs nothing for nothing", () => {
    expect(estimateCostUsd(emptyUsage())).toBe(0);
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("estimateTtsCostUsd", () => {
  it("prices a thousand Flash characters at half a credit each", () => {
    expect(estimateTtsCostUsd(1_000)).toBeCloseTo(1_000 * 0.5 * TTS_USD_PER_CREDIT);
    expect(TTS_CREDITS_PER_CHAR).toBe(0.5);
    // About nine cents a thousand on the plan this is priced against.
    expect(estimateTtsCostUsd(1_000)).toBeCloseTo(0.0909, 4);
  });

  it("costs nothing for a session nobody heard", () => {
    expect(estimateTtsCostUsd(0)).toBe(0);
  });
});

describe("addUsage", () => {
  it("adds every field", () => {
    const sum = addUsage(
      { calls: 1, inputTokens: 10, outputTokens: 20, reasoningTokens: 15 },
      { calls: 2, inputTokens: 1, outputTokens: 2, reasoningTokens: 1 },
    );
    expect(sum).toEqual({ calls: 3, inputTokens: 11, outputTokens: 22, reasoningTokens: 16 });
  });
});

describe("UsageMeter", () => {
  it("counts a call per report and totals the tokens", () => {
    const meter = new UsageMeter();
    meter.record({ label: "board", inputTokens: 900, outputTokens: 300, reasoningTokens: 210 });
    meter.record({ label: "judge", inputTokens: 600, outputTokens: 200, reasoningTokens: 150 });
    expect(meter.total()).toEqual({
      calls: 2,
      inputTokens: 1_500,
      outputTokens: 500,
      reasoningTokens: 360,
    });
  });

  it("is a bound method, so it can be passed straight to `onUsage`", () => {
    const meter = new UsageMeter();
    const onUsage = meter.record;
    onUsage({ label: "observer", inputTokens: 1, outputTokens: 2, reasoningTokens: 0 });
    expect(meter.total().calls).toBe(1);
  });

  it("hands back a copy, so a later call does not change an old total", () => {
    const meter = new UsageMeter();
    const before = meter.total();
    meter.record({ label: "verify", inputTokens: 5, outputTokens: 5, reasoningTokens: 0 });
    expect(before.calls).toBe(0);
  });
});

describe("formatUsd", () => {
  it("shows four places, because a run costs cents", () => {
    expect(formatUsd(0.0123456)).toBe("$0.0123");
  });
});
