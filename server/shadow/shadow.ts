/**
 * The shadow run: a real meeting, replayed through the v3 pipeline so the
 * team can read what Sotto *would* have said before anybody hears it say
 * anything (PRD V3-016).
 *
 * Nothing here is a second pipeline, for the same reason the eval harness is
 * not: a past `mic` session's `events.jsonl` holds the frames the realtime
 * API really sent, in the same format as a fixture capture, so this starts an
 * ordinary `{ kind: "events" }` session with {@link EventReplaySource.forPath}
 * pointed at that folder and watches the same event bus a browser watches.
 * {@link replayFixture} does the replaying; what makes it a shadow run is only
 * what it collects and how it is written down.
 *
 * Two things follow from the source being a replay. The hello is suppressed
 * for free — {@link SessionManager} only builds a {@link Greeting} for a live
 * `mic` or `wav` session — and Sotto's voice goes to a sink, so the decisions
 * are real and nothing is heard.
 *
 * What a reader is being asked is "would this have been welcome?", so the
 * report leads with every unprompted line, said or not, with the turn that
 * triggered it quoted. The classifier's verdicts come next, because a question
 * Sotto *missed* is as interesting as one it answered and is invisible
 * otherwise, and the policy's silent decisions come last.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { SuppressedCandidate } from "../../shared/candidates.js";
import type { StageCard } from "../../shared/cards.js";
import type { PolicySettings } from "../../shared/policy.js";
import type { GateMode } from "../../shared/candidates.js";
import type { SessionRecord } from "../../shared/session.js";
import {
  isUnpromptedKind,
  type SpokenContributionRecord,
} from "../../shared/spoken.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { EventReplaySource } from "../asr/EventReplaySource.js";
import { readCandidateLog, replayFixture, type ReplayResult } from "../eval/runner.js";
import { inPause } from "../interject/policy.js";
import { turnIntervals, pauseAt } from "../eval/pause.js";
import type {
  GlimmerClientFactory,
  ModelClientFactory,
  VoiceFactory,
} from "../session/SessionManager.js";
import { SessionDigest } from "../session/digest.js";
import { SESSION_FILES } from "../session/SessionStore.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

/** The one source kind a shadow run is about: a conversation that happened. */
export const SHADOW_SOURCE = "mic";

export interface ShadowOptions {
  /** Folder name under {@link ShadowOptions.sessionsRoot}. */
  session: string;
  /** Where past sessions live, normally `sessions/`. */
  sessionsRoot: string;
  /** Where this run's own session folder goes. */
  sessionRoot: string;
  /** Meta Model API key: the replay makes the calls the conversation would have. */
  apiKey: string;
  createModel: ModelClientFactory;
  createGlimmer?: GlimmerClientFactory;
  /**
   * Sotto's voice. `scripts/shadow.ts` passes V2-021's `nullSinkVoice`: the
   * real ElevenLabs socket with the audio discarded, so the lines are really
   * synthesized and nothing comes out of a speaker.
   */
  createVoice?: VoiceFactory;
  /** How often and how boldly, as the header would have been set (V2-017). */
  settings: PolicySettings;
  /** Which model gates interjection candidates (V3-001). */
  gate?: GateMode;
  logger?: Logger;
}

/** One turn as the report quotes it. */
export interface ShadowTurn {
  turnId: string;
  /** The display name if the session had one, else the diarization label. */
  speaker: string;
  text: string;
  startMs: number;
  endMs: number | null;
}

/** One unprompted line Sotto said, or decided against saying. */
export interface ShadowSpoken {
  record: SpokenContributionRecord;
  /** The turn that triggered it: the question, or the claim a correction rests on. */
  trigger: ShadowTurn | null;
  /**
   * The trigger turn's end to this line, on the session clock — which for a
   * replay is the conversation's own timeline. `null` when the trigger turn is
   * not in the transcript (a candidate's turn can predate the window kept).
   */
  sinceTriggerMs: number | null;
  /** Whether the conversation was really quiet when it went out. */
  inPause: boolean;
}

/** One verdict from the V3-002 classifier, whatever it came out as. */
export interface ShadowQuestion {
  turnId: string;
  /** `open_question`, `rhetorical`, `to_group`, `decision`, `answered`, `none`. */
  kind: string;
  atMs: number;
  latencyMs: number;
  /** True when the call did not come back and the verdict is the default. */
  fallback: boolean;
  /** V3-013: the same call's other answer — the group settled something. */
  closing?: boolean;
  decision?: string;
  turn: ShadowTurn | null;
}

