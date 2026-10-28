import { describe, expect, it } from "vitest";
import type { AsrFrameRecord } from "../../shared/asr.js";
import type { ServerEvent, TurnEvent } from "../../shared/events.js";
import {
  AUDIO_CHUNK_BYTES,
  type AudioEndReason,
  type AudioSink,
  type AudioSource,
} from "../audio/AudioSource.js";
import { SimulatedClock, systemClock, type Clock } from "../clock.js";
import { EventBus } from "../events/bus.js";
import type {
  CandidateLogLine,
  CandidateLogRecord,
  DecisionLogRecord,
} from "../../shared/candidates.js";
import type { FeedbackLogRecord } from "../../shared/feedback.js";
import type { StageCard } from "../../shared/cards.js";
import type {
  GroundedCall,
  GroundedReply,
  ModelClient,
  StructuredCall,
} from "../model/client.js";
import { SessionManager, SessionStartError, type AsrClient } from "./SessionManager.js";
import type { SessionWriter } from "./SessionStore.js";

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
    createStore: () => null,
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

describe("SessionManager, board and observer", () => {
  /**
   * A model that answers both loops from their label: one board operation per
   * update, and one candidate per look. Nothing reaches the network.
   */
  class ScriptedModel implements ModelClient {
    /** Distinct subjects, so no two candidates read as the same thought. */
    private static readonly subjects = [
      "the hospital handover",
      "the vendor quote",
      "the studio timeline",
      "the API pricing",
      "the launch date",
      "the data licence",
      "the hosting bill",
      "the hardware stock",
      "the pilot headcount",
      "the support rota",
    ];

    readonly calls: StructuredCall[] = [];
    private items = 0;

    /** It only ever notices assumptions, so nothing here is ever checked. */
    async grounded(): Promise<never> {
      throw new Error("unexpected grounded call");
    }

    async structured(call: StructuredCall): Promise<unknown> {
      this.calls.push(call);
      if (call.label === "board") {
        this.items += 1;
        return {
          operations: [
            { op: "add_point", text: `point ${this.items}`, sourceTurnIds: ["0:0"] },
          ],
        };
      }
      return {
        candidates: [
          {
            type: "untested_assumption",
            headline: `${ScriptedModel.subjects[(this.items - 1) % ScriptedModel.subjects.length]} is unchecked`,
            detail: "The plan rests on it.",
            whyNow: "They are about to decide",
            evidenceTurnIds: ["0:0"],
            relatedBoardItemIds: [`p${this.items}`],
            scores: { relevance: 0.8, novelty: 0.7, importance: 0.6, confidence: 0.5 },
          },
        ],
      };
    }
  }

  it("looks for candidates after each board update and writes them to the folder", async () => {
    const bus = new EventBus(quiet);
    const model = new ScriptedModel();
    const logged: CandidateLogLine[] = [];
    const writer = {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: (record: unknown) => logged.push(record as CandidateLogLine),
      appendFeedback: () => {},
      appendAnswer: () => {},
      writeArtifact: () => "",
      end: () => {},
    } satisfies SessionWriter;
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => writer,
      createModel: () => model,
      replaySpeed: "max",
      wallClock: instantWallClock(),
    });

    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "moment-contradiction" });
    await ended;

    const boardCalls = model.calls.filter((call) => call.label === "board");
    const observerCalls = model.calls.filter((call) => call.label === "observer");
    expect(boardCalls.length).toBeGreaterThan(1);
    // One look per update, and each look happens after the update it follows:
    // its request carries the item that update added.
    expect(observerCalls).toHaveLength(boardCalls.length);
    expect(observerCalls.at(-1)!.user).toContain(`[p${boardCalls.length}] point ${boardCalls.length}`);

    const candidates = logged.filter(
      (line): line is CandidateLogRecord => line.kind === "candidate",
    );
    expect(candidates).toHaveLength(observerCalls.length);
    expect(candidates.map((record) => record.candidate.id)).toEqual(
      candidates.map((_, index) => `cand-${index + 1}`),
    );
    // Different board items each time, so none of them is a repeat.
    for (const record of candidates) expect(record.candidate.duplicateOf).toBeUndefined();

    // And the policy (US-014) decided about every one of them in the same
    // file. These score 0.6 × 0.5 × 0.9 × 0.7 = 0.19, under `normal`'s glow
    // threshold, so nothing is ever said out loud.
    const decisions = logged.filter(
      (line): line is DecisionLogRecord => line.kind === "decision",
    );
    expect(decisions.map((record) => record.candidateId)).toEqual(
      candidates.map((record) => record.candidate.id),
    );
    for (const record of decisions) {
      expect(record.decision).toBe("silent");
      expect(record.reason).toBe("below_threshold");
      expect(record.chattiness).toBe("normal");
      expect(record.score).toBeCloseTo(0.189, 3);
    }
  });

  /**
   * US-013's wiring: a claim that looks wrong is checked against the web
   * before anything else sees it, and the check lands in the same log as the
   * candidate it checked.
   */
  it("checks a factual error against the web and writes the verdict down", async () => {
    /**
     * A different wrong claim every look, so the observer's duplicate rule
     * (same type, overlapping board items or an equivalent headline) passes
     * every one of them on and each gets its own check.
     */
    const claims = [
      "The iPad launched in 2012",
      "Spotify has two billion subscribers",
      "The App Store keeps forty percent",
      "Swift shipped before Objective-C",
      "Node 22 removed WebSocket support",
      "Figma was founded last year",
      "Stripe bills a flat ten dollars",
      "Postgres cannot store JSON",
    ];

    /** One board item, one `factual_error` per look, one verdict per check. */
    class CheckingModel implements ModelClient {
      readonly calls: string[] = [];
      private items = 0;

      async structured(call: StructuredCall): Promise<unknown> {
        this.calls.push(call.label);
        if (call.label === "board") {
          this.items += 1;
          return {
            operations: [
              { op: "add_point", text: `point ${this.items}`, sourceTurnIds: ["0:0"] },
            ],
          };
        }
        return {
          candidates: [
            {
              type: "factual_error",
              headline: claims[(this.items - 1) % claims.length]!,
              detail: "The number they are costing this off is wrong.",
              whyNow: "They are about to commit to it",
              evidenceTurnIds: ["0:0"],
              relatedBoardItemIds: [`p${this.items}`],
              scores: { relevance: 0.9, novelty: 0.8, importance: 0.8, confidence: 0.9 },
            },
          ],
        };
      }

      async grounded(call: GroundedCall): Promise<GroundedReply> {
        this.calls.push(call.label);
        return {
          value: {
            verdict: "wrong",
            correction: "It launched in October 2010.",
            citations: [{ url: "https://example.com/launch", title: "Launch" }],
          },
          citations: [],
          searchedUrls: ["https://example.com/launch"],
          searched: true,
        };
      }
    }

    const bus = new EventBus(quiet);
    const model = new CheckingModel();
    const lines: CandidateLogLine[] = [];
    const writer = {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: (record: unknown) => lines.push(record as CandidateLogLine),
      appendFeedback: () => {},
      appendAnswer: () => {},
      writeArtifact: () => "",
      end: () => {},
    } satisfies SessionWriter;
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => writer,
      createModel: () => model,
      replaySpeed: "max",
      wallClock: instantWallClock(),
    });

    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "moment-fact" });
    await ended;

    const noticed = lines.filter((line) => line.kind === "candidate");
    const checked = lines.filter((line) => line.kind === "verification");
    expect(noticed.length).toBeGreaterThan(0);
    // Every candidate this model notices is a factual error, so every one of
    // them is checked — and nothing is checked that was not noticed first.
    expect(checked).toHaveLength(noticed.length);
    expect(model.calls.filter((label) => label === "verify")).toHaveLength(checked.length);
    for (const record of checked) {
      expect(record.outcome).toBe("verified");
      expect(record.verification?.citations).toEqual([
        { url: "https://example.com/launch", title: "Launch" },
      ]);
    }
    const ids = new Set(noticed.map((record) => record.candidate.id));
    for (const record of checked) expect(ids.has(record.candidateId)).toBe(true);
  });
});

