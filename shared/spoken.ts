/**
 * Everything Sotto says out loud that was not an answer to a wake question
 * (PRD V3-015, V3-004, V3-008, V3-013, V3-005, V3-017), as it is written down.
 *
 * `server/question/Reservations.ts` is what says these lines; this is the
 * shape of the `spoken_contribution` record it appends to `timing.jsonl`, and
 * it lives in `shared/` because three things read it back and none of them is
 * the thing that wrote it: the eval (V3-010) scores unprompted speech the way
 * it scores cards, `npm run e2e` runs the same scoring against a real clock,
 * and `Steering` (V3-006) counts the times the room talked over one.
 *
 * Two conventions worth stating once, because both are easy to get wrong:
 *
 *   - **`atMs` is the session clock, `startMs` is the stream.** A record's
 *     `atMs` is read off the injected `Clock`, whose origin is the process in
 *     a live session; Sotto's own transcript line (V2-008a) is placed on the
 *     transcription stream's timeline, which is the one the room's turns are
 *     on. So anything comparing a spoken line to the conversation — a pause,
 *     a planted moment's window, a human turn it ran over — reads the
 *     transcript, via {@link spokenTurnId}, and never `atMs`.
 *   - **`called_on` and `ideas` are not unprompted.** The room asked for them
 *     (V3-017, V3-007), so they wait for no gap and spend nothing, and
 *     anything counting speech Sotto chose to make has to leave them out
 *     ({@link isUnpromptedKind}).
 */

import { sottoTurnId } from "./turns.js";

/** The `stage` field every one of these records carries. */
export const SPOKEN_CONTRIBUTION_STAGE = "spoken_contribution";

/**
 * The kinds of unprompted line Sotto says.
 *
 * The first three are the fast path's, about one of the room's own questions
 * (V3-015, V3-004). `correction` is V3-008's one exception: a verified
 * factual error at boldness `bold`. `readback` is V3-013's: the decision the
 * group has just settled, with the group's own unsettled question on it when
 * one fits. `offer` is V3-005's: a finding nobody asked for, mentioned as a
 * statement so that nobody owes it a reply. `called_on` is V3-017's and
 * `ideas` is V3-007's, and those two are the odd ones out — the room asked.
 */
export const spokenContributionKinds = [
  "reserve",
  "no_answer",
  "answer",
  "correction",
  "readback",
  "offer",
  "called_on",
  "ideas",
] as const;
export type SpokenContributionKind = (typeof spokenContributionKinds)[number];

/**
 * Whether this kind of line is Sotto choosing to speak.
 *
 * Everything but `called_on` and `ideas`, which the room asked for: they are
 * held to none of the rules about speaking unasked and must not be counted
 * among the utterances the eval's false-speech gate is about (V3-010),
 * exactly as a research card is kept out of the delivery filters (V2-014).
 * The `offer` that preceded a set of `ideas` (V3-007) is the unprompted half
 * of that exchange, and is counted.
 */
export function isUnpromptedKind(kind: SpokenContributionKind): boolean {
  return kind !== "called_on" && kind !== "ideas";
}

/**
 * Why a line was not said, for `timing.jsonl`.
 *
 * - `boldness`: a `cautious` session, which contributes on screen only.
 * - `cooldown` / `budget`: the frequency setting's, spent on something else.
 * - `no_gap`: nobody stopped talking inside the claim's five-second window.
 * - `frequency`: a bare read-back (V3-013), which only a session set to
 *   contribute `often` says out loud.
 * - `offer_open`: another offer is already waiting or still open (V3-005):
 *   at most one at a time, so this packet is the card alone.
 * - `unheard`: muted, or no page attached to play it.
 * - `moved_on`: the room is somewhere else now.
 * - `answered`: somebody present answered the question and the search agrees.
 * - `disagrees`: somebody present answered it and the search does not agree.
 * - `expired`: the fuse ran out without a pause.
 * - `yielded`: cut off by a voice in the room twice (V3-004).
 * - `overtaken`: the search came back before the claim could be made.
 * - `session_ended`: still waiting for a gap when the conversation stopped.
 */
export const reserveSkipReasons = [
  "boldness",
  "cooldown",
  "budget",
  "no_gap",
  "frequency",
  "offer_open",
  "unheard",
  "moved_on",
  "answered",
  "disagrees",
  "expired",
  "yielded",
  "overtaken",
  /** A retry after a yield, dropped because the room then asked Sotto something else. */
  "superseded",
  "session_ended",
] as const;
export type ReserveSkipReason = (typeof reserveSkipReasons)[number];

/** What the turns since the question say about saying the answer now (V3-004). */
export const stillCurrentVerdicts = ["current", "answered", "moved_on"] as const;
export type StillCurrentVerdict = (typeof stillCurrentVerdicts)[number];

