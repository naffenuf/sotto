/**
 * One fixture WAV, streamed through the whole loop against the real APIs
 * (PRD US-021).
 *
 * This is the only place in the project that runs the pipeline from *audio*
 * outside a browser: `WavReplaySource` at real-time pace into the real
 * realtime transcription, the real board, observer, verifier, policy and
 * answer agent, and a real session folder. Nothing is faked and nothing is
 * special — it starts an ordinary `{ kind: "wav" }` session and watches the
 * same event bus a browser watches, exactly as the eval harness does with
 * captured events (US-016).
 *
 * Real-time pace is the point of the story, and it is also what makes the run
 * affordable: the board updates, the observer's looks and the checks all
 * happen *while* the conversation is playing, so a two-minute fixture costs
 * two minutes plus the drain at the end.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AnswerLogRecord } from "../../shared/answers.js";
import type { Board } from "../../shared/board.js";
import type { DecisionLogRecord } from "../../shared/candidates.js";
import type { E2eFiles, E2eObserved } from "../../shared/e2e.js";
import type { SessionRecord } from "../../shared/session.js";
import { isSottoTurn } from "../../shared/turns.js";
import { fixtureAudioPath } from "../audio/WavReplaySource.js";
import { readWavFile } from "../audio/wav.js";
import { AUDIO_SAMPLE_RATE } from "../../shared/audio.js";
import { EventBus } from "../events/bus.js";
import { deliveredDecisions, readCandidateLog } from "../eval/runner.js";
import type { ModelClientFactory } from "../session/SessionManager.js";
import { SessionManager } from "../session/SessionManager.js";
import { ARTIFACTS_DIR, SESSION_FILES, SessionStore } from "../session/SessionStore.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

export interface LiveRunOptions {
  fixture: string;
  /** Meta API key: the same one pays for transcription and for the model. */
  apiKey: string;
  /** Where this run's session folders go, one per fixture. */
  sessionRoot: string;
  /** So the run's token usage lands in the caller's meter. */
  createModel: ModelClientFactory;
  logger?: Logger;
}

/** Seconds of audio in a fixture WAV, which is what the ASR bill is per. */
export function fixtureAudioSeconds(fixture: string): number {
  const wav = readWavFile(fixtureAudioPath(fixture));
  return wav.data.length / (2 * AUDIO_SAMPLE_RATE);
}

/**
 * Plays `fixture` through a live session and returns what reached the bus.
 *
 * The session is never stopped from outside: it ends when the WAV runs out,
 * which is what gives the loops their drain and the policy the real silence
 * at the end of a conversation.
 */
export async function runLive(options: LiveRunOptions): Promise<E2eObserved> {
  const logger = options.logger ?? console;
  const bus = new EventBus(logger);
  const observed: E2eObserved = {
    fixture: options.fixture,
    turns: [],
    cards: [],
    wakeAtMs: [],
    boardPushes: 0,
    audioSeconds: 0,
    errors: [],
    sessionDir: null,
    elapsedMs: 0,
  };
  try {
    observed.audioSeconds = fixtureAudioSeconds(options.fixture);
  } catch (error) {
    observed.error = `cannot read the fixture WAV: ${message(error)}`;
    return observed;
  }

  const sessions = new SessionManager({
    bus,
    apiKey: options.apiKey,
    createModel: options.createModel,
    logger,
    createStore: (info) => {
      const store = SessionStore.create(info, { root: options.sessionRoot, logger });
      observed.sessionDir = store.dir;
      return store;
    },
  });

  // Wall-clock, from just before the session starts: the only timeline a
  // turn's position in the audio and a card's `createdAtMs` can meet on.
  const startedAt = Date.now();
  const at = (): number => Date.now() - startedAt;
  const ended = new Promise<void>((resolve) => {
    const off = bus.subscribe((event) => {
      // V2-008a: the latency map and the moment checks read the room's turns;
      // Sotto's own lines carry no `endMs` the API reported.
      if (event.type === "turn" && event.turn.final && !isSottoTurn(event.turn)) {
        observed.turns.push({ value: event.turn, atMs: at() });
      }
      if (event.type === "card") observed.cards.push({ value: event.card, atMs: at() });
      if (event.type === "wake" && event.listening) observed.wakeAtMs.push(at());
      if (event.type === "board") observed.boardPushes += 1;
      if (event.type === "status" && event.status.state === "error") {
        observed.errors.push(`${event.status.channel}: ${event.status.detail ?? "error"}`);
      }
      if (event.type === "session" && event.session === null) {
        off();
        resolve();
      }
    });
  });

  try {
    sessions.start({ kind: "wav", fixture: options.fixture });
    await ended;
  } catch (error) {
    observed.error = message(error);
  }
  observed.elapsedMs = at();
  return observed;
}

/** The session folder after the run, read back as the contract it is. */
export function readSessionFiles(dir: string | null): E2eFiles {
  const files: E2eFiles = {
    session: null,
    transcriptLines: 0,
    events: 0,
    board: null,
    boardMarkdown: "",
    answers: [],
    decisions: {},
    candidates: 0,
    artifacts: [],
    artifactHtml: {},
  };
  if (dir === null) return files;

  files.session = readJson<SessionRecord>(join(dir, SESSION_FILES.session));
  files.transcriptLines = countLines(join(dir, SESSION_FILES.transcript));
  files.events = countLines(join(dir, SESSION_FILES.events));
  files.board = readJson<Board>(join(dir, SESSION_FILES.board));
  files.boardMarkdown = readText(join(dir, SESSION_FILES.boardMarkdown)) ?? "";
  files.answers = readJsonLines<AnswerLogRecord>(join(dir, SESSION_FILES.answers));

  const log = readCandidateLog(dir);
  files.candidates = log.filter((line) => line.kind === "candidate").length;
  files.decisions = Object.fromEntries(
    deliveredDecisions(log) as Map<string, DecisionLogRecord>,
  );

  try {
    files.artifacts = readdirSync(join(dir, ARTIFACTS_DIR));
  } catch {
    // No folder until the first artifact is written (US-020).
  }
  for (const file of files.artifacts) {
    const html = readText(join(dir, ARTIFACTS_DIR, file));
    if (html !== null) files.artifactHtml[file] = html;
  }
  return files;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // A log is only opened on its first append, so absent means "nothing yet".
    return null;
  }
}

function readJson<T>(path: string): T | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function countLines(path: string): number {
  const text = readText(path);
  return text === null ? 0 : text.split("\n").filter((line) => line.trim() !== "").length;
}

function readJsonLines<T>(path: string): T[] {
  const text = readText(path);
  if (text === null) return [];
  const lines: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      lines.push(JSON.parse(line) as T);
    } catch {
      // Only a half-written last line gets here.
    }
  }
  return lines;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
