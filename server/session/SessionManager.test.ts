import { describe, expect, it } from "vitest";
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { ServerEvent, TurnEvent } from "../../shared/events.js";
import type { AudioEndReason, AudioSink, AudioSource } from "../audio/AudioSource.js";
import { SimulatedClock, systemClock, type Clock } from "../clock.js";
import { EventBus } from "../events/bus.js";
import { SessionManager, SessionStartError, type AsrClient } from "./SessionManager.js";

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/** Wall clock a `1x` replay can race through: every wait takes no real time. */
function instantWallClock(): Clock {
  let now = 0;
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      now += ms;
      queueMicrotask(fn);
      return () => {};
    },
    track: systemClock.track,
  };
}

/**
 * Stands in for {@link RealtimeTranscriptionClient} so a `wav` session can be
 * tested without a socket: it drains the audio source, hands back one
 * scripted turn's frames, and finishes when the audio ends.
 */
class FakeAsrClient implements AsrClient {
  chunks = 0;
  endReason: AudioEndReason | undefined;
  private source: AudioSource | undefined;

  constructor(private readonly onFrame: (record: AsrFrameRecord) => void) {}

  run(source: AudioSource): Promise<void> {
    this.source = source;
    return new Promise<void>((resolve) => {
      const sink: AudioSink = {
        onChunk: () => {
          this.chunks += 1;
        },
        onEnd: (reason) => {
          this.endReason = reason;
          resolve();
        },
      };
      source.start(sink);
    });
  }

  /** Plays one turn back, as the API would while audio is streaming. */
  deliverTurn(): void {
    const frames: Record<string, unknown>[] = [
      { type: "speechStart", turnId: 0, audioProcessedMs: 100 },
      { type: "transcript", transcript: " So walk", final: false, audioProcessedMs: 200 },
      { type: "speaker", label: "A", audioProcessedMs: 300 },
      { type: "speechEnd", turnId: 0, audioProcessedMs: 400 },
      {
        type: "speechComplete",
        turnId: 0,
        transcript: " So walk me through it. ",
        audioProcessedMs: 400,
      },
    ];
    for (const frame of frames)
      this.onFrame({ atMs: Number(frame["audioProcessedMs"]), session: 0, frame });
  }

  stop(): void {
    this.source?.stop();
  }
}

interface Harness {
  bus: EventBus;
  sessions: SessionManager;
  /** Every event published since the harness was built, in order. */
  events: ServerEvent[];
  /** Resolves the next time the session ends. */
  ended: () => Promise<void>;
}

function harness(options: { apiKey?: string; client?: (c: FakeAsrClient) => void } = {}): Harness {
  const bus = new EventBus(quiet);
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const sessions = new SessionManager({
    bus,
    apiKey: options.apiKey,
    logger: quiet,
    replaySpeed: "max",
    wallClock: instantWallClock(),
    createAsrClient: ({ onFrame }) => {
      const client = new FakeAsrClient(onFrame);
      options.client?.(client);
      return client;
    },
  });
  return {
    bus,
    sessions,
    events,
    ended: () =>
      new Promise<void>((resolve) => {
        const off = bus.subscribe((event) => {
          if (event.type === "session" && event.session === null) {
            off();
            resolve();
          }
        });
      }),
  };
}

function turns(events: ServerEvent[]): TurnEvent["turn"][] {
  return events.filter((event): event is TurnEvent => event.type === "turn").map((e) => e.turn);
}