/** The cached answer about one waiting line, read at the pause (V3-004). */
export interface StillCurrentState {
  verdict: StillCurrentVerdict;
  /** Whether a person's own answer agrees; only an `answered` verdict has one. */
  agrees: boolean;
  /** Real milliseconds the call that produced it took; 0 when no call was made. */
  latencyMs: number;
  /** True when the verdict is the default rather than a model's. */
  fallback: boolean;
  /** How many turns the verdict was made over. */
  turns: number;
  /**
   * The newest human final turn the verdict was made over, or `null` when
   * nobody had spoken since the question. Unprompted speech waits for a
   * verdict that covers the latest turn, because a verdict about turns one to
   * three is no judgment about turn four. Absent on records written before
   * this field, and on a test's hand-built verdict: both read as covering.
   */
  coversTurnId?: string | null;
}

/** What a read-back carries beside the decision itself (V3-013). */
export const readBackAttachments = ["group", "own"] as const;
export type ReadBackAttachment = (typeof readBackAttachments)[number];

/** One `spoken_contribution` line of `timing.jsonl` (V3-015). */
export interface SpokenContributionRecord {
  stage: typeof SPOKEN_CONTRIBUTION_STAGE;
  kind: SpokenContributionKind;
  /** When it was said, or when it was given up on, on the session clock. */
  atMs: number;
  /**
   * What is being spoken about: the research idea behind the question, or —
   * for a `correction` (V3-008) — the candidate, which is the only thing that
   * identifies it.
   */
  ideaId: string;
  /**
   * The same id again on a `correction`, under the name a reader expects —
   * and, on a `readback`, the candidate whose question is attached to it
   * (V3-013), or absent when nothing is.
   */
  candidateId?: string;
  /**
   * What a `readback` carries (V3-013): the room's own unsettled question,
   * one of Sotto's own corrections, or `null` for the bare decision.
   */
  attached?: ReadBackAttachment | null;
  /** What was settled, on a `readback`: "six gardens, Saturday". */
  decision?: string;
  /**
   * The card being read out, on a `called_on` (V3-017), the card an `offer`
   * is about (V3-005) or the one a set of `ideas` goes up as (V3-007) —
   * absent when there was nothing raised to read.
   */
  cardId?: string;
  /** The packet an `offer` is offering (V3-005). */
  packetId?: string;
  /** The turn the question was heard in, or the one a correction rests on. */
  turnId: string;
  /** Three to five words naming it; a correction's is its headline. */
  topic: string;
  /**
   * Whether it was said at all: an utterance was opened and the words handed
   * to the voice. What the room got of it is {@link heard}.
   */
  spoken: boolean;
  /** The words, whether or not they were said. */
  text: string;
  /**
   * The question turn going final to the first audio of this line, on the
   * session clock. Only on a claim or a closing line that was really said.
   */
  questionToReserveMs?: number;
  /** The same for an answer (V3-004): wondering aloud to hearing it back. */
  questionToSpeechMs?: number;
  /** How long this line waited for a pause to be said in (V3-004). */
  pauseWaitMs?: number;
  /** The cached verdict the decision to speak was made on (V3-004). */
  stillCurrent?: StillCurrentState;
  /** True when a human voice cut it off (V3-004's rule). */
  yielded?: boolean;
  /** How many times a voice in the room has cut this line off (V3-004). */
  yields?: number;
  /** True when it was the barge-in that cancelled it (V2-007 on top). */
  bargedIn?: boolean;
  /** True on an answer that was cut off and will be tried again (V3-004). */
  retrying?: boolean;
  /**
   * The group's own file a `correction` came out of (V3-009), when one did.
   *
   * Recorded rather than derived because it is the one thing that tells the
   * two kinds of correction apart after the fact: a file-backed one is the
   * only correction Sotto says at the default boldness, so the shadow report
   * and the live checkpoint count it separately from a web-verified one.
   */
  fromFile?: string;
  /** What the room actually heard, when that is less than {@link text}. */
  heard?: string;
  /** Why nothing was said, when nothing was. */
  reason?: ReserveSkipReason;
}

/**
 * The utterance id a spoken line's transcript row is derived from (V2-008a).
 *
 * `attempt` numbers a retry after a yield (V3-004), so the first attempt's row
 * — what the room heard of it — is not replaced by the second's.
 */
export function spokenUtteranceId(
  kind: SpokenContributionKind,
  ideaId: string,
  attempt = 0,
): string {
  return attempt === 0 ? `${kind}-${ideaId}` : `${kind}-${ideaId}-${attempt + 1}`;
}

