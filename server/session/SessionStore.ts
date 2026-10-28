/**
 * The session folder: everything one session produced, on disk.
 *
 *     sessions/2026-10-27_1304-events-brainstorm/
 *       session.json       metadata, rewritten on every change
 *       events.jsonl       every raw transcription frame, as `npm run capture` writes them
 *       transcript.md      one line per final turn
 *       board.json/.md     the living board (US-009)
 *       candidates.jsonl   observer candidates and the policy's decision (US-012-US-014)
 *       feedback.jsonl     the user's verdict on delivered cards (US-015)
 *       answers.jsonl      one record per answer (US-018)
 *       artifacts/         generated HTML (US-020)
 *
 * The folder is the build's audit trail: a session can be checked, and the
 * eval harness scored, by reading files instead of watching a UI. So writing
 * is deliberately boring — the append-only logs go out line by line through an
 * open file descriptor, and anything written whole (`session.json`,
 * `transcript.md` after a rename, the board) goes to a temp file and is
 * renamed over the top, so a crash never leaves half a file behind.
 *
 * A broken disk must not take the conversation down with it: every write is
 * guarded, and a file that fails is reported once and then written to in hope.
 */
import { closeSync, existsSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AsrFrameRecord } from "../../shared/asr.js";
import {
  defaultSettings,
  sourceSlug,
  type SessionInfo,
  type SessionRecord,
  type SessionSettings,
} from "../../shared/session.js";
import type { TurnUpdate } from "../../shared/turns.js";

type Logger = Pick<Console, "log" | "warn">;

/** Where session folders go, unless a caller (or a test) says otherwise. */
export const SESSIONS_DIR = fileURLToPath(new URL("../../sessions/", import.meta.url));

/** Every file a session folder can hold, so each name is spelled once. */
export const SESSION_FILES = {
  session: "session.json",
  events: "events.jsonl",
  transcript: "transcript.md",
  board: "board.json",
  boardMarkdown: "board.md",
  candidates: "candidates.jsonl",
  feedback: "feedback.jsonl",
  answers: "answers.jsonl",
} as const;

/** Subfolder generated HTML goes in (US-020). */
export const ARTIFACTS_DIR = "artifacts";

/** How many folders of the same name and minute to try before giving up. */
const MAX_FOLDER_ATTEMPTS = 100;

/**
 * What the pipeline is allowed to do to a session folder.
 *
 * {@link SessionStore} is the only implementation; the interface exists so
 * {@link SessionManager} can be handed something else in a test, and so the
 * later stories can see at a glance which file each of them owns.
 */
export interface SessionWriter {
  /** Absolute path of the folder. */
  readonly dir: string;
  /** Records one raw transcription frame, exactly as it arrived. */
  appendEvent(record: AsrFrameRecord): void;
  /** Records a turn. Partials are ignored; only final turns reach the file. */
  appendTurn(turn: TurnUpdate): void;
  /** Gives a diarization label a display name, or clears it with `null`. */
  renameSpeaker(label: string, name: string | null): void;
  /** Replaces the saved settings: the chattiness the policy is using (US-014). */
  setSettings(settings: SessionSettings): void;
  /** Writes the board as JSON and as markdown (US-009). */
  writeBoard(board: unknown, markdown: string): void;
  /** Appends an observer candidate with its scores and decision (US-012-US-014). */
  appendCandidate(candidate: unknown): void;
  /** Appends the user's feedback on a delivered card (US-015). */
  appendFeedback(feedback: unknown): void;
  /** Appends one answer record (US-018). */
  appendAnswer(answer: unknown): void;
  /** Writes an HTML artifact and returns its path, relative to the folder (US-020). */
  writeArtifact(fileName: string, html: string): string;
  /** Stamps `endedAt`, flushes and closes. Idempotent. */
  end(): void;
}

export interface SessionStoreOptions {
  /** Folder the session folder is created in. Defaults to {@link SESSIONS_DIR}. */
  root?: string;
  /**
   * Wall-clock time, for the folder name and the ISO stamps in
   * `session.json`. The pipeline's {@link Clock} is monotonic and cannot name
   * a date, so this is the one place the server reads the calendar — and a
   * test replaces it rather than guessing what minute it is in.
   */
  now?: () => Date;
  logger?: Logger;
}