/** One card that reached the stage: a contribution on screen rather than aloud. */
export interface ShadowCard {
  id: string;
  variant: string;
  headline: string;
  createdAtMs: number;
  /** True while Sotto is holding it and has not said it (V3-008, V3-017). */
  raised: boolean;
}

/** Everything one shadow run produced. */
export interface ShadowRunRecord {
  /** The folder that was replayed. */
  session: string;
  /** What `session.json` said the original source was. */
  source: string | null;
  /** When the original conversation was recorded. */
  recordedAt: string | null;
  runAt: string;
  gitCommit: string | null;
  settings: PolicySettings;
  gate: GateMode | null;
  /** Which voice the run spoke through, for a reader judging the latencies. */
  voice: string;
  /** This run's own session folder, which holds the logs these numbers came off. */
  sessionDir: string | null;
  /** The conversation's length on the session clock. */
  durationMs: number;
  finalTurns: number;
  /** How long the replay itself took, in real milliseconds. */
  elapsedMs: number;
  spoken: ShadowSpoken[];
  questions: ShadowQuestion[];
  /** Turns the classifier was never asked about because the room addressed Sotto. */
  addressedTurns: number;
  cards: ShadowCard[];
  suppressed: SuppressedCandidate[];
  error?: string;
}

/**
 * Replays one past session and returns what Sotto would have contributed.
 *
 * A replay that cannot start — no such folder, no frames in it — comes back as
 * a record carrying `error` rather than throwing, so the caller reports it the
 * same way it reports a run that produced nothing. `scripts/shadow.ts` checks
 * the folder is a {@link SHADOW_SOURCE} session before getting here, because
 * that is a mistake in the argument rather than a result.
 */