/**
 * One `spoken_contribution` line out of the untyped `timing.jsonl`, or `null`.
 *
 * The log is written as `unknown` by `SessionStore.appendTiming`, so this is
 * the one place that narrows it: a record whose `kind` is not one of
 * {@link spokenContributionKinds} is from a future version of the pipeline and
 * is dropped rather than guessed at — the same rule `TurnAssembler` follows
 * for an ASR frame that fails its shape.
 */
export function asSpokenContribution(line: unknown): SpokenContributionRecord | null {
  if (typeof line !== "object" || line === null) return null;
  const record = line as Partial<SpokenContributionRecord>;
  if (record.stage !== SPOKEN_CONTRIBUTION_STAGE) return null;
  if (
    record.kind === undefined ||
    !(spokenContributionKinds as readonly string[]).includes(record.kind)
  ) {
    return null;
  }
  if (typeof record.atMs !== "number" || typeof record.text !== "string") return null;
  if (typeof record.spoken !== "boolean") return null;
  return record as SpokenContributionRecord;
}

/**
 * How fast Sotto's voice reads, in characters a second.
 *
 * Measured, not guessed: `npm run hello:measure` renders
 * `server/prompts/hello.md` through the real ElevenLabs endpoint in Sotto's
 * own voice with its real `voice_settings`, and the shipped hello is 361
 * characters of 21.5 seconds in Matilda at speed 1.1 — 16.8 characters a
 * second, 74 words at 3.44 words a second. (River read the same text at
 * 19.6; the voice changed on 2026-11-02.)
 */
export const SPOKEN_CHARS_PER_SECOND = 16.8;

/**
 * Roughly how long a line takes to say, in milliseconds.
 *
 * An estimate, and the only one available: Sotto's transcript row carries the
 * instant playback *started* and nothing records where it stopped (`endMs` is
 * the same instant, V2-008a). It exists so that "Sotto carried on over
 * somebody" can be measured off the transcript at all (V3-010), so it is
 * deliberately the rate of the one utterance that has been timed end to end
 * rather than a conservative bound.
 */
export function estimateSpokenMs(text: string): number {
  return Math.round((text.trim().length / SPOKEN_CHARS_PER_SECOND) * 1000);
}

/**
 * The transcript row Sotto's own line was written as (V2-008a), by turn id.
 *
 * Derived rather than recorded, which is what makes a spoken line placeable on
 * the conversation's own timeline at all: `atMs` is the session clock and a
 * live session's counts from the start of the process, while the row carries
 * stream time. The attempt number is recovered the way it was written — a
 * retry after a yield is its own row (V3-004), and {@link
 * SpokenContributionRecord.yields} counts the yield that has just happened.
 */
export function spokenTurnId(record: SpokenContributionRecord): string {
  const attempt = Math.max(0, (record.yields ?? 0) - (record.yielded === true ? 1 : 0));
  return sottoTurnId(spokenUtteranceId(record.kind, record.ideaId, attempt));
}

/**
 * The last defence against the voice reading punctuation out loud. The
 * prompts ask for prose with no symbols; this catches what still gets
 * through — ElevenLabs says "tilde" for `~`, "slash" for `/` and "Saint" for
 * `St.` (a live run, 2026-11-03). Only the unambiguous ones: a dollar sign in
 * front of a number, a tilde or an approx sign before one, a slash or a range
 * dash between words or numbers, and the few abbreviations an address holds.
 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/[~≈]\s*(?=\$?\d)/gu, "about ")
    .replace(/\$(\d(?:[\d,]*\d)?(?:\.\d+)?)(?:\s*(million|billion|k)\b)?/giu, (_, n: string, scale?: string) =>
      `${n} ${scale === undefined ? "dollars" : scale === "k" ? "thousand dollars" : `${scale} dollars`}`)
    .replace(/(\d)\s*[–—-]\s*(?=\d)/gu, "$1 to ")
    .replace(/(\w)\s*\/\s*(?=\w)/gu, "$1 or ")
    .replace(/\b(\d+)\s*(?:a\.?m\.?)\b/giu, "$1 a m")
    .replace(/\b(\d+)\s*(?:p\.?m\.?)\b/giu, "$1 p m")
    .replace(/\b([A-Z][a-z]+)\s+St\.?(?=[\s,.;:!?]|$)/gu, "$1 Street")
    .replace(/\bSt\.(?=\s+[A-Z])/gu, "Saint")
    .replace(/\b([A-Z][a-z]+)\s+Ave\.?(?=[\s,.;:!?]|$)/gu, "$1 Avenue")
    .replace(/\b([A-Z][a-z]+)\s+Rd\.?(?=[\s,.;:!?]|$)/gu, "$1 Road")
    .replace(/\b([A-Z][a-z]+)\s+Blvd\.?(?=[\s,.;:!?]|$)/gu, "$1 Boulevard")
    .replace(/[*_`#>|]+/gu, "")
    .replace(/\s{2,}/gu, " ");
}
