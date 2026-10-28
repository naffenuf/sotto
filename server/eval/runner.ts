/**
 * One fixture, replayed through the whole engine and written down (PRD
 * US-016).
 *
 * Nothing here is a special eval pipeline: it starts a perfectly ordinary
 * session — `EventReplaySource` at `max` into the turn assembler, the board,
 * the observer, the verifier, the policy — and watches the same event bus the
 * browser watches. What makes it an evaluation is only what it collects:
 * every card that reached the stage, when it did, and whether the
 * conversation was quiet at that moment.
 *
 * `max` is what makes it affordable. Simulated time skips the silences but
 * stops dead at every `clock.track`ed model call, so a two-minute
 * conversation costs the handful of calls it would really have made and about
 * as long as those calls take.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StageCard } from "../../shared/cards.js";
import type {
  CandidateLogLine,
  DecisionLogRecord,
} from "../../shared/candidates.js";
import type { DeliveryRecord, FixtureRunRecord, JudgeMatchRecord } from "../../shared/eval.js";
import type { Chattiness, DeliveredLevel } from "../../shared/policy.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { EventBus } from "../events/bus.js";
import { CARD_ID_PREFIX } from "../interject/delivery.js";
import { inPause } from "../interject/policy.js";
import type { ModelClientFactory } from "../session/SessionManager.js";
import { SessionManager } from "../session/SessionManager.js";
import { SESSION_FILES, SessionStore } from "../session/SessionStore.js";
import { loadScript, resolveMoments } from "./moments.js";
import { pauseAt, turnIntervals } from "./pause.js";
import type { Judge } from "./judge.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

export interface ReplayOptions {
  fixture: string;
  chattiness: Chattiness;
  /** Where the session folders go. One per replay, as any session has. */
  sessionRoot: string;
  /** Meta Model API key. Without one the session transcribes and notices nothing. */
  apiKey?: string | undefined;
  /** Seam for tests: `() => null` replays with no model and makes no calls. */
  createModel?: ModelClientFactory;
  logger?: Logger;
}

/** What one replay produced, before any judging. */
export interface ReplayResult {
  turns: TurnUpdate[];
  cards: StageCard[];
  sessionDir: string | null;
  /** The conversation's length on the session clock. */
  durationMs: number;
  candidates: number;
  decisions: number;
  /** The policy's own decision, by candidate id, for the ones it delivered. */
  delivered: Map<string, DecisionLogRecord>;
}

/**
 * Replays `fixture` at `max` and waits for the session to end.
 *
 * The session is never stopped from outside: a replay ends when the capture
 * runs out, which is what gives the loops their drain — and the policy the
 * trailing silence a conversation really ends in.
 */
export async function replayFixture(options: ReplayOptions): Promise<ReplayResult> {
  const logger = options.logger ?? console;
  const bus = new EventBus(logger);
  let sessionDir: string | null = null;
  const sessions = new SessionManager({
    bus,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.createModel === undefined ? {} : { createModel: options.createModel }),
    logger,
    replaySpeed: "max",
    chattiness: options.chattiness,
    createStore: (info) => {
      const store = SessionStore.create(info, { root: options.sessionRoot, logger });
      sessionDir = store.dir;
      return store;
    },
  });

  const turns: TurnUpdate[] = [];
  const cards: StageCard[] = [];
  const ended = new Promise<void>((resolve) => {
    const off = bus.subscribe((event) => {
      if (event.type === "turn") turns.push(event.turn);
      // A card with an id already on the stage replaces it: an interjection
      // is delivered once, but the rule is the stage's, so follow it here too.
      if (event.type === "card") {
        const index = cards.findIndex((card) => card.id === event.card.id);
        if (index >= 0) cards[index] = event.card;
        else cards.push(event.card);
      }
      if (event.type === "session" && event.session === null) {
        off();
        resolve();
      }
    });
  });
  sessions.start({ kind: "events", fixture: options.fixture });
  await ended;

  const log = readCandidateLog(sessionDir);
  return {
    turns,
    cards,
    sessionDir,
    durationMs: Math.max(0, ...turns.map((turn) => turn.endMs ?? turn.startMs)),
    candidates: log.filter((line) => line.kind === "candidate").length,
    decisions: log.filter((line) => line.kind === "decision").length,
    delivered: deliveredDecisions(log),
  };
}

export interface RunFixtureOptions extends ReplayOptions {
  /** Judges each delivered card against each planted moment. */
  judge?: Judge | undefined;
}

