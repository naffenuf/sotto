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
  GateMode,
} from "../../shared/candidates.js";
import type {
  DeliveryRecord,
  FixtureRunRecord,
  GateCallRecord,
  JudgeMatchRecord,
  MomentRecord,
  ResearchDeliveryRecord,
  ResearchRunRecord,
} from "../../shared/eval.js";
import type { DeliveredLevel, PolicySettings } from "../../shared/policy.js";
import {
  researchCardHeadline,
  researchCardId,
  type ResearchLogLine,
  type ResearchPacketRecord,
} from "../../shared/research.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { EventBus } from "../events/bus.js";
import { CARD_ID_PREFIX } from "../interject/delivery.js";
import { candidateScore, inPause } from "../interject/policy.js";
import type { GlimmerClientFactory, ModelClientFactory } from "../session/SessionManager.js";
import { SessionManager } from "../session/SessionManager.js";
import { SESSION_FILES, SessionStore } from "../session/SessionStore.js";
import { loadScript, resolveMoments } from "./moments.js";
import { pauseAt, turnIntervals } from "./pause.js";
import type { Judge, JudgeCard } from "./judge.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

export interface ReplayOptions {
  fixture: string;
  /** How often and how boldly to run it (V2-017). */
  settings: PolicySettings;
  /** Who scores the candidates (V2-016). Defaults to the shipped gate. */
  gate?: GateMode;
  /** Where the session folders go. One per replay, as any session has. */
  sessionRoot: string;
  /** Meta Model API key. Without one the session transcribes and notices nothing. */
  apiKey?: string | undefined;
  /** Seam for tests: `() => null` replays with no model and makes no calls. */
  createModel?: ModelClientFactory;
  /**
   * The local judgment model (V2-016). Defaults to none — so `npm test` never
   * dials the local server, exactly as a `SessionManager` built without one
   * does — which means `--gate glimmer` only really runs on Glimmer when
   * `scripts/eval.ts` passes {@link glimmerFromEnv} in.
   */
  createGlimmer?: GlimmerClientFactory;
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
  /** Every gate call the replay made, in the order they came back (V2-016). */
  gateCalls: GateCallRecord[];
  /** `research.jsonl`, parsed: the ideas, the verdicts, the packets, the cards. */
  researchLog: ResearchLogLine[];
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
    ...(options.createGlimmer === undefined ? {} : { createGlimmer: options.createGlimmer }),
    logger,
    replaySpeed: "max",
    settings: options.settings,
    ...(options.gate === undefined ? {} : { gate: options.gate }),
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
      // V2-008a: Sotto's own lines are in the transcript, not the conversation
      // a moment was planted in; scoring and the pause reconstruction read
      // only what the room said.
      if (event.type === "turn" && !isSottoTurn(event.turn)) turns.push(event.turn);
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
    gateCalls: gateCallsFrom(log),
    researchLog: readResearchLog(sessionDir),
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
    settings: options.settings,
    sessionDir: null,
    durationMs: 0,
    finalTurns: 0,
    candidates: 0,
    decisions: 0,
    gateCalls: [],
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
  const research = researchFrom(replay);
  const moments = resolveMoments(options.fixture, finals);
  const matches = await judgeAll(options, deliveries, research.cards, moments);

  return {
    fixture: options.fixture,
    settings: options.settings,
    sessionDir: replay.sessionDir,
    durationMs: replay.durationMs,
    finalTurns: finals.length,
    candidates: replay.candidates,
    decisions: replay.decisions,
    gateCalls: replay.gateCalls,
    deliveries,
    research,
    moments,
    matches,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Every (card, moment) pair worth judging. Nothing when either side is empty.
 *
 * The two halves of the stage are judged against the two kinds of moment they
 * can catch, and no further (V2-019): a `research_hook` is caught by a
 * research-ready card and nothing else — that is what `expectedLevel:
 * "research"` *means* in the schema — and a contradiction or an unanswered
 * question is caught by the policy. Crossing them over would cost a judge
 * call per pair for a verdict the scoring could never use.
 */
async function judgeAll(
  options: RunFixtureOptions,
  deliveries: readonly DeliveryRecord[],
  researchCards: readonly ResearchDeliveryRecord[],
  moments: readonly MomentRecord[],
): Promise<JudgeMatchRecord[]> {
  const judge = options.judge;
  if (judge === undefined || moments.length === 0) return [];
  if (deliveries.length === 0 && researchCards.length === 0) return [];
  const script = loadScript(options.fixture);
  const matches: JudgeMatchRecord[] = [];
  for (const moment of script.moments) {
    const cards =
      moment.expectedLevel === "research"
        ? researchCards.map(asJudgeCard)
        : deliveries;
    for (const delivery of cards) {
      matches.push(
        await judge.judge({ fixture: options.fixture, moment, script, delivery }),
      );
    }
  }
  return matches;
}

/**
 * One research card as the judge reads it.
 *
 * The same three fields an interjection offers — what it said, what it said
 * about it, and why now — so the judge prompt needs no second shape. "Why
 * now" is the question the search was answering, which is the nearest thing a
 * packet has to a reason for existing.
 */
export function asJudgeCard(card: ResearchDeliveryRecord): JudgeCard {
  return {
    cardId: card.cardId,
    headline: researchCardHeadline(card.title),
    detail: [card.teaser, card.detail].filter((part) => part.trim() !== "").join("\n\n"),
    whyNow: card.question,
  };
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
  return readJsonlLog<CandidateLogLine>(sessionDir, SESSION_FILES.candidates);
}

/** `research.jsonl`, parsed (V2-019). Empty for a session that searched nothing. */
export function readResearchLog(sessionDir: string | null): ResearchLogLine[] {
  return readJsonlLog<ResearchLogLine>(sessionDir, SESSION_FILES.research);
}

/**
 * One of the session folder's `.jsonl` logs, parsed.
 *
 * A missing file is the normal case rather than an error: `SessionStore` only
 * opens a log on its first append, so a conversation where the observer found
 * nothing has no `candidates.jsonl` and one where nothing was worth looking
 * up has no `research.jsonl`.
 */
function readJsonlLog<T>(sessionDir: string | null, file: string): T[] {
  if (sessionDir === null) return [];
  let text: string;
  try {
    text = readFileSync(join(sessionDir, file), "utf8");
  } catch {
    return [];
  }
  const lines: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      lines.push(JSON.parse(line) as T);
    } catch {
      // A half-written last line is the only way this happens.
    }
  }
  return lines;
}

