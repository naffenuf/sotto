import { describe, expect, it } from "vitest";
import type { ServerEvent, SessionInfo } from "../../shared/index.js";
import { EventBus } from "./bus.js";

const session: SessionInfo = {
  id: "events-brainstorm-1",
  source: { kind: "events", fixture: "brainstorm" },
  startedAtMs: 0,
};

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
      { type: "session", session: null },
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
      { type: "session", session },
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
