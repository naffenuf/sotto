/**
 * Jev in front of the question classifier (post-V3-011).
 *
 * Every final turn is read (the word check is gone), and Spark takes six to
 * fourteen seconds of thinking on a slow afternoon to say "none" about "we
 * want to go at around ten". Jev says it in under a second. So Jev reads
 * every turn, and Spark is only asked about the ones Jev thinks are a
 * lookup, a question for the room settling into a decision, or anything it
 * is not sure about — and Spark still writes the question to search, the
 * topic for "I'll check the drive time", and the decision in a few words.
 * Spark's verdict stands on those; Jev's stands on the rest.
 */
import type { Clock } from "../clock.js";
import type { JevLike } from "../model/JevClient.js";
import { askJev } from "../model/JevClient.js";
import type { ModelClient } from "../model/client.js";
import { classifyQuestion, questionKinds, type QuestionInput, type QuestionKind, type QuestionResult } from "./question.js";

/** Below this Jev is unsure, and Spark is asked whatever Jev picked. */
export const GATE_CONFIDENCE = 0.65;
/** A yes-probability this high on "settles a decision" sends the turn to Spark for the words. */
export const GATE_CLOSING = 0.6;
/**
 * Above this, Jev's `open_question` starts the search *before* Spark has
 * written the clean question: the room's own words are a good enough query,
 * and Spark's six to fourteen seconds on a slow day were the single largest
 * wait between "we need the bus schedules" and an answer. A wasted search is
 * about five cents; Spark's verdict confirms or drops it.
 */
export const SPECULATE_CONFIDENCE = 0.9;

/** What Jev is told each kind means — the prompt's own definitions, shortened. */
export const QUESTION_CRITERIA: Record<QuestionKind, string> = {
  open_question:
    "Somebody asked or wondered aloud, to the room and not to Sotto, something a web search can answer: a price, a schedule, a drive time, opening hours, a date, a number about the world. Nobody present knows it and nobody has answered it. A need said as a statement counts: 'we need the bus schedules', 'we should find the cheapest one'.",
  to_group:
    "A question only the people in the room can answer: who is doing something, what somebody thinks, what happened inside this team.",
  rhetorical: "Asked to make a point, not to get an answer.",
  decision:
    "The group deciding or choosing something it owns: which day, which option, whether to do it — asking, weighing or settling it.",
  answered: "A question somebody present already answered, in this turn or the previous one.",
  none:
    "Not a question or a need at all: a plan, a task for the group, small talk, a reply to somebody else's question, or a request addressed to Sotto by name.",
};

export interface GateVerdict {
  kind: QuestionKind;
  confidence: number;
  /** Probability the turn settles a decision. */
  closing: number;
  latencyMs: number;
}

export interface GateOptions {
  /** Every Jev verdict, for `timing.jsonl` (`question_gate`). */
  onGate?: (verdict: GateVerdict & { turnId: string; sparked: boolean }) => void;
  /**
   * Jev is sure this is a lookup: start it now, with the words as heard.
   * Spark's verdict follows through {@link onSpeculationSettled}.
   */
  onSpeculate?: (input: QuestionInput, verdict: GateVerdict) => void;
  /** Spark agreed (`true`) — its clean question arrives the usual way — or did not. */
  onSpeculationSettled?: (turnId: string, confirmed: boolean) => void;
  wallClock: Clock;
}

/** The state Jev reads: the previous turns by name, then the latest. */
export function renderGateState(input: QuestionInput): string {
  const name = (label: string | null): string => (label === null ? "?" : input.speakers[label] ?? label);
  const previous = input.previous.map((turn) => `${name(turn.speaker)}: ${turn.text.trim()}`).join("\n");
  return `Previous turns:\n${previous === "" ? "(none)" : previous}\n\nLatest turn:\n${name(input.turn.speaker)}: ${input.turn.text.trim()}`;
}

/** Jev's read of one turn, or `null` when it did not answer in time. */
export async function gateQuestion(
  jev: JevLike,
  input: QuestionInput,
  wallClock: Clock,
  signal?: AbortSignal,
): Promise<GateVerdict | null> {
  const started = wallClock.now();
  const response = await askJev(
    jev,
    {
      state: renderGateState(input),
      questions: {
        kind: {
          type: "choice",
          instructions:
            "What does the LATEST turn do, given the turns before it? Sotto is an AI listening to a meeting through speech recognition that drops punctuation; it can search the web.",
          criteria: QUESTION_CRITERIA,
        },
        closing: {
          type: "noul",
          instructions:
            "The latest turn settles a decision rather than weighing it ('let's lock that in', 'so we're agreed on Saturday', 'fine, we go with six').",
        },
      },
    },
    (fn, ms) => wallClock.setTimeout(fn, ms),
    signal,
  );
  const kind = response?.answers["kind"];
  const closing = response?.answers["closing"];
  if (kind === undefined || kind.type !== "choice" || !(questionKinds as readonly string[]).includes(kind.choice)) return null;
  return {
    kind: kind.choice as QuestionKind,
    confidence: kind.confidence,
    closing: closing?.type === "noul" ? closing.noul : 0,
    latencyMs: wallClock.now() - started,
  };
}

/** Whether Spark has to be asked for the words, or for a second opinion. */
export function needsSpark(verdict: GateVerdict): boolean {
  if (verdict.kind === "open_question") return true;
  if (verdict.closing >= GATE_CLOSING) return true;
  return verdict.confidence < GATE_CONFIDENCE;
}

/**
 * The question watcher's classifier with Jev in front: the same signature
 * as {@link classifyQuestion}, so the watcher does not know which answered.
 */
export function gatedClassifyQuestion(
  jev: JevLike | null,
  model: ModelClient,
  options: GateOptions,
): (input: QuestionInput, signal?: AbortSignal) => Promise<unknown> {
  return async (input, signal) => {
    if (jev === null) return classifyQuestion(model, input, signal);
    const verdict = await gateQuestion(jev, input, options.wallClock, signal);
    if (verdict === null) return classifyQuestion(model, input, signal);
    const sparked = needsSpark(verdict);
    options.onGate?.({ ...verdict, turnId: input.turn.turnId, sparked });
    const speculate =
      verdict.kind === "open_question" && verdict.confidence >= SPECULATE_CONFIDENCE &&
      options.onSpeculate !== undefined;
    if (speculate) options.onSpeculate?.(input, verdict);
    if (sparked) {
      if (!speculate) return classifyQuestion(model, input, signal);
      let result: unknown;
      try {
        result = await classifyQuestion(model, input, signal);
      } catch (error) {
        options.onSpeculationSettled?.(input.turn.turnId, false);
        throw error;
      }
      const confirmed = (result as { kind?: unknown } | null)?.kind === "open_question";
      options.onSpeculationSettled?.(input.turn.turnId, confirmed);
      return result;
    }
    const result: QuestionResult = { kind: verdict.kind, question: "", topic: "", closing: false, decision: "" };
    return result;
  };
}
