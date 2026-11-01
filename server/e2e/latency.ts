/**
 * The latencies `npm run e2e` prints (PRD US-021, V2-021).
 *
 * The ones measured here cross between two timelines, which is the whole
 * difficulty. (The two V2-021 added — the acknowledgment and the first audio
 * of a spoken answer — do not: they are real milliseconds, recorded by the
 * voice itself, and {@link voiceLatency} only reads them back.) A
 * turn's `startMs`/`endMs` are positions in the *audio stream*; a card's
 * `createdAtMs` is read off the live `Clock`, whose origin is the process. So
 * nothing can be subtracted until both ends are on the wall clock, which is
 * what {@link E2eObserved} stamps everything with.
 *
 * Turns come with their own stamps, so a card's is a direct subtraction. A
 * *scripted* instant — where the trigger or deadline line ended — is only
 * known on the audio timeline, so it is mapped onto the wall by the lag
 * between the two, measured as the median of `arrival − end` over every final
 * turn the run produced. In a real-time session that lag is near-constant
 * (the API reports a position in the audio and the frame arrives 600–760 ms
 * later, `fixtures/events/NOTES.md`), and a median shrugs off the turn or two
 * where it is not.
 *
 * Pure.
 */
import type { StageCard } from "../../shared/cards.js";
import type {
  E2eFiles,
  E2eLatency,
  E2eObserved,
  MomentLatency,
  SpokenMomentOutcome,
  Stamped,
} from "../../shared/e2e.js";
import type { MomentRecord, SpokenRecord } from "../../shared/eval.js";
import { isUnpromptedSpeech } from "../eval/spoken.js";
import { deliveredForMoment, spokenFrom, type E2eCheckInput } from "./checks.js";

/**
 * How far ahead of the audio timeline the wall clock ran, in ms.
 *
 * `null` when the run produced no final turn with an end — there is nothing
 * to measure the offset against, so nothing scripted can be placed.
 */
export function wallOffsetMs(observed: E2eObserved): number | null {
  const lags = observed.turns
    .filter((stamped) => stamped.value.endMs !== null)
    .map((stamped) => stamped.atMs - (stamped.value.endMs as number))
    .sort((a, b) => a - b);
  if (lags.length === 0) return null;
  return lags[Math.floor(lags.length / 2)] as number;
}

/** An instant on the audio timeline, placed on the wall clock. */
export function onWall(observed: E2eObserved, audioMs: number | null): number | null {
  const offset = wallOffsetMs(observed);
  if (offset === null || audioMs === null) return null;
  return audioMs + offset;
}

/** The first push of an answer card that satisfies `ready`, or `null`. */
function firstAnswerAt(
  cards: readonly Stamped<StageCard>[],
  ready: (card: StageCard) => boolean,
): number | null {
  const found = cards.find((stamped) => stamped.value.variant === "answer" && ready(stamped.value));
  return found?.atMs ?? null;
}

/** `b - a`, or `null` if either end is missing or the order is impossible. */
function gap(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b < a) return null;
  return b - a;
}

/**
 * Wake phrase heard → headline, and → the finished answer.
 *
 * Measured from the moment the indicator went up, which is the first partial
 * that matched (US-017) — i.e. from when the group could see Sotto had heard
 * its name, not from when the question finished being asked.
 */
export function answerLatency(observed: E2eObserved): Pick<
  E2eLatency,
  "wakeToHeadlineMs" | "wakeToDoneMs"
> {
  const wake = observed.wakeAtMs[0] ?? null;
  return {
    wakeToHeadlineMs: gap(
      wake,
      firstAnswerAt(observed.cards, (card) => card.headline.trim() !== ""),
    ),
    wakeToDoneMs: gap(
      wake,
      firstAnswerAt(observed.cards, (card) => card.state === "ready"),
    ),
  };
}

