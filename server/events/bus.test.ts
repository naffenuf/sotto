import { describe, expect, it } from "vitest";
import type { ServerEvent, SessionInfo, StageCard } from "../../shared/index.js";
import { emptyBoard } from "../../shared/index.js";
import { EventBus, MAX_REMEMBERED_CARDS } from "./bus.js";

const session: SessionInfo = {
  id: "events-brainstorm-1",
  source: { kind: "events", fixture: "brainstorm" },
  startedAtMs: 0,
};

function glow(id: string, over: Partial<StageCard> = {}): StageCard {
  return {
    id,
    variant: "glow",
    state: "ready",
    createdAtMs: 12_000,
    headline: `nobody has said who writes ${id}`,
    ...over,
  };
}

function collect(bus: EventBus): ServerEvent[] {
  const seen: ServerEvent[] = [];
  bus.subscribe((event) => seen.push(event));
  return seen;
}

describe("EventBus", () => {
  it("starts with the server up and nothing else happening", () => {
    const bus = new EventBus();
    expect(bus.snapshot()).toEqual([
      { type: "status", status: { channel: "server", state: "active" } },
      { type: "status", status: { channel: "transcription", state: "idle" } },
      { type: "status", status: { channel: "model", state: "idle" } },
      // V2-010: which model judges is only known once a session has checked.
      { type: "status", status: { channel: "judgment", state: "idle" } },
      { type: "session", session: null },
      { type: "speakers", speakers: {} },
      { type: "board", board: emptyBoard(), changedIds: [], updatedAtMs: 0 },
      { type: "settings", settings: { chattiness: "normal", voiceMuted: false } },
      { type: "wake", listening: false },
      { type: "voice", voice: { speaking: false, playing: false, utteranceId: null, text: "" } },
    ]);
  });

  it("sends published events to every listener", () => {
    const bus = new EventBus();
    const first = collect(bus);
    const second = collect(bus);

    bus.setStatus("transcription", "active", "replaying brainstorm events at 1x");

    const expected: ServerEvent[] = [
      {
        type: "status",
        status: {
          channel: "transcription",
          state: "active",
          detail: "replaying brainstorm events at 1x",
        },
      },
    ];
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(bus.listenerCount).toBe(2);
  });

  it("stops sending to a listener that has unsubscribed", () => {
    const bus = new EventBus();
    const seen: ServerEvent[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event));

    bus.setStatus("model", "active", "model client ready");
    unsubscribe();
    bus.setStatus("model", "idle");

    expect(seen).toHaveLength(1);
    expect(bus.listenerCount).toBe(0);
  });

  it("skips a status that has not changed", () => {
    const bus = new EventBus();
    const seen = collect(bus);

    bus.setStatus("transcription", "active", "same");
    bus.setStatus("transcription", "active", "same");
    bus.setStatus("transcription", "active", "different");

    expect(seen.map((event) => event.type === "status" && event.status.detail)).toEqual([
      "same",
      "different",
    ]);
  });

  it("remembers the settings, and does not reset them for a new session", () => {
    const bus = new EventBus();
    const seen = collect(bus);

    bus.setSettings({ chattiness: "active", voiceMuted: false });
    expect(seen).toEqual([{ type: "settings", settings: { chattiness: "active", voiceMuted: false } }]);
    expect(bus.settingsState()).toEqual({ chattiness: "active", voiceMuted: false });

    // Turning Sotto up is meant for the next conversation too, unlike the
    // speaker names and the board.
    bus.setSession(session);
    expect(bus.settingsState()).toEqual({ chattiness: "active", voiceMuted: false });
    expect(bus.snapshot()).toContainEqual({
      type: "settings",
      settings: { chattiness: "active", voiceMuted: false },
    });
  });

  it("catches a late listener up with the statuses and the running session", () => {
    const bus = new EventBus();
    bus.setStatus("transcription", "active", "replaying brainstorm events at 1x");
    bus.setSession(session);

    expect(bus.snapshot()).toEqual([
      { type: "status", status: { channel: "server", state: "active" } },
      {
        type: "status",
        status: {
          channel: "transcription",
          state: "active",
          detail: "replaying brainstorm events at 1x",
        },
      },
      { type: "status", status: { channel: "model", state: "idle" } },
      { type: "status", status: { channel: "judgment", state: "idle" } },
      { type: "session", session },
      { type: "speakers", speakers: {} },
      { type: "board", board: emptyBoard(), changedIds: [], updatedAtMs: 0 },
      { type: "settings", settings: { chattiness: "normal", voiceMuted: false } },
      { type: "wake", listening: false },
      { type: "voice", voice: { speaking: false, playing: false, utteranceId: null, text: "" } },
    ]);
    expect(bus.currentSession()).toEqual(session);
    expect(bus.status("transcription").state).toBe("active");
  });

  it("does not remember turns, which are only interesting as they happen", () => {
    const bus = new EventBus();
    const seen = collect(bus);
    bus.publish({
      type: "turn",
      turn: {
        turnId: "0:0",
        speaker: "A",
        text: "hello",
        final: true,
        startMs: 100,
        endMs: 400,
        speakerMappingUncertain: false,
      },
    });

    expect(seen).toHaveLength(1);
    expect(bus.snapshot().some((event) => event.type === "turn")).toBe(false);
  });

  it("remembers speaker names, and forgets them with the session", () => {
    const bus = new EventBus();
    bus.setSession(session);
    const seen = collect(bus);
    bus.setSpeakerName("A", "  Craig  ");
    bus.setSpeakerName("B", "Dana");

    expect(seen).toEqual([
      { type: "speakers", speakers: { A: "Craig" } },
      { type: "speakers", speakers: { A: "Craig", B: "Dana" } },
    ]);
    expect(bus.speakerNames()).toEqual({ A: "Craig", B: "Dana" });
    expect(bus.snapshot()).toContainEqual({
      type: "speakers",
      speakers: { A: "Craig", B: "Dana" },
    });

    // A blank name is how the UI goes back to the bare label.
    bus.setSpeakerName("A", "   ");
    expect(bus.speakerNames()).toEqual({ B: "Dana" });

    // Labels belong to one session, so the next one starts nameless.
    bus.setSession(null);
    expect(bus.speakerNames()).toEqual({});
  });

  it("publishes the listening indicator only when it changes, and drops it with the session", () => {
    const bus = new EventBus();
    bus.setSession(session);
    const seen = collect(bus);

    bus.setListening(true);
    bus.setListening(true);
    expect(seen).toEqual([{ type: "wake", listening: true }]);
    expect(bus.listeningState()).toBe(true);
    expect(bus.snapshot()).toContainEqual({ type: "wake", listening: true });

    // Nobody is mid-question across the end of a session.
    bus.setSession(null);
    expect(bus.listeningState()).toBe(false);
    expect(bus.snapshot()).toContainEqual({ type: "wake", listening: false });
  });

  it("remembers the cards on the stage, one snapshot event each", () => {
    const bus = new EventBus();
    bus.setSession(session);
    const seen = collect(bus);

    bus.publishCard(glow("card-cand-1"));
    bus.publishCard(glow("card-cand-2"));

    expect(seen).toEqual([
      { type: "card", card: glow("card-cand-1") },
      { type: "card", card: glow("card-cand-2") },
    ]);
    // A browser that attaches now folds each one in exactly the way it folds
    // a live arrival, oldest first.
    expect(bus.snapshot().slice(-2)).toEqual([
      { type: "card", card: glow("card-cand-1") },
      { type: "card", card: glow("card-cand-2") },
    ]);
    expect(bus.cardState()).toEqual([glow("card-cand-1"), glow("card-cand-2")]);
  });

  it("replaces a card that arrives again rather than stacking it", () => {
    const bus = new EventBus();
    bus.publishCard(glow("card-cand-1", { state: "thinking", headline: "" }));
    bus.publishCard(glow("card-cand-1", { headline: "the digest copy has no owner" }));

    expect(bus.cardState()).toEqual([
      glow("card-cand-1", { headline: "the digest copy has no owner" }),
    ]);
  });

  it("clears the stage when a session starts, not when one ends", () => {
    const bus = new EventBus();
    bus.setSession(session);
    bus.publishCard(glow("card-cand-1"));

    // The last decision of a replay is published after the session has gone,
    // and what Sotto noticed is what you most want still on the screen.
    bus.setSession(null);
    expect(bus.cardState()).toEqual([glow("card-cand-1")]);

    bus.setSession({ ...session, id: "events-brainstorm-2" });
    expect(bus.cardState()).toEqual([]);
    expect(bus.snapshot().some((event) => event.type === "card")).toBe(false);
  });

  it("keeps the newest cards when a runaway loop produces too many", () => {
    const bus = new EventBus();
    for (let index = 0; index < MAX_REMEMBERED_CARDS + 5; index += 1) {
      bus.publishCard(glow(`card-cand-${index}`));
    }

    const remembered = bus.cardState();
    expect(remembered).toHaveLength(MAX_REMEMBERED_CARDS);
    expect(remembered[0]?.id).toBe("card-cand-5");
    expect(remembered.at(-1)?.id).toBe(`card-cand-${MAX_REMEMBERED_CARDS + 4}`);
  });

  it("keeps going when a listener throws", () => {
    const warnings: string[] = [];
    const bus = new EventBus({ warn: (line: string) => warnings.push(line) });
    bus.subscribe(() => {
      throw new Error("socket is gone");
    });
    const healthy = collect(bus);

    bus.setStatus("transcription", "active");

    expect(healthy).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("socket is gone");
  });
});