/** A final turn, kept so a rename can rewrite `transcript.md` from scratch. */
interface TranscriptLine {
  /** Diarization label, or `null` if the turn somehow never got one. */
  label: string | null;
  /** Milliseconds from the start of the session to the start of the turn. */
  offsetMs: number;
  text: string;
}

export class SessionStore implements SessionWriter {
  readonly dir: string;

  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly record: SessionRecord;
  private readonly lines: TranscriptLine[] = [];
  /** Open descriptors for the append-only files, by file name. */
  private readonly handles = new Map<string, number>();
  /** Files already reported as unwritable, so a bad disk is logged once each. */
  private readonly reported = new Set<string>();
  private ended = false;

  private constructor(
    dir: string,
    info: SessionInfo,
    startedAt: Date,
    now: () => Date,
    logger: Logger,
  ) {
    this.dir = dir;
    this.now = now;
    this.logger = logger;
    this.record = {
      id: info.id,
      startedAt: startedAt.toISOString(),
      endedAt: null,
      source: info.source,
      speakers: {},
      asrSessions: [],
      // Overwritten by whatever the server is actually set to, as soon as
      // SessionManager has opened the folder.
      settings: defaultSettings(),
    };
    this.writeSession();
  }

  /**
   * Creates `<root>/<YYYY-MM-DD_HHMM>-<source>/` and writes the first
   * `session.json`. Two sessions of the same source in the same minute get a
   * `-2`, `-3`, … suffix rather than sharing a folder.
   */
  static create(info: SessionInfo, options: SessionStoreOptions = {}): SessionStore {
    const now = options.now ?? ((): Date => new Date());
    const root = options.root ?? SESSIONS_DIR;
    const logger = options.logger ?? console;
    const startedAt = now();
    mkdirSync(root, { recursive: true });
    const dir = makeFolder(root, `${folderTimestamp(startedAt)}-${sourceSlug(info.source)}`);
    logger.log(`[session] ${info.id} saving to ${dir}`);
    return new SessionStore(dir, info, startedAt, now, logger);
  }

  /** The metadata as it currently stands, for tests and for the UI to read. */
  state(): SessionRecord {
    return structuredClone(this.record);
  }

  appendEvent(record: AsrFrameRecord): void {
    this.appendLine(SESSION_FILES.events, JSON.stringify(record));
    // The handshake acknowledgement is the only frame with a `sessionId` and
    // no `type` (`fixtures/events/NOTES.md`), and there is one per reconnect.
    const id = asrSessionId(record.frame);
    if (id === undefined || this.record.asrSessions.includes(id)) return;
    this.record.asrSessions.push(id);
    this.writeSession();
  }

  appendTurn(turn: TurnUpdate): void {
    if (!turn.final) return;
    const line: TranscriptLine = {
      label: turn.speaker,
      // A turn's `startMs` is already measured from the start of the stream
      // — the realtime client reports frame times that way and a replay sets
      // the clock to the capture's own `atMs` — so the offset is the time.
      offsetMs: turn.startMs,
      // transcript.md is one line per turn, so the text has to stay on one.
      text: turn.text.replace(/\s+/g, " ").trim(),
    };
    this.lines.push(line);
    this.appendLine(SESSION_FILES.transcript, this.transcriptLine(line));
    if (line.label === null || this.record.speakers[line.label] !== undefined) return;
    this.record.speakers[line.label] = { name: null };
    this.writeSession();
  }

  renameSpeaker(label: string, name: string | null): void {
    const display = name === null || name.trim() === "" ? null : name.trim();
    this.record.speakers[label] = { name: display };
    this.writeSession();
    // Every line this label has already said now reads differently, so the
    // file is rewritten whole rather than corrected in place.
    this.rewriteTranscript();
  }

  setSettings(settings: SessionSettings): void {
    this.record.settings = settings;
    this.writeSession();
  }

  writeBoard(board: unknown, markdown: string): void {
    this.writeAtomic(SESSION_FILES.board, `${JSON.stringify(board, null, 2)}\n`);
    this.writeAtomic(SESSION_FILES.boardMarkdown, endWithNewline(markdown));
  }

  appendCandidate(candidate: unknown): void {
    this.appendLine(SESSION_FILES.candidates, JSON.stringify(candidate));
  }