describe("SessionManager, delivery and feedback", () => {
  /**
   * One board item and one contradiction per look, every one of them scored
   * as high as a candidate can be, so the policy (US-014) delivers rather
   * than holding — and a different subject each time, so the observer's
   * duplicate rule passes them all on rather than folding them into the
   * first.
   */
  class LoudModel implements ModelClient {
    /** One per look, so no two candidates read as the same thing. */
    private static readonly subjects = [
      "the hosting bill",
      "the launch date",
      "the pilot headcount",
      "the support rota",
      "the data licence",
      "the vendor quote",
      "the studio timeline",
      "the API pricing",
      "the hardware stock",
      "the discount floor",
    ];

    private items = 0;

    async grounded(): Promise<never> {
      throw new Error("a contradiction is never checked against the web");
    }

    async structured(call: StructuredCall): Promise<unknown> {
      if (call.label === "board") {
        this.items += 1;
        return {
          operations: [
            { op: "add_point", text: `point ${this.items}`, sourceTurnIds: ["0:0"] },
          ],
        };
      }
      return {
        candidates: [
          {
            type: "contradiction",
            headline: `${LoudModel.subjects[(this.items - 1) % LoudModel.subjects.length]} cannot hold with what was just agreed`,
            detail: "The number they just agreed is under the floor they set.",
            whyNow: "the price is about to be written down",
            evidenceTurnIds: ["0:0"],
            relatedBoardItemIds: [`p${this.items}`],
            scores: { relevance: 1, novelty: 1, importance: 1, confidence: 1 },
          },
        ],
      };
    }
  }

  /** A writer that keeps the two logs this story writes to. */
  function recordingWriter(): {
    writer: SessionWriter;
    candidates: CandidateLogLine[];
    feedback: FeedbackLogRecord[];
  } {
    const candidates: CandidateLogLine[] = [];
    const feedback: FeedbackLogRecord[] = [];
    const writer = {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: (record: unknown) => candidates.push(record as CandidateLogLine),
      appendFeedback: (record: unknown) => feedback.push(record as FeedbackLogRecord),
      appendAnswer: () => {},
      writeArtifact: () => "",
      end: () => {},
    } satisfies SessionWriter;
    return { writer, candidates, feedback };
  }

  async function replay(): Promise<{
    sessions: SessionManager;
    bus: EventBus;
    cards: StageCard[];
    candidates: CandidateLogLine[];
    feedback: FeedbackLogRecord[];
  }> {
    const bus = new EventBus(quiet);
    const { writer, candidates, feedback } = recordingWriter();
    const cards: StageCard[] = [];
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
    });
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => writer,
      createModel: () => new LoudModel(),
      replaySpeed: "max",
      wallClock: instantWallClock(),
    });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "moment-contradiction" });
    await ended;
    return { sessions, bus, cards, candidates, feedback };
  }

  it("puts every delivered decision on the stage as a card", async () => {
    const { bus, cards, candidates } = await replay();

    // A decision that puts something on the stage, whatever the reason it
    // came out at that level: `cooldown` and `budget` are downgrades, not
    // losses, so they are deliveries too.
    const delivered = candidates.filter(
      (line): line is DecisionLogRecord =>
        line.kind === "decision" && (line.decision === "interject" || line.decision === "glow"),
    );
    expect(delivered.length).toBeGreaterThan(1);
    // One card per delivery, at the level the policy chose, carrying the
    // candidate's own id so a verdict can find its way back to it.
    expect(cards.map((card) => card.id)).toEqual(
      delivered.map((record) => `card-${record.candidateId}`),
    );
    expect(cards.map((card) => card.variant)).toEqual(
      delivered.map((record) => record.decision),
    );
    for (const card of cards) {
      expect(card.state).toBe("ready");
      expect(card.headline).not.toBe("");
    }
    // The first one is a full interjection; the cooldown turns the rest down
    // to glows rather than dropping them.
    expect(cards[0]?.variant).toBe("interject");
    expect(delivered.map((record) => record.reason)).toEqual([
      "delivered",
      ...delivered.slice(1).map(() => "cooldown"),
    ]);
    // And the stage survives the session it came from, which is when it is read.
    expect(bus.cardState()).toEqual(cards);
  });

  it("files a verdict on a delivered card in the session folder", async () => {
    const { sessions, cards, feedback } = await replay();
    const card = cards[0];
    expect(card).toBeDefined();

    expect(sessions.recordFeedback(card!.id, "wrong_moment")).toBe("recorded");

    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toEqual({
      kind: "feedback",
      atMs: expect.any(Number),
      cardId: card!.id,
      candidateId: card!.id.replace("card-", ""),
      level: card!.variant,
      type: "contradiction",
      headline: card!.headline,
      deliveredAtMs: card!.createdAtMs,
      verdict: "wrong_moment",
    });

    // A second click is a change of mind: the file keeps both lines and the
    // later one is what was meant.
    expect(sessions.recordFeedback(card!.id, "useful")).toBe("recorded");
    expect(feedback.map((record) => record.verdict)).toEqual(["wrong_moment", "useful"]);
  });

  it("knows a card that was never delivered, and a stage that is still empty", async () => {
    const { sessions } = await replay();

    expect(sessions.recordFeedback("card-cand-999", "useful")).toBe("unknown-card");

    const bare = new SessionManager({
      bus: new EventBus(quiet),
      apiKey: "test-key",
      logger: quiet,
      createStore: () => null,
    });
    expect(bare.recordFeedback("card-cand-1", "useful")).toBe("no-cards");
  });
});

