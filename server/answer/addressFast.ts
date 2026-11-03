/**
 * Jev in front of the address classifier (post-V3-011).
 *
 * The question "what does the latest turn do with Sotto's name" — request,
 * call_on, name_only, mention — is a pick, and Jev picks in under a second
 * where Spark took 2–10 s this week. That gap is the whole of how long the
 * room waits after "Sotto, can you look up the bus schedules" before
 * anything happens. A request's words are read off the turn after the name
 * ({@link questionAfterName}): the answer agent is handed the transcript
 * too, so "look up those bus schedules" needs no rewriting. When Jev is
 * unsure, or away, Spark decides exactly as before.
 */
import type { z } from "zod";
import type { Clock } from "../clock.js";
import type { JevLike } from "../model/JevClient.js";
import { askJev } from "../model/JevClient.js";
import type { ModelClient } from "../model/client.js";
import { questionAfterName } from "../wake.js";
import { AddressSchema, classifyAddress, type AddressInput } from "./address.js";

type AddressResult = z.infer<typeof AddressSchema>;

/** Below this Jev is unsure and Spark is asked. */
export const ADDRESS_GATE_CONFIDENCE = 0.7;

export const ADDRESS_CRITERIA = {
  request:
    "Someone is asking or telling Sotto to do something: a question for it, a request, an instruction. Also when the previous turn was only the name and this turn is the request.",
  call_on:
    "Someone is inviting Sotto to say whatever it has been holding back, naming no subject: 'Sotto, go ahead', 'what have you got', 'anything?', 'go on Sotto', 'yes Sotto'.",
  name_only:
    "The turn is just the name ('Sotto', 'hey Sotto') and the request is still to come. When Sotto is holding something, a bare name is call_on instead.",
  mention:
    "People are talking about Sotto, or about something else called Soto (a restaurant, a person, 'sotto voce'), remarking to it without asking anything, or reporting what someone asked Sotto earlier.",
} as const;

export interface AddressGateVerdict {
  kind: AddressResult["kind"];
  confidence: number;
  latencyMs: number;
}

export interface AddressGateOptions {
  onGate?: (verdict: AddressGateVerdict & { turnId: string; sparked: boolean }) => void;
  wallClock: Clock;
}

export function renderAddressState(input: AddressInput): string {
  const name = (label: string | null): string => (label === null ? "?" : input.speakers[label] ?? label);
  const previous = input.previous.map((turn) => `${name(turn.speaker)}: ${turn.text.trim()}`).join("\n");
  return (
    `Sotto is holding ${input.raised} thing${input.raised === 1 ? "" : "s"} it has not said.\n\n` +
    `Previous turns:\n${previous === "" ? "(none)" : previous}\n\nLatest turn:\n${name(input.turn.speaker)}: ${input.turn.text.trim()}`
  );
}

export async function gateAddress(
  jev: JevLike,
  input: AddressInput,
  wallClock: Clock,
  signal?: AbortSignal,
): Promise<AddressGateVerdict | null> {
  const started = wallClock.now();
  const response = await askJev(
    jev,
    {
      state: renderAddressState(input),
      questions: {
        kind: {
          type: "choice",
          instructions:
            "Sotto is an AI assistant listening to a meeting through speech recognition, which drops punctuation and spells its name Sotto, Soto, Sato, Sota, Sado, Sana or 'So to'. What does the LATEST turn do with the name?",
          criteria: ADDRESS_CRITERIA,
        },
      },
    },
    (fn, ms) => wallClock.setTimeout(fn, ms),
    signal,
  );
  const kind = response?.answers["kind"];
  if (kind === undefined || kind.type !== "choice" || !(kind.choice in ADDRESS_CRITERIA)) return null;
  return { kind: kind.choice as AddressResult["kind"], confidence: kind.confidence, latencyMs: wallClock.now() - started };
}

/** The address watcher's classifier with Jev in front, same signature as {@link classifyAddress}. */
export function gatedClassifyAddress(
  jev: JevLike | null,
  model: ModelClient,
  options: AddressGateOptions,
): (input: AddressInput, signal?: AbortSignal) => Promise<unknown> {
  return async (input, signal) => {
    if (jev === null) return classifyAddress(model, input, signal);
    const verdict = await gateAddress(jev, input, options.wallClock, signal);
    if (verdict === null) return classifyAddress(model, input, signal);
    // A request needs its words; a bare-name turn read as a request has none,
    // and Spark knows what to make of that.
    const question = verdict.kind === "request" ? questionAfterName(input.turn.text).trim() : "";
    const sparked = verdict.confidence < ADDRESS_GATE_CONFIDENCE || (verdict.kind === "request" && question === "");
    options.onGate?.({ ...verdict, turnId: input.turn.turnId, sparked });
    if (sparked) return classifyAddress(model, input, signal);
    const result: AddressResult = { kind: verdict.kind, question };
    return result;
  };
}