  appendFeedback(feedback: unknown): void {
    this.appendLine(SESSION_FILES.feedback, JSON.stringify(feedback));
  }

  appendAnswer(answer: unknown): void {
    this.appendLine(SESSION_FILES.answers, JSON.stringify(answer));
  }

  writeArtifact(fileName: string, html: string): string {
    const safe = artifactName(fileName);
    const relative = join(ARTIFACTS_DIR, safe);
    this.guard(relative, () => {
      mkdirSync(join(this.dir, ARTIFACTS_DIR), { recursive: true });
    });
    this.writeAtomic(relative, html);
    return relative;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.record.endedAt = this.now().toISOString();
    this.writeSession();
    for (const file of [...this.handles.keys()]) this.closeHandle(file);
  }

  /** The `**[mm:ss] Name-or-label:** text` line for one final turn. */
  private transcriptLine(line: TranscriptLine): string {
    const label = line.label ?? "?";
    const name = this.record.speakers[label]?.name ?? label;
    return `**[${clockStamp(line.offsetMs)}] ${name}:** ${line.text}`;
  }

  private rewriteTranscript(): void {
    // The atomic write swaps in a new file, which would leave the open
    // descriptor writing to the old one; the next append reopens it.
    this.closeHandle(SESSION_FILES.transcript);
    const body = this.lines.map((line) => `${this.transcriptLine(line)}\n`).join("");
    this.writeAtomic(SESSION_FILES.transcript, body);
  }

  private writeSession(): void {
    this.writeAtomic(SESSION_FILES.session, `${JSON.stringify(this.record, null, 2)}\n`);
  }

  /** Appends one line to an append-only file, keeping its descriptor open. */
  private appendLine(file: string, line: string): void {
    this.guard(file, () => {
      let fd = this.handles.get(file);
      if (fd === undefined) {
        fd = openSync(join(this.dir, file), "a");
        this.handles.set(file, fd);
      }
      writeSync(fd, `${line}\n`);
    });
  }

  private closeHandle(file: string): void {
    const fd = this.handles.get(file);
    if (fd === undefined) return;
    this.handles.delete(file);
    this.guard(file, () => closeSync(fd));
  }

  /** Writes a whole file the only safe way: temp file, then rename over it. */
  private writeAtomic(file: string, contents: string): void {
    this.guard(file, () => {
      const target = join(this.dir, file);
      const temp = `${target}.tmp`;
      writeFileSync(temp, contents);
      renameSync(temp, target);
    });
  }

  /**
   * Runs a write, turning a failure into one warning per file. Losing the
   * folder is bad; losing the conversation because of it would be worse.
   */
  private guard(file: string, write: () => void): void {
    try {
      write();
    } catch (error) {
      if (this.reported.has(file)) return;
      this.reported.add(file);
      this.logger.warn(
        `[session] cannot write ${join(this.dir, file)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** `YYYY-MM-DD_HHMM` in local time: the start of a session folder's name. */
export function folderTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}`,
  ].join("_");
}

/** `mm:ss` for a turn's offset into the session, as `transcript.md` shows it. */
export function clockStamp(offsetMs: number): string {
  const seconds = Math.max(0, Math.round(offsetMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Creates `<root>/<base>`, or `<base>-2`, `-3`, … if that is taken. */
function makeFolder(root: string, base: string): string {
  for (let attempt = 1; attempt <= MAX_FOLDER_ATTEMPTS; attempt += 1) {
    const dir = join(root, attempt === 1 ? base : `${base}-${attempt}`);
    if (existsSync(dir)) continue;
    mkdirSync(dir);
    return dir;
  }
  throw new Error(`cannot make a session folder: ${join(root, base)} and ${MAX_FOLDER_ATTEMPTS} suffixes exist`);
}

/** The realtime session id a handshake acknowledgement carries, if this is one. */
function asrSessionId(frame: Record<string, unknown>): string | undefined {
  if ("type" in frame) return undefined;
  const id = frame["sessionId"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** Keeps an artifact's name a file name, never a path. */
function artifactName(fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (safe === "" || safe === "." || safe === "..") {
    throw new Error(`not a usable artifact file name: ${JSON.stringify(fileName)}`);
  }
  return safe;
}

function endWithNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