describe("SessionManager, chattiness", () => {
  /** A model that is wired up but never actually asked anything here. */
  const idleModel: ModelClient = {
    async structured(): Promise<never> {
      throw new Error("no call was expected");
    },
    async grounded(): Promise<never> {
      throw new Error("no call was expected");
    },
  };

  it("sets the level with nothing running, and the next session starts there", () => {
    const bus = new EventBus(quiet);
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => null,
      createModel: () => idleModel,
      liveClock: new SimulatedClock(0),
      createAsrClient: ({ onFrame }) => new FakeAsrClient(onFrame),
    });

    expect(sessions.settings()).toEqual({ chattiness: "normal" });
    expect(sessions.setChattiness("quiet")).toEqual({ chattiness: "quiet" });
    expect(bus.settingsState()).toEqual({ chattiness: "quiet" });

    sessions.start({ kind: "wav", fixture: "brainstorm" });
    expect(sessions.interjectionPolicy()?.setting()).toBe("quiet");
  });

  it("changes a running session's policy and its folder", async () => {
    const bus = new EventBus(quiet);
    const settings: unknown[] = [];
    const writer = {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: (saved: unknown) => settings.push(saved),
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: () => {},
      writeArtifact: () => "",
      end: () => {},
    } satisfies SessionWriter;
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => writer,
      createModel: () => idleModel,
      liveClock: new SimulatedClock(0),
      createAsrClient: ({ onFrame }) => new FakeAsrClient(onFrame),
    });

    sessions.start({ kind: "wav", fixture: "brainstorm" });
    // The folder records the level the session started at.
    expect(settings).toEqual([{ chattiness: "normal" }]);

    sessions.setChattiness("active");
    expect(sessions.interjectionPolicy()?.setting()).toBe("active");
    expect(settings).toEqual([{ chattiness: "normal" }, { chattiness: "active" }]);
    // Setting it to what it already is changes nothing and writes nothing.
    sessions.setChattiness("active");
    expect(settings).toHaveLength(2);

    await sessions.stop();
    expect(sessions.interjectionPolicy()).toBeNull();
    // And it outlives the session, for the next one to inherit.
    expect(sessions.settings()).toEqual({ chattiness: "active" });
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
      createStore: () => null,
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

  it("hands a microphone session a MicSource for /ws/audio to write into", async () => {
    let client: FakeAsrClient | undefined;
    const { sessions, events, ended } = harness({
      apiKey: "test-key",
      client: (made) => {
        client = made;
      },
    });
    const done = ended();

    const info = sessions.start({ kind: "mic" });
    expect(info.id).toBe("mic-1");
    const mic = sessions.micInput();
    expect(mic).not.toBeNull();
    expect(events[1]).toEqual({
      type: "status",
      status: {
        channel: "transcription",
        state: "connecting",
        detail: "waiting for the microphone",
      },
    });

    // What the socket delivers reaches the transcription client as chunks.
    mic?.attach();
    mic?.write(Buffer.alloc(AUDIO_CHUNK_BYTES * 2));
    expect(client?.chunks).toBe(2);

    // The browser going away ends the input, and with it the session.
    mic?.endInput();
    await done;
    expect(client?.endReason).toBe("complete");
    expect(sessions.micInput()).toBeNull();
  });

  it("leaves the transcription dot down while a stopped session flushes", async () => {
    let client: FakeAsrClient | undefined;
    const { sessions, bus } = harness({
      apiKey: "test-key",
      client: (made) => {
        client = made;
      },
    });
    sessions.start({ kind: "mic" });
    await sessions.stop();
    expect(bus.status("transcription").state).toBe("idle");

    // The API goes on sending for a moment after `endStream`.
    client?.deliverTurn();
    expect(bus.status("transcription").state).toBe("idle");
  });

  it("has no microphone to write into unless a mic session is running", () => {
    const { sessions } = harness({ apiKey: "test-key" });
    expect(sessions.micInput()).toBeNull();
    sessions.start({ kind: "events", fixture: "brainstorm" });
    expect(sessions.micInput()).toBeNull();
  });

  it("will not start a microphone without an API key", () => {
    const { sessions } = harness();
    try {
      sessions.start({ kind: "mic" });
      expect.unreachable("mic without a key should have thrown");
    } catch (error) {
      expect((error as SessionStartError).status).toBe(503);
    }
  });

  it("shows the transcription dot in error when a session fails", async () => {
    const bus = new EventBus(quiet);
    const failures: string[] = [];
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: { ...quiet, error: (line: string) => failures.push(line) },
      createStore: () => null,
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

describe("SessionManager, speaker names", () => {
  /** Records what reached the session folder, without touching the disk. */
  function recordingWriter(): { renames: [string, string | null][]; writer: SessionWriter } {
    const renames: [string, string | null][] = [];
    const writer = {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: (label: string, name: string | null) => renames.push([label, name]),
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: () => {},
      writeArtifact: () => "",
      end: () => {},
    } satisfies SessionWriter;
    return { renames, writer };
  }

  it("sends a name to the bus and to the session folder", async () => {
    const bus = new EventBus(quiet);
    const { renames, writer } = recordingWriter();
    const sessions = new SessionManager({
      bus,
      logger: quiet,
      createStore: () => writer,
      replaySpeed: "1x",
      wallClock: instantWallClock(),
    });

    sessions.start({ kind: "events", fixture: "brainstorm" });
    expect(sessions.renameSpeaker("A", " Craig ")).toBe(true);

    expect(bus.speakerNames()).toEqual({ A: "Craig" });
    expect(renames).toEqual([["A", " Craig "]]);
    await sessions.stop();
  });

  it("still renames when the session has no folder", async () => {
    const { sessions, bus } = harness();
    sessions.start({ kind: "events", fixture: "brainstorm" });

    expect(sessions.renameSpeaker("B", "Dana")).toBe(true);
    expect(bus.speakerNames()).toEqual({ B: "Dana" });
    await sessions.stop();
  });

  it("has nobody to name when no session is running", () => {
    const { sessions, bus } = harness();
    expect(sessions.renameSpeaker("A", "Craig")).toBe(false);
    expect(bus.speakerNames()).toEqual({});
  });
});
