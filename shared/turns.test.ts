import { describe, expect, it } from "vitest";
import { SOTTO_SPEAKER, isSottoTurn, sottoTurn, sottoTurnId } from "./turns.js";

describe("Sotto's own turns (V2-008a)", () => {
  it("is a final turn labeled Sotto, placed where playback started", () => {
    const turn = sottoTurn({
      utteranceId: "ans-2",
      text: "  They charge five\n to twenty-five dollars a seat.  ",
      startMs: 42_000,
      interrupted: false,
    });
    expect(turn).toEqual({
      turnId: "sotto:ans-2",
      speaker: SOTTO_SPEAKER,
      // One line, because transcript.md is one line per turn.
      text: "They charge five to twenty-five dollars a seat.",
      final: true,
      startMs: 42_000,
      endMs: 42_000,
      speakerMappingUncertain: false,
      sotto: true,
    });
    expect(isSottoTurn(turn)).toBe(true);
    expect(sottoTurnId("ans-2")).toBe(turn.turnId);
  });

  it("marks a line the room only heard part of", () => {
    const turn = sottoTurn({
      utteranceId: "ans-1",
      text: "They charge five to",
      startMs: 0,
      interrupted: true,
    });
    expect(turn.interrupted).toBe(true);
  });

  it("leaves a human turn alone", () => {
    expect(
      isSottoTurn({
        turnId: "0:1",
        speaker: "A",
        text: "Sotto, what do rivals charge?",
        final: true,
        startMs: 0,
        endMs: 1_000,
        speakerMappingUncertain: false,
      }),
    ).toBe(false);
  });
});
