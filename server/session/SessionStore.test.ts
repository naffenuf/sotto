import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { SessionInfo, SessionRecord } from "../../shared/session.js";
import { SOTTO_SPEAKER, sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import {
  INTERRUPTED_MARKER,
  SESSION_FILES,
  SessionStore,
  clockStamp,
  folderTimestamp,
} from "./SessionStore.js";

const quiet = { log: () => {}, warn: () => {} };

/** Temp roots made by the tests, removed however the test ended. */
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sotto-sessions-"));
  roots.push(root);
  return root;
}

const info: SessionInfo = {
  id: "events-brainstorm-1",
  source: { kind: "events", fixture: "brainstorm" },
  startedAtMs: 0,
};

/**
 * A store in a throwaway folder, with the calendar frozen so names are fixed.
 * The frozen moment is built from local parts, because folder names are local
 * time and the suite has to pass in every timezone.
 */
const FROZEN_NOW = new Date(2026, 9, 27, 13, 4, 5, 678);

function store(options: { root?: string; info?: SessionInfo; warn?: (line: string) => void } = {}) {
  const root = options.root ?? tempRoot();
  return SessionStore.create(options.info ?? info, {
    root,
    now: () => FROZEN_NOW,
    logger: { ...quiet, warn: options.warn ?? quiet.warn },
  });
}

function turn(partial: Partial<TurnUpdate> & Pick<TurnUpdate, "turnId">): TurnUpdate {
  return {
    speaker: "A",
    text: "So walk me through it.",
    final: true,
    startMs: 0,
    endMs: null,
    speakerMappingUncertain: false,
    ...partial,
  };
}

function frame(body: Record<string, unknown>, atMs = 0): AsrFrameRecord {
  return { atMs, session: 0, frame: body };
}

function read(dir: string, file: string): string {
  return readFileSync(join(dir, file), "utf8");
}