/** One fixture: replayed, placed in time, and judged against its moments. */
export async function runFixture(options: RunFixtureOptions): Promise<FixtureRunRecord> {
  const logger = options.logger ?? console;
  const startedAt = Date.now();
  const base = {
    fixture: options.fixture,
    chattiness: options.chattiness,
    sessionDir: null,
    durationMs: 0,
    finalTurns: 0,
    candidates: 0,
    decisions: 0,
    deliveries: [],
    moments: [],
    matches: [],
  } satisfies Omit<FixtureRunRecord, "elapsedMs">;

  let replay: ReplayResult;
  try {
    replay = await replayFixture(options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`[eval] ${options.fixture} failed: ${detail}`);
    return { ...base, elapsedMs: Date.now() - startedAt, error: detail };
  }

  const finals = replay.turns.filter((turn) => turn.final);
  const deliveries = deliveriesFrom(replay);
  const moments = resolveMoments(options.fixture, finals);
  const matches = await judgeAll(options, deliveries, moments.length > 0);

  return {
    fixture: options.fixture,
    chattiness: options.chattiness,
    sessionDir: replay.sessionDir,
    durationMs: replay.durationMs,
    finalTurns: finals.length,
    candidates: replay.candidates,
    decisions: replay.decisions,
    deliveries,
    moments,
    matches,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Every (card, moment) pair, judged. Nothing to judge when either is empty. */
async function judgeAll(
  options: RunFixtureOptions,
  deliveries: readonly DeliveryRecord[],
  hasMoments: boolean,
): Promise<JudgeMatchRecord[]> {
  const judge = options.judge;
  if (judge === undefined || !hasMoments || deliveries.length === 0) return [];
  const script = loadScript(options.fixture);
  const matches: JudgeMatchRecord[] = [];
  for (const delivery of deliveries) {
    for (const moment of script.moments) {
      matches.push(
        await judge.judge({ fixture: options.fixture, moment, script, delivery }),
      );
    }
  }
  return matches;
}

/** The cards a replay delivered, with the moment each went out in. */
export function deliveriesFrom(replay: ReplayResult): DeliveryRecord[] {
  const intervals = turnIntervals(replay.turns);
  const deliveries: DeliveryRecord[] = [];
  for (const card of replay.cards) {
    const level = deliveredLevel(card.variant);
    // An `answer` card (US-018) is on the same stage and is not a delivery.
    if (level === null) continue;
    const candidateId = card.id.startsWith(CARD_ID_PREFIX)
      ? card.id.slice(CARD_ID_PREFIX.length)
      : card.id;
    const decision = replay.delivered.get(candidateId);
    const pause = pauseAt(intervals, card.createdAtMs);
    deliveries.push({
      cardId: card.id,
      candidateId,
      // From the decision log, so it is what the policy acted on; `null` only
      // when the session folder could not be read back.
      type: decision?.type ?? null,
      level,
      headline: card.headline,
      detail: card.detailMd ?? "",
      whyNow: card.whyNow ?? "",
      deliveredAtMs: card.createdAtMs,
      // The policy's own definition of a pause, applied to the conversation
      // rather than taken on trust.
      inPause: inPause(pause),
      pause,
      reason: decision?.reason ?? null,
      score: decision?.score ?? null,
    });
  }
  return deliveries;
}

/** The level a card's variant means, or `null` if it is not an interjection. */
function deliveredLevel(variant: StageCard["variant"]): DeliveredLevel | null {
  return variant === "interject" || variant === "glow" ? variant : null;
}

/** `candidates.jsonl`, parsed. An unreadable or absent log is an empty one. */
export function readCandidateLog(sessionDir: string | null): CandidateLogLine[] {
  if (sessionDir === null) return [];
  let text: string;
  try {
    text = readFileSync(join(sessionDir, SESSION_FILES.candidates), "utf8");
  } catch {
    // A conversation where the observer found nothing never opens the file.
    return [];
  }
  const lines: CandidateLogLine[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      lines.push(JSON.parse(line) as CandidateLogLine);
    } catch {
      // A half-written last line is the only way this happens.
    }
  }
  return lines;
}

/**
 * The decision that put each delivered candidate on the stage, by candidate
 * id. A candidate is decided several times — `hold`, then what became of it —
 * so the delivering one is the one that names a level.
 */
export function deliveredDecisions(log: readonly CandidateLogLine[]): Map<string, DecisionLogRecord> {
  const delivered = new Map<string, DecisionLogRecord>();
  for (const line of log) {
    if (line.kind !== "decision") continue;
    if (line.decision !== "glow" && line.decision !== "interject") continue;
    delivered.set(line.candidateId, line);
  }
  return delivered;
}