export async function runShadow(options: ShadowOptions): Promise<ShadowRunRecord> {
  const logger = options.logger ?? console;
  const dir = join(options.sessionsRoot, options.session);
  const record = readSessionRecord(dir);
  const eventsPath = join(dir, SESSION_FILES.events);
  const startedAt = Date.now();

  const base: Omit<ShadowRunRecord, "elapsedMs"> = {
    session: options.session,
    source: record?.source.kind ?? null,
    recordedAt: record?.startedAt ?? null,
    runAt: new Date(startedAt).toISOString(),
    gitCommit: null,
    settings: options.settings,
    gate: options.gate ?? null,
    voice: options.createVoice === undefined ? "none" : "null sink",
    sessionDir: null,
    durationMs: 0,
    finalTurns: 0,
    spoken: [],
    questions: [],
    addressedTurns: 0,
    cards: [],
    suppressed: [],
  };

  let replay: ReplayResult;
  try {
    replay = await replayFixture({
      // The source's name in this run's own folder and in the status line:
      // the conversation being shadowed, not a fixture.
      fixture: options.session,
      settings: options.settings,
      ...(options.gate === undefined ? {} : { gate: options.gate }),
      sessionRoot: options.sessionRoot,
      apiKey: options.apiKey,
      createModel: options.createModel,
      ...(options.createGlimmer === undefined ? {} : { createGlimmer: options.createGlimmer }),
      ...(options.createVoice === undefined ? {} : { createVoice: options.createVoice }),
      createReplaySource: (_fixture, replayOptions) =>
        EventReplaySource.forPath(eventsPath, replayOptions),
      logger,
    });
  } catch (error) {
    return {
      ...base,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const finals = replay.turns.filter((turn) => turn.final);
  const timing = readTimingLog(replay.sessionDir);
  // Diarization labels are named two ways and both belong to the replay's own
  // folder: whoever introduced themselves during it (V2-012) and whatever the
  // original conversation was told. Nobody is at a keyboard during a shadow
  // run, so this is as close to names as the report gets.
  const names = speakerNames(readSessionRecord(replay.sessionDir ?? ""), record);
  return {
    ...base,
    sessionDir: replay.sessionDir,
    durationMs: replay.durationMs,
    finalTurns: finals.length,
    elapsedMs: Date.now() - startedAt,
    spoken: spokenFrom(replay, names),
    questions: questionsFrom(timing, finals, names),
    addressedTurns: timing.filter((line) => line["stage"] === "question_skipped").length,
    cards: cardsFrom(replay.cards),
    suppressed: suppressedFrom(replay.sessionDir),
  };
}

/**
 * Every unprompted line, with the turn that set it off.
 *
 * `called_on` is left out: the room asked for it, so it is not Sotto choosing
 * to speak and is not what a reader is being asked to judge (V3-017).
 */
export function spokenFrom(
  replay: ReplayResult,
  names: Readonly<Record<string, string>> = {},
): ShadowSpoken[] {
  const finals = replay.turns.filter((turn) => turn.final);
  const intervals = turnIntervals(replay.turns);
  return replay.spokenLog
    .filter((one) => isUnpromptedKind(one.kind))
    .map((one): ShadowSpoken => {
      const turn = finals.find((candidate) => candidate.turnId === one.turnId);
      const trigger = turn === undefined ? null : asShadowTurn(turn, names);
      const from = one.questionToSpeechMs ?? one.questionToReserveMs;
      const end = trigger?.endMs ?? null;
      return {
        record: one,
        trigger,
        sinceTriggerMs: from ?? (end === null ? null : Math.round(one.atMs - end)),
        // The policy's own definition, measured against the conversation
        // rather than taken on trust — exactly as a delivery's is.
        inPause: inPause(pauseAt(intervals, one.atMs)),
      };
    });
}

/** Every question verdict, so a missed one is as visible as an answered one. */
export function questionsFrom(
  timing: readonly Record<string, unknown>[],
  finals: readonly TurnUpdate[],
  names: Readonly<Record<string, string>> = {},
): ShadowQuestion[] {
  const questions: ShadowQuestion[] = [];
  for (const line of timing) {
    if (line["stage"] !== "question") continue;
    const turnId = String(line["turnId"] ?? "");
    const turn = finals.find((candidate) => candidate.turnId === turnId);
    questions.push({
      turnId,
      kind: String(line["kind"] ?? "none"),
      atMs: Number(line["atMs"] ?? 0),
      latencyMs: Number(line["latencyMs"] ?? 0),
      fallback: line["fallback"] === true,
      ...(line["closing"] === true
        ? { closing: true, decision: String(line["decision"] ?? "") }
        : {}),
      turn: turn === undefined ? null : asShadowTurn(turn, names),
    });
  }
  return questions;
}

/** The cards that reached the stage, in the order they went up. */
export function cardsFrom(cards: readonly StageCard[]): ShadowCard[] {
  return cards.map((card) => ({
    id: card.id,
    variant: card.variant,
    headline: card.headline,
    createdAtMs: card.createdAtMs,
    raised: card.raised === true,
  }));
}

/**
 * What the policy held back, off `candidates.jsonl`.
 *
 * Through a {@link SessionDigest} rather than by reading the decisions
 * directly, so the report's last section and `digest.md`'s "What Sotto almost
 * said" are the same list computed by the same code — which is also what the
 * stage's tray shows (V3-016).
 */
export function suppressedFrom(sessionDir: string | null): SuppressedCandidate[] {
  const digest = new SessionDigest();
  for (const line of readCandidateLog(sessionDir)) digest.candidate(line);
  return digest.almostSaid();
}

function asShadowTurn(turn: TurnUpdate, names: Readonly<Record<string, string>>): ShadowTurn {
  const label = turn.speaker;
  return {
    turnId: turn.turnId,
    speaker: (label === null ? undefined : names[label]) ?? label ?? "?",
    text: turn.text.trim(),
    startMs: turn.startMs,
    endMs: turn.endMs,
  };
}

/**
 * Display names for the diarization labels: the replay's own first, then the
 * original conversation's. A label nobody named keeps its letter.
 */
function speakerNames(
  ...records: readonly (SessionRecord | null)[]
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const record of records) {
    for (const [label, speaker] of Object.entries(record?.speakers ?? {})) {
      if (names[label] === undefined && speaker.name !== null) names[label] = speaker.name;
    }
  }
  return names;
}

/** `session.json` of the folder being replayed, or `null` if it has none. */
function readSessionRecord(dir: string): SessionRecord | null {
  try {
    return JSON.parse(readFileSync(join(dir, SESSION_FILES.session), "utf8")) as SessionRecord;
  } catch {
    return null;
  }
}

/** `timing.jsonl`, parsed. Written as `unknown`, so it is read as `unknown`. */
function readTimingLog(sessionDir: string | null): Record<string, unknown>[] {
  if (sessionDir === null) return [];
  let text: string;
  try {
    text = readFileSync(join(sessionDir, SESSION_FILES.timing), "utf8");
  } catch {
    return [];
  }
  const lines: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) {
        lines.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Only a half-written last line gets here.
    }
  }
  return lines;
}