/** One planted moment: trigger line transcribed → its card on the stage. */
export function momentLatency(input: E2eCheckInput, moment: MomentRecord): MomentLatency {
  const card = deliveredForMoment(input, moment);
  if (card === null) {
    return { momentId: moment.id, deliveredAfterMs: null, beforeDeadline: null };
  }
  const delivered = input.observed.cards.find((stamped) => stamped.value.id === card.id)?.atMs;
  const trigger = onWall(input.observed, moment.triggerTurnEndMs);
  const deadline = onWall(input.observed, moment.deadlineTurnEndMs);
  return {
    momentId: moment.id,
    deliveredAfterMs: gap(trigger, delivered ?? null),
    beforeDeadline: delivered === undefined || deadline === null ? null : delivered <= deadline,
  };
}

/**
 * What the room heard, and when (V2-021).
 *
 * Taken off `answers.jsonl` rather than measured here, because these two are
 * already recorded in real milliseconds by the thing that did the speaking:
 * they are latencies a person in the room felt, and the session clock they
 * would otherwise be read off does not move during a model call. The first
 * *spoken* answer is the one reported — a typed question has nothing to say
 * about how quickly Sotto reacted to being addressed.
 */
export function voiceLatency(files: E2eFiles): Pick<E2eLatency, "ackMs" | "firstAudioMs"> {
  const answer = files.answers.find((one) => one.turnId !== null) ?? files.answers[0];
  return {
    ackMs: answer?.ackMs ?? null,
    firstAudioMs: answer?.firstAudioMs ?? null,
  };
}

/**
 * What Sotto said about one planted moment, and when (V3-010).
 *
 * Structural, like {@link momentLatency}: the line about this moment is the
 * one whose question turn is one of the moment's own turns, which is what ties
 * a spoken answer to the thing the room wondered. Both ends are on the
 * transcription stream's timeline — Sotto's transcript row carries stream time
 * and the window came from the turns the scripted lines produced — so nothing
 * is mapped onto the wall here, and the number is directly comparable to the
 * eval's.
 */
export function spokenMomentOutcome(
  moment: MomentRecord,
  spoken: readonly SpokenRecord[],
): SpokenMomentOutcome {
  const cited = new Set([...moment.setupTurnIds, ...moment.triggerTurnIds]);
  const about = spoken.filter(
    (one) => isUnpromptedSpeech(one) && cited.has(one.record.turnId),
  );
  const claim = about.find((one) => one.record.kind === "reserve");
  const said = about.find((one) => one.record.kind !== "reserve");
  const from = moment.triggerTurnEndMs;
  return {
    momentId: moment.id,
    spokenId: said?.id ?? null,
    kind: said?.record.kind ?? null,
    afterTriggerMs: gap(from, said?.atStreamMs ?? null),
    beforeDeadline:
      said?.atStreamMs === undefined || said.atStreamMs === null || moment.deadlineTurnEndMs === null
        ? null
        : said.atStreamMs <= moment.deadlineTurnEndMs,
    reservedAfterMs: gap(from, claim?.atStreamMs ?? null),
  };
}

/**
 * Every latency one fixture's run can be asked for.
 *
 * A `research_hook` moment is left out of the moment latencies: it is caught
 * by a research-ready card and nothing else (V2-002), and a research card
 * cites no turns, so there is nothing structural to match it to a moment by —
 * `npm run eval` has a judge for that, and this check has to come out the same
 * every run. The research card times are reported on their own line instead.
 */
export function fixtureLatency(input: E2eCheckInput): E2eLatency {
  const spoken = spokenFrom(input);
  return {
    ...answerLatency(input.observed),
    ...voiceLatency(input.files),
    moments: input.moments
      // A `research_hook` is caught by a research card or by Sotto saying the
      // answer (V3-010), never by a policy card citing turns, so there is
      // nothing structural here to match it to a moment by. Its times are on
      // the research line and in `spokenMoments`.
      .filter((moment) => moment.type !== "research_hook")
      .map((moment) => momentLatency(input, moment)),
    spokenMoments: input.moments
      .filter((moment) => moment.expectedLevel === "speak")
      .map((moment) => spokenMomentOutcome(moment, spoken)),
  };
}
