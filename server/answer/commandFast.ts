/**
 * Jev in front of the command classifier (post-V3-011).
 *
 * "Sotto, how long does the bus take?" said over Sotto's own answer is a
 * barge-in: the speech stops at once, and then the room waited **six
 * seconds** for Spark to say what the turn wanted — the whole deadline,
 * on `2026-11-03_1534-mic` — before the new question was even queued. Jev
 * picks stop / new_question / continue / quieter / louder in under a
 * second; a new question's words are read off the turn after the name.
 */
import type { Clock } from "../clock.js";
import type { JevLike } from "../model/JevClient.js";
import { askJev } from "../model/JevClient.js";
import type { ModelClient } from "../model/client.js";
import { questionAfterName } from "../wake.js";
import { classifyCommand, type CommandKind, type CommandSchema } from "./command.js";
import type { z } from "zod";

type Command = z.infer<typeof CommandSchema>;

export const COMMAND_GATE_CONFIDENCE = 0.7;

export const COMMAND_CRITERIA: Record<CommandKind, string> = {
  stop: "Stop talking: 'stop', 'that's enough', 'okay okay', 'we got it', 'hold on', 'not now' said once about this answer.",
  new_question: "A different question or request for Sotto, to answer instead of what it was saying.",
  continue: "Carry on from where it was cut off: 'go on', 'continue', 'sorry, keep going'.",
  quieter: "Sotto should contribute less for the rest of the meeting: 'not now', 'that's too much', 'you're being too chatty', 'stay out of it'.",
  louder: "Sotto should contribute more: 'you can jump in more', 'speak up when you have something'.",
  side_talk: "Not about Sotto at all: people talking to each other, reacting among themselves, carrying on the meeting over it.",
};

export interface CommandGateVerdict {
  kind: CommandKind;
  confidence: number;
  latencyMs: number;
}

export interface CommandGateOptions {
  onGate?: (verdict: CommandGateVerdict & { sparked: boolean }) => void;
  wallClock: Clock;
}

export async function gateCommand(
  jev: JevLike,
  text: string,
  wallClock: Clock,
  signal?: AbortSignal,
): Promise<CommandGateVerdict | null> {
  const started = wallClock.now();
  const response = await askJev(
    jev,
    {
      state: `Sotto, an AI assistant in a meeting, was speaking and somebody interrupted it with this turn:\n${text.trim()}`,
      questions: {
        kind: {
          type: "choice",
          instructions: "What does the interrupting turn want from Sotto? The speech has already stopped.",
          criteria: COMMAND_CRITERIA,
        },
      },
    },
    (fn, ms) => wallClock.setTimeout(fn, ms),
    signal,
  );
  const kind = response?.answers["kind"];
  if (kind === undefined || kind.type !== "choice" || !(kind.choice in COMMAND_CRITERIA)) return null;
  return { kind: kind.choice as CommandKind, confidence: kind.confidence, latencyMs: wallClock.now() - started };
}

/** The command classifier with Jev in front, same result as {@link classifyCommand}. */
export async function gatedClassifyCommand(
  jev: JevLike | null,
  model: ModelClient,
  text: string,
  options: CommandGateOptions,
  signal?: AbortSignal,
): Promise<Command> {
  if (jev === null) return classifyCommand(model, text, signal);
  const verdict = await gateCommand(jev, text, options.wallClock, signal);
  if (verdict === null) return classifyCommand(model, text, signal);
  const question = verdict.kind === "new_question" ? questionAfterName(text).trim() : "";
  const sparked = verdict.confidence < COMMAND_GATE_CONFIDENCE || (verdict.kind === "new_question" && question === "");
  options.onGate?.({ ...verdict, sparked });
  if (sparked) return classifyCommand(model, text, signal);
  return { command: verdict.kind, question };
}