/**
 * What the research pipeline did in this replay (V2-019), off its own log.
 *
 * The counts are decisions rather than cards: an `unsourced` packet never
 * becomes one (V2-013) and a `rejected` idea never becomes a packet, and both
 * are numbers the report is asked for. The cards are taken from the log for
 * the one reason the stage cannot be trusted here — a packet brought forward
 * because somebody asked for it (V2-015) writes a second `card` line and
 * *replaces* its own stage card, so the stage remembers only the later time,
 * while the moment it may have caught is about the first.
 */
export function researchFrom(replay: ReplayResult): ResearchRunRecord {
  const intervals = turnIntervals(replay.turns);
  const packets = new Map<string, ResearchPacketRecord>();
  for (const line of replay.researchLog) {
    if (line.kind === "packet") packets.set(line.ideaId, line);
  }
  const counted = (predicate: (line: ResearchLogLine) => boolean): number =>
    replay.researchLog.filter(predicate).length;
  const cards: ResearchDeliveryRecord[] = [];
  const seen = new Set<string>();
  for (const line of replay.researchLog) {
    if (line.kind !== "card" || seen.has(line.packetId)) continue;
    seen.add(line.packetId);
    const packet = packets.get(line.ideaId);
    const pause = pauseAt(intervals, line.atMs);
    cards.push({
      cardId: researchCardId(line.packetId),
      packetId: line.packetId,
      ideaId: line.ideaId,
      title: line.title,
      question: packet?.question ?? "",
      teaser: packet?.packet?.teaser ?? "",
      detail: (packet?.packet?.keyPoints ?? []).map((point) => `- ${point}`).join("\n"),
      sources: packet?.packet?.sources.length ?? 0,
      deliveredAtMs: line.atMs,
      // The policy's own definition of a pause, measured against the
      // conversation rather than taken on trust — exactly as a delivery's is.
      inPause: inPause(pause),
      pause,
      atSessionEnd: line.atSessionEnd === true,
    });
  }
  return {
    ideas: counted((line) => line.kind === "idea"),
    queued: counted((line) => line.kind === "gate" && line.decision === "queued"),
    rejected: counted((line) => line.kind === "gate" && line.decision === "rejected"),
    gateFailed: counted((line) => line.kind === "gate" && line.decision === "failed"),
    localGateCalls: counted((line) => line.kind === "gate" && line.where === "local"),
    packets: counted((line) => line.kind === "packet" && line.outcome === "ready"),
    unsourced: counted((line) => line.kind === "packet" && line.outcome === "unsourced"),
    failed: counted((line) => line.kind === "packet" && line.outcome === "failed"),
    cards,
  };
}

/**
 * Every gate call in the log (V2-016), oldest first.
 *
 * The run record keeps these rather than the raw lines because a report only
 * ever asks three things of them: how long they took, which model answered,
 * and what the second opinion did to the score.
 */
export function gateCallsFrom(log: readonly CandidateLogLine[]): GateCallRecord[] {
  const calls: GateCallRecord[] = [];
  for (const line of log) {
    if (line.kind !== "gate") continue;
    calls.push({
      candidateId: line.candidateId,
      gate: line.gate,
      score: line.score,
      observerScore: candidateScore(line.observerScores),
      latencyMs: line.latencyMs,
      ...(line.error === undefined ? {} : { error: line.error }),
    });
  }
  return calls;
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
