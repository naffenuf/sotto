/**
 * Before Sotto reads out what it is holding, which of it has the room already
 * dealt with? (V3-017, after `sessions/2026-11-03_2109-mic`.)
 *
 * "Sotto, go ahead" can come minutes after a hand went up, and in between the
 * room may have answered the question itself. Reading a stale answer out is
 * the worse failure, so each held item is checked against what has been said
 * since it was raised — in **one** Jev call, because the room is waiting:
 * every item is a `noul` under its own card id over one shared state, and
 * Jev answers in a few hundred milliseconds. No Jev, or a Jev that does not
 * answer in time, means nothing is dropped: losing the check costs judgment,
 * not the answer the room asked for.
 */
import type { TurnUpdate } from "../../shared/turns.js";
import type { SpeakerNames } from "../../shared/events.js";
import type { Clock } from "../clock.js";
import { askJev, type JevLike, type JevNoul } from "../model/JevClient.js";
import type { RaisedItem } from "./raisedHand.js";

/** A `noul` at or above this says the room has already covered the item. */
export const HELD_ANSWERED_THRESHOLD = 0.7;

export interface HeldCheckInput {
  items: readonly RaisedItem[];
  /** The conversation's human final turns, oldest first. */
  turns: readonly TurnUpdate[];
  speakers: SpeakerNames;
}

export interface HeldCheckResult {
  /** Card ids the room has already answered or settled. */
  answered: Set<string>;
  /** Per item, Jev's probability; absent for an item with nothing said since. */
  scores: Record<string, number>;
  latencyMs: number;
  /** No call was made: no turns since any item, or Jev absent or late. */
  skipped?: "nothing_since" | "no_jev" | "no_answer";
}

/** The turns after `sinceTurnId`, or all of them when it is unknown. */
export function turnsSince(turns: readonly TurnUpdate[], sinceTurnId: string | null): TurnUpdate[] {
  if (sinceTurnId === null) return [...turns];
  const index = turns.findIndex((turn) => turn.turnId === sinceTurnId);
  return index < 0 ? [...turns] : turns.slice(index + 1);
}

/** What Jev reads: the held lines, numbered, and everything said since the oldest went up. */
export function renderHeldState(input: HeldCheckInput, since: readonly TurnUpdate[]): string {
  const name = (label: string | null): string => (label === null ? "?" : input.speakers[label] ?? label);
  const held = input.items.map((item, index) => `${index + 1}. ${item.line}`).join("\n");
  const said = since.map((turn) => `${name(turn.speaker)}: ${turn.text.trim()}`).join("\n");
  return (
    "Sotto, an assistant in a meeting, is holding these things it could say:\n" +
    `${held}\n\nWhat the people in the room have said since (oldest first):\n${said === "" ? "(nothing)" : said}`
  );
}

export async function checkHeld(
  jev: JevLike | null,
  input: HeldCheckInput,
  wallClock: Clock,
  signal?: AbortSignal,
): Promise<HeldCheckResult> {
  const started = wallClock.now();
  const done = (partial: Omit<HeldCheckResult, "latencyMs">): HeldCheckResult => ({
    ...partial,
    latencyMs: wallClock.now() - started,
  });
  if (input.items.length === 0) return done({ answered: new Set(), scores: {}, skipped: "nothing_since" });
  // The oldest item's "since" covers every newer one's; an item nothing has
  // been said after cannot have been answered, and asks no question.
  const askable = input.items.filter((item) => turnsSince(input.turns, item.sinceTurnId).length > 0);
  if (askable.length === 0) return done({ answered: new Set(), scores: {}, skipped: "nothing_since" });
  if (jev === null) return done({ answered: new Set(), scores: {}, skipped: "no_jev" });
  const oldest = askable.reduce((a, b) => (a.atMs <= b.atMs ? a : b));
  const since = turnsSince(input.turns, oldest.sinceTurnId);
  const questions: Record<string, JevNoul> = {};
  askable.forEach((item) => {
    const index = input.items.indexOf(item) + 1;
    questions[item.cardId] = {
      type: "noul",
      instructions:
        `Have the people in the room already answered, settled or dealt with item ${index} themselves in what they said since?`,
      criteria: {
        true: `Someone in the room gave the information item ${index} would give, or settled the point it raises, or clearly decided it no longer matters.`,
        false: `Item ${index} is still open: nobody has supplied that information or settled that point.`,
      },
    };
  });
  const reply = await askJev(
    jev,
    { state: renderHeldState({ ...input, items: input.items }, since), questions },
    (fn, ms) => wallClock.setTimeout(fn, ms),
    signal,
  );
  if (reply === null) return done({ answered: new Set(), scores: {}, skipped: "no_answer" });
  const answered = new Set<string>();
  const scores: Record<string, number> = {};
  for (const item of askable) {
    const answer = reply.answers[item.cardId];
    if (answer === undefined || answer.type !== "noul") continue;
    scores[item.cardId] = answer.noul;
    if (answer.noul >= HELD_ANSWERED_THRESHOLD) answered.add(item.cardId);
  }
  return done({ answered, scores });
}