function session(dir: string): SessionRecord {
  return JSON.parse(read(dir, SESSION_FILES.session)) as SessionRecord;
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

describe("SessionStore folder", () => {
  it("creates sessions/<YYYY-MM-DD_HHMM>-<source>/", () => {
    const root = tempRoot();
    const folder = store({ root }).dir;
    expect(readdirSync(root)).toEqual(["2026-10-27_1304-events-brainstorm"]);
    expect(folder).toBe(join(root, "2026-10-27_1304-events-brainstorm"));
  });

  it("suffixes a second session that starts in the same minute", () => {
    const root = tempRoot();
    store({ root });
    expect(store({ root }).dir).toBe(join(root, "2026-10-27_1304-events-brainstorm-2"));
  });

  it("names a WAV and a mic session by source too", () => {
    const root = tempRoot();
    store({ root, info: { ...info, source: { kind: "wav", fixture: "no-wake" } } });
    store({ root, info: { ...info, source: { kind: "mic" } } });
    expect(readdirSync(root).sort()).toEqual([
      "2026-10-27_1304-mic",
      "2026-10-27_1304-wav-no-wake",
    ]);
  });

  it("formats folder names and transcript stamps", () => {
    expect(folderTimestamp(new Date(2026, 0, 2, 3, 4))).toBe("2026-01-02_0304");
    expect(clockStamp(0)).toBe("00:00");
    expect(clockStamp(61_400)).toBe("01:01");
    expect(clockStamp(600_000)).toBe("10:00");
  });
});

describe("SessionStore session.json", () => {
  it("writes the metadata on creation and stamps endedAt at the end", () => {
    const saved = store();
    expect(session(saved.dir)).toEqual({
      id: "events-brainstorm-1",
      startedAt: FROZEN_NOW.toISOString(),
      endedAt: null,
      source: { kind: "events", fixture: "brainstorm" },
      speakers: {},
      asrSessions: [],
      settings: { frequency: "normal", boldness: "normal", voiceMuted: false },
    });

    saved.end();
    expect(session(saved.dir).endedAt).toBe(FROZEN_NOW.toISOString());
  });

  it("records every speaker label it has heard, and the settings", () => {
    const saved = store();
    saved.appendTurn(turn({ turnId: "0:0", speaker: "A" }));
    saved.appendTurn(turn({ turnId: "0:1", speaker: "B" }));
    saved.appendTurn(turn({ turnId: "0:2", speaker: "A" }));
    saved.setSettings({ frequency: "often", boldness: "bold", voiceMuted: false });

    const record = session(saved.dir);
    expect(record.speakers).toEqual({ A: { name: null }, B: { name: null } });
    expect(record.settings).toEqual({ frequency: "often", boldness: "bold", voiceMuted: false });
  });

  it("collects the realtime session id of every ASR session, once each", () => {
    const saved = store();
    saved.appendEvent(frame({ sessionId: "voyager/duplex/AAA" }));
    saved.appendEvent(frame({ type: "audioProgress", audioProcessedMs: 80 }, 80));
    saved.appendEvent(frame({ sessionId: "voyager/duplex/AAA" }));
    // A reconnect (US-005) opens a second one, which belongs in the list.
    saved.appendEvent(frame({ sessionId: "voyager/duplex/BBB" }));

    expect(session(saved.dir).asrSessions).toEqual([
      "voyager/duplex/AAA",
      "voyager/duplex/BBB",
    ]);
  });

  it("is idempotent about ending", () => {
    const saved = store();
    saved.end();
    saved.end();
    expect(session(saved.dir).endedAt).not.toBeNull();
  });
});

describe("SessionStore events.jsonl", () => {
  it("appends every raw frame exactly as it arrived", () => {
    const saved = store();
    const records = [
      frame({ sessionId: "voyager/duplex/AAA" }, 389.5),
      frame({ type: "audioProgress", audioProcessedMs: 80 }, 441.9),
      frame({ type: "speechStart", turnId: 0, audioProcessedMs: 1_200 }, 1_801),
    ];
    for (const record of records) saved.appendEvent(record);

    expect(lines(read(saved.dir, SESSION_FILES.events)).map((l) => JSON.parse(l))).toEqual(records);
  });
});

describe("SessionStore transcript.md", () => {
  it("writes one **[mm:ss] label:** line per final turn, and skips partials", () => {
    const saved = store();
    saved.appendTurn(turn({ turnId: "0:0", final: false, text: "So walk" }));
    saved.appendTurn(turn({ turnId: "0:0", startMs: 1_400, text: " So walk me through it. " }));
    saved.appendTurn(turn({ turnId: "0:1", speaker: "B", startMs: 65_000, text: "Right.\nOkay." }));

    expect(lines(read(saved.dir, SESSION_FILES.transcript))).toEqual([
      "**[00:01] A:** So walk me through it.",
      "**[01:05] B:** Right. Okay.",
    ]);
  });

  it("falls back to ? for a final turn that never got a label", () => {
    const saved = store();
    saved.appendTurn(turn({ turnId: "0:0", speaker: null }));
    expect(read(saved.dir, SESSION_FILES.transcript)).toBe("**[00:00] ?:** So walk me through it.\n");
  });

  it("rewrites the whole file when a speaker is renamed", () => {
    const saved = store();
    saved.appendTurn(turn({ turnId: "0:0", speaker: "A", text: "First." }));
    saved.appendTurn(turn({ turnId: "0:1", speaker: "B", startMs: 2_000, text: "Second." }));

    saved.renameSpeaker("A", "Craig");

    expect(lines(read(saved.dir, SESSION_FILES.transcript))).toEqual([
      "**[00:00] Craig:** First.",
      "**[00:02] B:** Second.",
    ]);
    expect(session(saved.dir).speakers["A"]).toEqual({ name: "Craig" });

    // Appends after the rewrite keep using the name, and keep the old lines.
    saved.appendTurn(turn({ turnId: "0:2", speaker: "A", startMs: 4_000, text: "Third." }));
    expect(lines(read(saved.dir, SESSION_FILES.transcript))).toEqual([
      "**[00:00] Craig:** First.",
      "**[00:02] B:** Second.",
      "**[00:04] Craig:** Third.",
    ]);
  });

  it("goes back to the bare label when the name is cleared", () => {
    const saved = store();
    saved.appendTurn(turn({ turnId: "0:0", speaker: "A", text: "First." }));
    saved.renameSpeaker("A", "Craig");
    saved.renameSpeaker("A", "   ");
    expect(read(saved.dir, SESSION_FILES.transcript)).toBe("**[00:00] A:** First.\n");
    expect(session(saved.dir).speakers["A"]).toEqual({ name: null });
  });
});

describe("SessionStore transcript.md and Sotto's own speech (V2-008a)", () => {
  it("labels it Sotto without making Sotto a speaker anybody can rename", () => {
    const saved = store();
    saved.appendTurn(turn({ turnId: "0:0", speaker: "A", text: "What do rivals charge?" }));
    saved.appendTurn(
      sottoTurn({
        utteranceId: "ans-1",
        text: "They charge five to twenty-five dollars a seat.",
        startMs: 4_000,
        interrupted: false,
      }),
    );

    expect(lines(read(saved.dir, SESSION_FILES.transcript))).toEqual([
      "**[00:00] A:** What do rivals charge?",
      "**[00:04] Sotto:** They charge five to twenty-five dollars a seat.",
    ]);
    // Only the room's labels are speakers; Sotto is not one of them.
    expect(Object.keys(session(saved.dir).speakers)).toEqual(["A"]);
  });

  it("marks a line the room only heard part of", () => {
    const saved = store();
    saved.appendTurn(
      sottoTurn({ utteranceId: "ans-1", text: "They charge five to", startMs: 0, interrupted: true }),
    );
    expect(read(saved.dir, SESSION_FILES.transcript)).toBe(
      `**[00:00] ${SOTTO_SPEAKER}:** They charge five to ${INTERRUPTED_MARKER}\n`,
    );
  });

  it("keeps the file in conversation order when its line lands late", () => {
    const saved = store();
    saved.appendTurn(turn({ turnId: "0:0", speaker: "A", startMs: 1_000, text: "What do rivals charge?" }));
    // The barge-in that cut Sotto off is transcribed before the utterance it
    // interrupted is over, so Sotto's line arrives last and belongs second.
    saved.appendTurn(turn({ turnId: "0:1", speaker: "A", startMs: 9_000, text: "Sotto, stop." }));
    saved.appendTurn(
      sottoTurn({ utteranceId: "ans-1", text: "They charge five to", startMs: 4_000, interrupted: true }),
    );

    expect(lines(read(saved.dir, SESSION_FILES.transcript))).toEqual([
      "**[00:01] A:** What do rivals charge?",
      `**[00:04] ${SOTTO_SPEAKER}:** They charge five to ${INTERRUPTED_MARKER}`,
      "**[00:09] A:** Sotto, stop.",
    ]);
  });

  it("leaves its line alone when a speaker is renamed", () => {
    const saved = store();
    saved.appendTurn(turn({ turnId: "0:0", speaker: "A", text: "First." }));
    saved.appendTurn(
      sottoTurn({ utteranceId: "ans-1", text: "Second.", startMs: 2_000, interrupted: false }),
    );
    saved.renameSpeaker("A", "Craig");

    expect(lines(read(saved.dir, SESSION_FILES.transcript))).toEqual([
      "**[00:00] Craig:** First.",
      `**[00:02] ${SOTTO_SPEAKER}:** Second.`,
    ]);
  });
});

describe("SessionStore files the later stories own", () => {
  it("writes the board as JSON and markdown, and appends the three logs", () => {
    const saved = store();
    saved.writeBoard({ points: ["one"] }, "# Board\n\n- one");
    saved.appendCandidate({ id: "c1", decision: "glow" });
    saved.appendFeedback({ id: "c1", verdict: "up" });
    saved.appendAnswer({ question: "what?", headline: "this" });
    saved.appendTiming({ stage: "turn_final", atMs: 12, turnId: "0:1" });

    expect(JSON.parse(read(saved.dir, SESSION_FILES.board))).toEqual({ points: ["one"] });
    expect(read(saved.dir, SESSION_FILES.boardMarkdown)).toBe("# Board\n\n- one\n");
    expect(read(saved.dir, SESSION_FILES.candidates)).toBe('{"id":"c1","decision":"glow"}\n');
    expect(read(saved.dir, SESSION_FILES.feedback)).toBe('{"id":"c1","verdict":"up"}\n');
    expect(read(saved.dir, SESSION_FILES.answers)).toBe(
      '{"question":"what?","headline":"this"}\n',
    );
    expect(JSON.parse(read(saved.dir, SESSION_FILES.timing))).toEqual({ stage: "turn_final", atMs: 12, turnId: "0:1" });
  });

  it("writes artifacts under artifacts/ and never outside the folder", () => {
    const saved = store();
    const relative = saved.writeArtifact("../../flow.html", "<p>hi</p>");
    // Separators are stripped, so the name stays one segment under artifacts/.
    expect(relative, "the artifact was not written").not.toBeNull();
    expect((relative as string).split(sep)).toEqual(["artifacts", "..-..-flow.html"]);
    expect(
      resolve(saved.dir, relative as string).startsWith(join(saved.dir, "artifacts") + sep),
    ).toBe(true);
    expect(read(saved.dir, relative as string)).toBe("<p>hi</p>");
    expect(() => saved.writeArtifact("", "<p>hi</p>")).toThrow(/usable artifact file name/);
  });

  it("writes a research packet as JSON and markdown under research/ (V2-013)", () => {
    const saved = store();
    saved.writePacket("packet-1", { id: "packet-1", title: "Otter is $16.99" }, "# Otter is $16.99");
    expect(JSON.parse(read(saved.dir, join("research", "packet-1.json")))).toEqual({
      id: "packet-1",
      title: "Otter is $16.99",
    });
    expect(read(saved.dir, join("research", "packet-1.md"))).toBe("# Otter is $16.99\n");
  });

  it("refuses a packet id the server would never have handed out", () => {
    const warnings: string[] = [];
    const saved = store({ warn: (line) => warnings.push(line) });
    saved.writePacket("../../escape", {}, "# nope");
    expect(existsSync(join(saved.dir, "research"))).toBe(false);
    expect(warnings.join(" ")).toContain("refusing to write a research packet");
  });
});

describe("SessionStore durability", () => {
  it("leaves no temp files behind", () => {
    const saved = store();
    saved.appendTurn(turn({ turnId: "0:0" }));
    saved.renameSpeaker("A", "Craig");
    saved.writeBoard({}, "# Board");
    saved.end();
    expect(readdirSync(saved.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps running when the folder goes away, warning once per file", () => {
    const warnings: string[] = [];
    const saved = store({ warn: (line) => warnings.push(line) });
    rmSync(saved.dir, { recursive: true, force: true });

    expect(() => {
      saved.appendTurn(turn({ turnId: "0:0" }));
      saved.appendTurn(turn({ turnId: "0:1" }));
      saved.appendEvent(frame({ type: "audioProgress", audioProcessedMs: 80 }, 80));
      saved.end();
    }).not.toThrow();

    // One per file it could not write: transcript.md, session.json, events.jsonl.
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("cannot write");
  });

  it("creates its root if nothing has made it yet", () => {
    const root = join(tempRoot(), "nested", "sessions");
    expect(store({ root }).dir).toContain("nested");
    mkdirSync(root, { recursive: true });
  });
});