describe("SessionManager, events replay", () => {
  it("runs a capture through the assembler and onto the bus", async () => {
    const { sessions, events, ended } = harness({ apiKey: "test-key" });
    const done = ended();

    const info = sessions.start({ kind: "events", fixture: "brainstorm" });
    expect(info.id).toBe("events-brainstorm-1");
    expect(sessions.state()).toEqual(info);
    expect(events.slice(0, 3)).toEqual([
      { type: "session", session: info },
      {
        type: "status",
        status: {
          channel: "transcription",
          state: "active",
          detail: "replaying brainstorm events at max",
        },
      },
      {
        type: "status",
        status: { channel: "model", state: "active", detail: "model client ready" },
      },
    ]);

    await done;

    const finals = turns(events).filter((turn) => turn.final);
    expect(finals.length).toBeGreaterThan(10);
    expect(new Set(finals.map((turn) => turn.speaker)).size).toBeGreaterThanOrEqual(2);
    expect(finals.every((turn) => turn.text.trim() !== "")).toBe(true);
    // Replay sets the pipeline clock to each frame's recorded arrival time.
    expect(finals.at(-1)?.startMs).toBeGreaterThan(60_000);
  });

  it("returns every dot to idle when the replay ends on its own", async () => {
    const { sessions, bus, ended } = harness({ apiKey: "test-key" });
    const done = ended();
    sessions.start({ kind: "events", fixture: "moment-fact" });
    expect(bus.status("transcription").state).toBe("active");
    expect(bus.status("model").state).toBe("active");

    await done;

    expect(bus.status("transcription").state).toBe("idle");
    expect(bus.status("model").state).toBe("idle");
    expect(sessions.state()).toBeNull();
  });

  it("stops a replay part way through", async () => {
    const { sessions, bus, events } = harness();
    sessions.start({ kind: "events", fixture: "brainstorm" });

    expect(await sessions.stop()).toBe(true);

    expect(sessions.state()).toBeNull();
    expect(bus.status("transcription").state).toBe("idle");
    expect(events.at(-1)).toEqual({ type: "session", session: null });
    // Stopping is not failing.
    expect(bus.status("transcription").detail).toBeUndefined();
  });

  it("says so when there is nothing to stop", async () => {
    const { sessions } = harness();
    expect(await sessions.stop()).toBe(false);
  });

  it("shows the model dot in error when the server has no API key", async () => {
    const { sessions, bus } = harness();
    sessions.start({ kind: "events", fixture: "no-wake" });
    expect(bus.status("model")).toEqual({
      channel: "model",
      state: "error",
      detail: "MODEL_API_KEY is missing",
    });
    await sessions.stop();
  });

  it("refuses a second session while one is running", async () => {
    const { sessions } = harness();
    sessions.start({ kind: "events", fixture: "brainstorm" });

    try {
      sessions.start({ kind: "events", fixture: "no-wake" });
      expect.unreachable("second start should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionStartError);
      expect((error as SessionStartError).status).toBe(409);
      expect((error as Error).message).toContain("already running");
    }
    await sessions.stop();
  });

  it("rejects a fixture that has no capture", () => {
    const { sessions } = harness();
    try {
      sessions.start({ kind: "events", fixture: "nope" });
      expect.unreachable("missing fixture should have thrown");
    } catch (error) {
      expect((error as SessionStartError).status).toBe(400);
      expect((error as Error).message).toContain("nope");
    }
  });
});

describe("SessionManager, live audio", () => {
  it("streams a WAV through the transcription client into the assembler", async () => {
    let client: FakeAsrClient | undefined;
    const clock = new SimulatedClock(0);
    const bus = new EventBus(quiet);
    const events: ServerEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      liveClock: clock,
      createAsrClient: ({ onFrame }) => {
        client = new FakeAsrClient(onFrame);
        return client;
      },
    });

    sessions.start({ kind: "wav", fixture: "brainstorm" });
    // Nothing has come back from the API yet, so the dot is still on its way.
    expect(bus.status("transcription").state).toBe("connecting");

    // A second of audio at 80 ms a chunk, then the API answers.
    clock.advanceBy(1_000);
    expect(client?.chunks).toBe(12);
    client?.deliverTurn();

    expect(bus.status("transcription")).toEqual({
      channel: "transcription",
      state: "active",
      detail: "transcribing WAV: brainstorm",
    });
    const final = turns(events).filter((turn) => turn.final);
    expect(final).toHaveLength(1);
    expect(final[0]?.text).toBe(" So walk me through it. ");
    expect(final[0]?.speaker).toBe("A");

    expect(await sessions.stop()).toBe(true);
    expect(client?.endReason).toBe("stopped");
    expect(bus.status("transcription").state).toBe("idle");
  });

  it("will not start a live session without an API key", () => {
    const { sessions } = harness();
    try {
      sessions.start({ kind: "wav", fixture: "brainstorm" });
      expect.unreachable("a live session without a key should have thrown");
    } catch (error) {
      expect((error as SessionStartError).status).toBe(503);
      expect((error as Error).message).toContain("MODEL_API_KEY");
    }
  });

  it("rejects a WAV fixture that is not there", () => {
    const { sessions } = harness({ apiKey: "test-key" });
    try {
      sessions.start({ kind: "wav", fixture: "nope" });
      expect.unreachable("missing WAV should have thrown");
    } catch (error) {
      expect((error as SessionStartError).status).toBe(400);
      expect((error as Error).message).toContain("nope");
    }
  });

  it("does not pretend the microphone works yet", () => {
    const { sessions } = harness({ apiKey: "test-key" });
    try {
      sessions.start({ kind: "mic" });
      expect.unreachable("mic should have thrown");
    } catch (error) {
      expect((error as SessionStartError).status).toBe(501);
      expect((error as Error).message).toContain("US-012");
    }
  });

  it("shows the transcription dot in error when a session fails", async () => {
    const bus = new EventBus(quiet);
    const failures: string[] = [];
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: { ...quiet, error: (line: string) => failures.push(line) },
      liveClock: new SimulatedClock(0),
      createAsrClient: () => ({
        run: () => Promise.reject(new Error("transcription closed with 1011")),
        stop: () => {},
      }),
    });

    const failed = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "status" && event.status.state === "error") {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "wav", fixture: "brainstorm" });
    await failed;

    expect(bus.status("transcription")).toEqual({
      channel: "transcription",
      state: "error",
      detail: "transcription closed with 1011",
    });
    expect(bus.currentSession()).toBeNull();
    expect(sessions.state()).toBeNull();
    expect(failures).toHaveLength(1);
  });
});
