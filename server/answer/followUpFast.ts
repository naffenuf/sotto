/**
 * Jev in front of the follow-up classifier (post-V3-011).
 *
 * "And how much is the ticket roughly?", said right after Sotto answered the
 * bus question, waited six seconds for Spark, hit the deadline and was
 * dropped as `unsure` — which closes the window, because answering a line
 * meant for a person is the worse failure. Jev picks to_sotto / to_room /
 * closing in under a second, with Sotto's own question and answer in front of
 * it; a confident `to_sotto` is asked as said, since the answer agent is
 * handed the transcript and needs no rewriting. Unsure, or away: Spark.
 */
import type { Clock } from "../clock.js";
import type { JevLike } from "../model/JevClient.js";
import { askJev } from "../model/JevClient.js";
import type { ModelClient } from "../model/client.js";
import { classifyFollowUp, type FollowUpInput, type FollowUpKind, type FollowUpResult } from "./followUp.js";

/**
 * Below this Jev is unsure and Spark is asked. Higher than the other gates:
 * "The hotel is 200 a night and the whole trip has to come in under $300",
 * said to the room after an answer, came back `to_sotto` at 0.74, and
 * answering a line meant for a person is the worse failure.
 */
export const FOLLOWUP_GATE_CONFIDENCE = 0.8;

export const FOLLOWUP_CRITERIA: Record<FollowUpKind, string> = {
  to_sotto:
    "The speaker is still talking to Sotto: a follow-up question about what Sotto just answered, a request for more, a correction of it, or a new question for Sotto — no name needed, Sotto has just spoken.",
  to_room:
    "The speaker has turned back to the other people in the room: talking to a colleague, reacting among themselves, carrying on the meeting.",
  closing:
    "The speaker is closing the exchange with Sotto: thanks, okay, got it, that's all, never mind.",
};

export interface FollowUpGateVerdict {
  kind: FollowUpKind;
  confidence: number;
  latencyMs: number;
}

export interface FollowUpGateOptions {
  onGate?: (verdict: FollowUpGateVerdict & { turnId: string; sparked: boolean }) => void;
  wallClock: Clock;
}

export function renderFollowUpState(input: FollowUpInput): string {
  const name = (label: string | null): string => (label === null ? "?" : input.speakers[label] ?? label);
  const said = input.answer.spokenText.trim();
  const previous = input.previous.map((turn) => `${name(turn.speaker)}: ${turn.text.trim()}`).join("\n");
  return (
    `Sotto was asked: ${input.answer.question}\n` +
    `Sotto answered: ${said === "" ? input.answer.headline : said}\n\n` +
    `Previous turns:\n${previous === "" ? "(none)" : previous}\n\nLatest turn:\n${name(input.turn.speaker)}: ${input.turn.text.trim()}`
  );
}

export async function gateFollowUp(
  jev: JevLike,
  input: FollowUpInput,
  wallClock: Clock,
  signal?: AbortSignal,
): Promise<FollowUpGateVerdict | null> {
  const started = wallClock.now();
  const response = await askJev(
    jev,
    {
      state: renderFollowUpState(input),
      questions: {
        kind: {
          type: "choice",
          instructions:
            "Sotto, an AI assistant in a meeting, has just answered a question out loud. Who is the LATEST turn talking to?",
          criteria: FOLLOWUP_CRITERIA,
        },
      },
    },
    (fn, ms) => wallClock.setTimeout(fn, ms),
    signal,
  );
  const kind = response?.answers["kind"];
  if (kind === undefined || kind.type !== "choice" || !(kind.choice in FOLLOWUP_CRITERIA)) return null;
  return { kind: kind.choice as FollowUpKind, confidence: kind.confidence, latencyMs: wallClock.now() - started };
}

/** The window's classifier with Jev in front, same signature as {@link classifyFollowUp}. */
export function gatedClassifyFollowUp(
  jev: JevLike | null,
  model: ModelClient,
  options: FollowUpGateOptions,
): (input: FollowUpInput, signal?: AbortSignal) => Promise<unknown> {
  return async (input, signal) => {
    if (jev === null) return classifyFollowUp(model, input, signal);
    const verdict = await gateFollowUp(jev, input, options.wallClock, signal);
    if (verdict === null) return classifyFollowUp(model, input, signal);
    const sparked = verdict.confidence < FOLLOWUP_GATE_CONFIDENCE;
    options.onGate?.({ ...verdict, turnId: input.turn.turnId, sparked });
    if (sparked) return classifyFollowUp(model, input, signal);
    const result: FollowUpResult = {
      kind: verdict.kind,
      question: verdict.kind === "to_sotto" ? input.turn.text.trim() : "",
    };
    return result;
  };
}
