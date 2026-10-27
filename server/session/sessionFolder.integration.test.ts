/**
 * End to end over the real pipeline: a captured conversation replayed at
 * `max` into a real session folder, with nothing faked in between.
 *
 * It lives in the integration suite because it exercises the whole stack and
 * writes to disk, not because it calls an API — an event replay never touches
 * the network, so this one runs with or without `MODEL_API_KEY`.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionRecord } from "../../shared/session.js";
import { fixtureEventsPath } from "../asr/EventReplaySource.js";
import { EventBus } from "../events/bus.js";
import { SessionManager } from "./SessionManager.js";
import { SESSION_FILES, SessionStore } from "./SessionStore.js";

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

let root: string;
let dir: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sotto-session-folder-"));
  const bus = new EventBus(quiet);
  const sessions = new SessionManager({
    bus,
    logger: quiet,
    replaySpeed: "max",
    createStore: (info) => SessionStore.create(info, { root, logger: quiet }),
  });

  const ended = new Promise<void>((resolve) => {
    const off = bus.subscribe((event) => {
      if (event.type === "session" && event.session === null) {
        off();
        resolve();
      }
    });
  });
  // No API key is passed: a replay needs none.
  sessions.start({ kind: "events", fixture: "brainstorm" });
  await ended;

  const folders = readdirSync(root);
  expect(folders).toHaveLength(1);
  dir = join(root, folders[0] as string);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function read(file: string): string {
  return readFileSync(join(dir, file), "utf8");
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

describe("replaying brainstorm into a session folder", () => {
  it("names the folder after the minute and the source", () => {
    expect(dir).toMatch(/\d{4}-\d{2}-\d{2}_\d{4}-events-brainstorm$/);
  });

  it("writes transcript.md with at least 10 final turns, in time order", () => {
    const transcript = lines(read(SESSION_FILES.transcript));
    expect(transcript.length).toBeGreaterThanOrEqual(10);

    const stamps = transcript.map((line) => {
      const match = /^\*\*\[(\d{2}):(\d{2})\] (.+?):\*\* (.+)$/.exec(line);
      expect(match, `badly formatted transcript line: ${line}`).not.toBeNull();
      const [, minutes, seconds, , text] = match as RegExpExecArray;
      expect((text as string).trim()).not.toBe("");
      return Number(minutes) * 60 + Number(seconds);
    });
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it("writes session.json with endedAt set and both speakers known", () => {
    const record = JSON.parse(read(SESSION_FILES.session)) as SessionRecord;
    expect(record.endedAt).not.toBeNull();
    expect(Date.parse(record.endedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(record.startedAt),
    );
    expect(record.source).toEqual({ kind: "events", fixture: "brainstorm" });
    expect(Object.keys(record.speakers).sort()).toEqual(["A", "B"]);
    expect(record.asrSessions).toHaveLength(1);
  });

  it("writes events.jsonl: every frame of the capture, unchanged", () => {
    const captured = lines(readFileSync(fixtureEventsPath("brainstorm"), "utf8"));
    const saved = lines(read(SESSION_FILES.events));
    expect(saved).toHaveLength(captured.length);
    expect(saved.map((line) => JSON.parse(line))).toEqual(captured.map((line) => JSON.parse(line)));
  });
});
