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
import { MAX_JOBS_PER_WINDOW } from "../../shared/research.js";
import type {
  ResearchGateRecord,
  ResearchIdeaRecord,
  ResearchLogLine,
  ResearchPacketRecord,
  ResearchStartRecord,
} from "../../shared/research.js";
import type { FeedbackLogRecord } from "../../shared/feedback.js";
import { TYPED_ASKER, type AnswerLogRecord } from "../../shared/answers.js";
import type { StageCard } from "../../shared/cards.js";
import type {
  GroundedCall,
  GroundedReply,
  ModelClient,
  ProseCall,
  ProseReply,
  StructuredCall,
} from "../model/client.js";
import { SessionManager, SessionStartError, type AsrClient } from "./SessionManager.js";
import type { SessionWriter } from "./SessionStore.js";
import { emptyModel } from "../test/emptyModel.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";
import { SOTTO_SPEAKER, isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import type { Boldness, Frequency } from "../../shared/policy.js";
import type { VoiceOut, VoiceUtterance } from "../voice/voiceOut.js";
import type { GlimmerClient } from "../model/GlimmerClient.js";
import { DIGEST_SECTIONS } from "./digest.js";
import { WRAP_UP_HEADLINE } from "./WrapUp.js";

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/** Waits for something a stopped session's own clock is still working on. */
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

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
    createModel: () => options.apiKey ? emptyModel : null,
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

/**
 * Glimmer, down to the two methods a session touches (V2-010). `npm test`
 * never dials the local server, so the health answer is canned.
 */
function fakeGlimmer(ok: boolean): GlimmerClient & { warmed: () => number } {
  let warmed = 0;
  return {
    warmed: () => warmed,
    health: async () => ({
      ok,
      latencyMs: 4,
      detail: ok ? "muse-glimmer at 127.0.0.1" : "127.0.0.1 did not answer (ECONNREFUSED)",
    }),
    warm: () => {
      warmed += 1;
    },
    structured: async () => ({}),
  } as unknown as GlimmerClient & { warmed: () => number };
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

    async prose(): Promise<never> {
      throw new Error("unexpected prose call");
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
            headline: `${ScriptedModel.subjects[Math.max(0, this.items - 1) % ScriptedModel.subjects.length]} is unchecked`,
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

  it("looks for candidates as turns arrive without waiting for a board update", async () => {
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
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
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
    expect(observerCalls.length).toBeGreaterThan(boardCalls.length);
    expect(model.calls[0]?.label).toBe("observer");
    expect(observerCalls[0]!.user).toContain("[0:0]");

    const candidates = logged.filter(
      (line): line is CandidateLogRecord => line.kind === "candidate",
    );
    expect(candidates).toHaveLength(observerCalls.length);
    expect(candidates.map((record) => record.candidate.id)).toEqual(
      candidates.map((_, index) => `cand-${index + 1}`),
    );

    // And the policy (US-014) decided about every one of them in the same
    // file. These score 0.6 × 0.5 × 0.9 × 0.7 = 0.19, under `normal`'s glow
    // threshold, so nothing is ever said out loud.
    const decisions = logged.filter(
      (line): line is DecisionLogRecord => line.kind === "decision",
    );
    expect(decisions.map((record) => record.candidateId)).toEqual(
      candidates.filter((record) => record.candidate.duplicateOf === undefined).map((record) => record.candidate.id),
    );
    for (const record of decisions) {
      expect(record.decision).toBe("silent");
      expect(record.reason).toBe("below_threshold");
      expect(record.settings).toEqual({ frequency: "normal", boldness: "normal" });
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
              headline: claims[Math.max(0, this.items - 1) % claims.length]!,
              detail: "The number they are costing this off is wrong.",
              whyNow: "They are about to commit to it",
              evidenceTurnIds: ["0:0"],
              relatedBoardItemIds: [`p${this.items}`],
              scores: { relevance: 0.9, novelty: 0.8, importance: 0.8, confidence: 0.9 },
            },
          ],
        };
      }

      async prose(): Promise<never> {
        throw new Error("nobody asks Sotto anything here");
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
          functionCalls: 0,
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
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
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
    expect(checked).toHaveLength(noticed.filter((record) => record.candidate.duplicateOf === undefined).length);
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

  /**
   * V2-011's routing: a question nobody answered is an interjection like any
   * other, and a research hook leaves the interjection path entirely — it is
   * written down, logged and kept for the research gate (V2-012), and the
   * policy never hears about it.
   */
  it("sends an unanswered question to the policy and a research hook nowhere near it", async () => {
    /** Distinct subjects, so the duplicate rule passes every look on. */
    const subjects = [
      "the food",
      "the projector",
      "the drive home",
      "the Thursday slot",
      "the budget sign-off",
      "the venue deposit",
      "the hotel rooms",
      "the dinner table",
      "the whiteboards",
      "the train tickets",
    ];

    /** One hook and one unanswered question per look, and no board items. */
    class NoticingModel implements ModelClient {
      private looks = 0;
      searches = 0;

      async structured(call: StructuredCall): Promise<unknown> {
        if (call.label === "board") return { operations: [] };
        // V2-012: the planner has nothing to add here, and the gate passes
        // every hook, so the research log shows the whole path.
        if (call.label === "research-planner") return { ideas: [] };
        if (call.label === "research-gate") return { useful: 0.9, unknown: 0.9, answerable: 0.9 };
        this.looks += 1;
        const subject = subjects[(this.looks - 1) % subjects.length];
        const shared = {
          detail: "Nobody came back to it.",
          whyNow: "They are about to move on",
          evidenceTurnIds: ["0:0"],
          relatedBoardItemIds: [],
          scores: { relevance: 0.8, novelty: 0.7, importance: 0.6, confidence: 0.5 },
        };
        return {
          candidates: [
            { ...shared, type: "unanswered_question", headline: `Nobody answered who handles ${subject}` },
            { ...shared, type: "research_hook", headline: `What does ${subject} cost per person?` },
          ],
        };
      }

      async prose(): Promise<never> {
        throw new Error("nobody asks Sotto anything here");
      }

      /** V2-013: a hook is never verified, but an approved idea is searched. */
      async grounded(call: GroundedCall): Promise<GroundedReply> {
        if (call.label !== "research-packet") {
          throw new Error("a hook is never verified");
        }
        this.searches += 1;
        return {
          value: {
            title: `What ${this.searches} costs`,
            teaser: "It costs about the same as the last one.",
            keyPoints: ["About £40 a head"],
            sources: [{ url: "https://example.com/prices", title: "Prices" }],
          },
          citations: [],
          searchedUrls: ["https://example.com/prices"],
          searched: true,
          functionCalls: 0,
        };
      }
    }

    const bus = new EventBus(quiet);
    const lines: CandidateLogLine[] = [];
    const research: ResearchLogLine[] = [];
    const timing: Record<string, unknown>[] = [];
    const packetFiles: { id: string; markdown: string }[] = [];
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
      appendResearch: (record: unknown) => research.push(record as ResearchLogLine),
      writePacket: (id: string, _packet: unknown, markdown: string) =>
        packetFiles.push({ id, markdown }),
      writeDigest: () => {},
      appendTiming: (event: Record<string, unknown>) => timing.push(event),
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
      end: () => {},
    } satisfies SessionWriter;
    const model = new NoticingModel();
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

    const noticed = lines
      .filter((line): line is CandidateLogRecord => line.kind === "candidate")
      .map((record) => record.candidate);
    const hooks = noticed.filter((candidate) => candidate.type === "research_hook");
    const questions = noticed.filter((candidate) => candidate.type === "unanswered_question");
    // Both kinds are written down before anything decides anything.
    expect(hooks.length).toBeGreaterThan(0);
    expect(questions.length).toBeGreaterThan(0);

    const decided = lines.filter((line): line is DecisionLogRecord => line.kind === "decision");
    const passed = new Set(
      questions.filter((candidate) => candidate.duplicateOf === undefined).map((one) => one.id),
    );
    expect(decided.length).toBeGreaterThan(0);
    for (const decision of decided) {
      expect(decision.type).toBe("unanswered_question");
      expect(passed.has(decision.candidateId), `${decision.candidateId} was decided unasked`).toBe(
        true,
      );
    }
    const hookIds = new Set(hooks.map((candidate) => candidate.id));
    for (const decision of decided) {
      expect(hookIds.has(decision.candidateId), "a research hook reached the policy").toBe(false);
    }

    // Each one that got through is in the timing log as a hook, which is the
    // seam the research gate (V2-012) attaches to.
    const passedHooks = hooks.filter((candidate) => candidate.duplicateOf === undefined);
    const logged = timing.filter((event) => event.stage === "research_hook");
    expect(logged.map((event) => event.candidateId)).toEqual(
      passedHooks.map((one) => one.id),
    );

    // V2-012: and each one is an idea in `research.jsonl`, with the gate's
    // verdict beside it.
    const ideas = research.filter(
      (record): record is ResearchIdeaRecord => record.kind === "idea",
    );
    expect(ideas.map((record) => record.candidateId)).toEqual(passedHooks.map((one) => one.id));
    expect(ideas.every((record) => record.origin === "hook")).toBe(true);
    expect(ideas[0]?.idea.question).toBe(passedHooks[0]?.headline);
    const scored = research.filter(
      (record): record is ResearchGateRecord => record.kind === "gate",
    );
    const fresh = ideas.filter((record) => record.duplicateOf === undefined);
    expect(scored.map((record) => record.ideaId)).toEqual(fresh.map((record) => record.idea.id));
    expect(scored.every((record) => record.decision === "queued")).toBe(true);

    // V2-013: and the budget starts three of them, each of which comes back
    // as a sourced packet written into the session folder.
    const starts = research.filter(
      (record): record is ResearchStartRecord => record.kind === "start",
    );
    expect(starts).toHaveLength(MAX_JOBS_PER_WINDOW);
    const packets = research.filter(
      (record): record is ResearchPacketRecord => record.kind === "packet",
    );
    expect(packets).toHaveLength(MAX_JOBS_PER_WINDOW);
    expect(packets.every((record) => record.outcome === "ready")).toBe(true);
    expect(packets.map((record) => record.ideaId)).toEqual(starts.map((record) => record.ideaId));
    expect(packets[0]?.packet?.sources).toEqual([
      { url: "https://example.com/prices", title: "Prices" },
    ]);
    expect(model.searches).toBe(MAX_JOBS_PER_WINDOW);
    expect(packetFiles.map((file) => file.id)).toEqual(["packet-1", "packet-2", "packet-3"]);
    expect(packetFiles[0]?.markdown).toContain("https://example.com/prices");
    // A packet's text is in research.jsonl and in research/<id>.md, so the
    // diagnostic log keeps only its shape.
    const packetTiming = timing.filter((event) => event.stage === "research_packet");
    expect(packetTiming).toHaveLength(MAX_JOBS_PER_WINDOW);
    expect(packetTiming[0]?.packet).toBeUndefined();
    expect(packetTiming[0]?.packetId).toBe("packet-1");
    expect(packetTiming[0]?.sources).toBe(1);
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

    async prose(): Promise<never> {
      throw new Error("nobody asks Sotto anything here");
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
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
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

describe("SessionManager, answers", () => {
  /**
   * `ask-search` is the capture where somebody says Sotto's name and asks a
   * question (US-017), so a replay of it is the whole path: wake watcher ->
   * answer agent -> a card on the stage and a line in `answers.jsonl`.
   *
   * The board loop runs too — a board update is what gives the answer its
   * context — so the model has to answer both kinds of call.
   */
  class AnsweringModel implements ModelClient {
    readonly labels: string[] = [];
    /** The user message of every answer call, to check what it was told. */
    readonly questions: string[] = [];

    async structured(call: StructuredCall): Promise<unknown> {
      this.labels.push(call.label);
      if (call.label === "address") {
        return { kind: "request", question: "what do the main competitors charge per month?" };
      }
      if (call.label === "board") {
        return { operations: [{ op: "set_summary", text: "Pricing a note app." }] };
      }
      // The observer finds nothing here; this fixture plants no moment.
      return { candidates: [] };
    }

    async grounded(): Promise<never> {
      throw new Error("an answer is prose, not JSON");
    }

    async prose(call: ProseCall): Promise<ProseReply> {
      this.labels.push(call.label);
      this.questions.push(call.user);
      // As the real API does: narration first, under an id of its own.
      call.onText?.({ itemId: "rs_1", text: "I'll look that up." });
      // The spoken half first, then the screen half (V2-005): the headline
      // only reaches the stage once the screen heading's first line is whole.
      call.onText?.({
        itemId: "msg_1",
        text: "Say this:\nThey charge five to twenty-five dollars a seat.\n\nShow this:\nRivals charge $5-$25 a seat\n",
      });
      return {
        text:
          "Say this:\nThey charge five to twenty-five dollars a seat.\n\n" +
          "Show this:\nRivals charge $5-$25 a seat\n\n- Notion $12 a seat",
        citations: [{ url: "https://example.com/prices", title: "Prices" }],
        searchedUrls: ["https://example.com/prices"],
        searched: true,
        functionCalls: 0,
      };
    }
  }

  it("answers a spoken question on the stage and writes it down", async () => {
    const bus = new EventBus(quiet);
    const model = new AnsweringModel();
    const answers: AnswerLogRecord[] = [];
    const timing: Record<string, unknown>[] = [];
    const writer = {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: (record: unknown) => answers.push(record as AnswerLogRecord),
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      appendTiming: (record: Record<string, unknown>) => timing.push(record),
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
      end: () => {},
    } satisfies SessionWriter;
    const cards: StageCard[] = [];
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
    });
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => writer,
      createModel: () => model,
      replaySpeed: "max",
      // Real time here, not `instantWallClock`: the address check's
      // six-second deadline runs on the wall clock, and a clock where six
      // seconds pass in a microtask would time every classification out and
      // quietly test the lexical fallback instead. A `max` replay spends no
      // wall time pacing, so this still finishes in a few hundred ms.
      wallClock: systemClock,
    });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "ask-search" });
    await ended;

    // One answer, pushed as it arrived: thinking, then the headline, then all
    // of it — every push under the same card id.
    expect(model.labels.filter((label) => label === "answer")).toHaveLength(1);
    // And one classification, made while the question was still being asked:
    // " Sotto what do the main" arrives 2.1 s before `speechEnd` in this
    // capture, so V2-008b checked it there and the final turn reused the
    // verdict — with its question read off the four words it added (V2-008b).
    expect(model.labels.filter((label) => label === "address")).toHaveLength(1);
    expect(timing).toContainEqual(expect.objectContaining({
      stage: "address_early", event: "started",
    }));
    expect(timing).toContainEqual(expect.objectContaining({
      stage: "address_early", event: "reused", kind: "request", extraWords: 4,
    }));
    expect(timing).not.toContainEqual(expect.objectContaining({ stage: "address_fallback" }));
    expect(new Set(cards.map((card) => card.id))).toEqual(new Set(["card-ans-1"]));
    expect(cards.map((card) => card.state)).toEqual(["thinking", "thinking", "ready"]);
    const last = cards.at(-1)!;
    expect(last.variant).toBe("answer");
    expect(last.headline).toBe("Rivals charge $5-$25 a seat");
    expect(last.detailMd).toBe("- Notion $12 a seat");
    expect(last.citations).toEqual([{ url: "https://example.com/prices", title: "Prices" }]);
    expect(last.question?.toLowerCase()).toContain("competitors charge");
    // The question is asked by a diarization label until the group names it.
    expect(last.askedBy).toMatch(/^[A-Z]$/);

    // The call was told the conversation and the board it was asked in.
    expect(model.questions[0]).toContain("Pricing a note app.");
    expect(model.questions[0]).toContain("competitors charge");

    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      kind: "answer",
      id: "ans-1",
      status: "done",
      headline: "Rivals charge $5-$25 a seat",
    });
    expect(answers[0]?.turnId).not.toBeNull();
    expect(answers[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("SessionManager, Sotto's speech in the transcript (V2-008a)", () => {
  /**
   * A voice that remembers rather than speaks. Enough of {@link VoiceOut} for
   * the answer to count as heard: `npm test` never synthesizes.
   */
  class RecordingVoice implements VoiceOut {
    private count = 0;
    /** Everything each utterance was handed, oldest first. */
    readonly utterances: string[] = [];

    begin(): Promise<VoiceUtterance | null> {
      const parts: string[] = [];
      const id = `v${(this.count += 1)}`;
      const spoken = (): string => parts.join(" ");
      const utterance: VoiceUtterance = {
        id,
        append: (text) => parts.push(text.trim()),
        firstAudioMs: () => (parts.length === 0 ? null : 10),
        cancel: () => {},
        finish: () => {
          this.utterances.push(spoken());
          return Promise.resolve({
            reason: "complete" as const,
            text: spoken(),
            spokenSoFar: spoken(),
            firstAudioMs: parts.length === 0 ? null : 10,
          });
        },
      };
      return Promise.resolve(utterance);
    }
  }

  /** The board and observer calls, so a test can see what each was told. */
  class AnsweringModel implements ModelClient {
    readonly boardCalls: string[] = [];
    readonly observerCalls: string[] = [];

    async structured(call: StructuredCall): Promise<unknown> {
      if (call.label === "address") {
        return { kind: "request", question: "what do the main competitors charge per month?" };
      }
      if (call.label === "board") {
        this.boardCalls.push(call.user);
        return { operations: [{ op: "set_summary", text: "Pricing a note app." }] };
      }
      this.observerCalls.push(call.user);
      return { candidates: [] };
    }

    async grounded(): Promise<never> {
      throw new Error("an answer is prose, not JSON");
    }

    async prose(call: ProseCall): Promise<ProseReply> {
      const text =
        "Say this:\nThey charge five to twenty-five dollars a seat.\n\n" +
        "Show this:\nRivals charge $5-$25 a seat\n\n- Notion $12 a seat";
      call.onText?.({ itemId: "msg_1", text });
      return { text, citations: [], searchedUrls: [], searched: true, functionCalls: 0 };
    }
  }

  it("writes its own answer into the transcript, where the board sees it and the observer does not", async () => {
    const bus = new EventBus(quiet);
    const model = new AnsweringModel();
    const saved: TurnUpdate[] = [];
    const writer = {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: (turn: TurnUpdate) => saved.push(turn),
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: () => {},
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
      end: () => {},
    } satisfies SessionWriter;
    const published: TurnUpdate[] = [];
    bus.subscribe((event) => {
      if (event.type === "turn") published.push(event.turn);
    });
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => writer,
      createModel: () => model,
      createVoice: () => new RecordingVoice(),
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
    sessions.start({ kind: "events", fixture: "ask-search" });
    await ended;

    const said = "They charge five to twenty-five dollars a seat.";
    const mine = published.filter(isSottoTurn);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      turnId: "sotto:ans-1",
      speaker: SOTTO_SPEAKER,
      text: said,
      final: true,
    });
    // On the capture's own timeline, somewhere inside the conversation, not
    // at the server's uptime and not at zero.
    const last = published.filter((turn) => turn.final && !isSottoTurn(turn)).at(-1);
    expect(mine[0]?.startMs).toBeGreaterThan(0);
    expect(mine[0]?.startMs).toBeLessThanOrEqual((last?.endMs ?? 0) + 5_000);
    // And in the session folder's transcript, exactly once.
    expect(saved.filter(isSottoTurn)).toHaveLength(1);

    // The board is told about it, labeled Sotto; the observer never is.
    expect(model.boardCalls.join("\n")).toContain(`${SOTTO_SPEAKER} (`);
    expect(model.boardCalls.join("\n")).toContain(said);
    expect(model.observerCalls.join("\n")).not.toContain(said);
  });
});

describe("SessionManager, typed questions", () => {
  /** Answers anything, and remembers which call was which (US-019). */
  class AnsweringModel implements ModelClient {
    readonly questions: string[] = [];

    async structured(call: StructuredCall): Promise<unknown> {
      return call.label === "board"
        ? { operations: [{ op: "set_summary", text: "Pricing a note app." }] }
        : { candidates: [] };
    }

    async grounded(): Promise<never> {
      throw new Error("an answer is prose, not JSON");
    }

    async prose(call: ProseCall): Promise<ProseReply> {
      this.questions.push(call.user);
      return {
        text: "Eight open questions\n\nFour of them are about pricing.",
        citations: [],
        searchedUrls: [],
        searched: false,
        functionCalls: 0,
      };
    }
  }

  /** A writer that only remembers the answers written to it. */
  function recordingWriter(answers: AnswerLogRecord[]): SessionWriter {
    return {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: (record: unknown) => answers.push(record as AnswerLogRecord),
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
      end: () => {},
    } satisfies SessionWriter;
  }

  /** Resolves when the running session publishes its end. */
  function ends(bus: EventBus): Promise<void> {
    return new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
  }

  it("answers a question typed after Stop, in the session that just ended", async () => {
    const bus = new EventBus(quiet);
    const model = new AnsweringModel();
    const answers: AnswerLogRecord[] = [];
    const cards: StageCard[] = [];
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
    });
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => recordingWriter(answers),
      createModel: () => model,
      replaySpeed: "max",
      wallClock: instantWallClock(),
    });

    // Nothing has run, so there is no conversation to answer in.
    expect(sessions.askQuestion("what did we decide?")).toBe("no-session");

    const ended = ends(bus);
    sessions.start({ kind: "events", fixture: "no-wake" });
    await ended;
    expect(bus.currentSession()).toBeNull();
    expect(cards).toHaveLength(0);

    expect(sessions.askQuestion("what did we decide?")).toBe("asked");
    // The call is on the ended session's clock, so it has to be waited for
    // rather than advanced to.
    await waitFor(() => answers.length > 0, "the answer");

    // Same path as a spoken question: a card on the stage, a line in the
    // folder — only who asked and the missing turn differ.
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      kind: "answer",
      id: "ans-1",
      status: "done",
      askedBy: TYPED_ASKER,
      turnId: null,
      question: "what did we decide?",
      headline: "Eight open questions",
    });
    expect(cards.map((card) => card.state)).toEqual(["thinking", "ready"]);
    expect(cards.at(-1)?.variant).toBe("answer");
    // Answered against the conversation that just ended, not against nothing.
    expect(model.questions[0]).toContain("Pricing a note app.");
    expect(model.questions[0]).not.toContain("nothing has been transcribed yet");
    // It was typed, so the model is not told anybody said it out loud.
    expect(model.questions[0]).toContain("Somebody just typed this question to you");
  });

  it("hands typed questions to the newest session once one starts", async () => {
    const bus = new EventBus(quiet);
    const model = new AnsweringModel();
    const first: AnswerLogRecord[] = [];
    const second: AnswerLogRecord[] = [];
    let opened = 0;
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => {
        opened += 1;
        return recordingWriter(opened === 1 ? first : second);
      },
      createModel: () => model,
      replaySpeed: "max",
      wallClock: instantWallClock(),
    });

    const firstEnded = ends(bus);
    sessions.start({ kind: "events", fixture: "no-wake" });
    await firstEnded;
    const secondEnded = ends(bus);
    sessions.start({ kind: "events", fixture: "no-wake" });
    await secondEnded;

    expect(sessions.askQuestion("what did we decide?")).toBe("asked");
    await waitFor(() => second.length > 0, "the answer");
    // The first session's folder is closed to new questions: its cards left
    // the stage when the second one started.
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });

  it("has nothing to answer with when the server has no model client", async () => {
    const bus = new EventBus(quiet);
    const sessions = new SessionManager({
      bus,
      logger: quiet,
      createStore: () => null,
      createModel: () => null,
      replaySpeed: "max",
      wallClock: instantWallClock(),
    });
    const ended = ends(bus);
    sessions.start({ kind: "events", fixture: "no-wake" });
    await ended;

    expect(sessions.askQuestion("what did we decide?")).toBe("no-model");
  });
});

describe("SessionManager, frequency and boldness", () => {
  /** A model that is wired up but never actually asked anything here. */
  const idleModel: ModelClient = {
    async structured(): Promise<never> {
      throw new Error("no call was expected");
    },
    async grounded(): Promise<never> {
      throw new Error("no call was expected");
    },
    async prose(): Promise<never> {
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

    expect(sessions.settings()).toEqual({
      frequency: "normal",
      boldness: "normal",
      voiceMuted: false,
    });
    // One at a time: turning Sotto down does not also raise its bar.
    expect(sessions.setPolicySettings({ frequency: "rare" })).toEqual({
      frequency: "rare",
      boldness: "normal",
      voiceMuted: false,
    });
    expect(sessions.setPolicySettings({ boldness: "cautious" })).toEqual({
      frequency: "rare",
      boldness: "cautious",
      voiceMuted: false,
    });
    expect(bus.settingsState()).toEqual({
      frequency: "rare",
      boldness: "cautious",
      voiceMuted: false,
    });

    sessions.start({ kind: "wav", fixture: "brainstorm" });
    expect(sessions.interjectionPolicy()?.settings()).toEqual({
      frequency: "rare",
      boldness: "cautious",
    });
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
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
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
    expect(settings).toEqual([{ frequency: "normal", boldness: "normal", voiceMuted: false }]);

    sessions.setPolicySettings({ boldness: "bold" });
    expect(sessions.interjectionPolicy()?.settings()).toEqual({
      frequency: "normal",
      boldness: "bold",
    });
    expect(settings).toEqual([
      { frequency: "normal", boldness: "normal", voiceMuted: false },
      { frequency: "normal", boldness: "bold", voiceMuted: false },
    ]);
    // Setting it to what it already is changes nothing and writes nothing.
    sessions.setPolicySettings({ boldness: "bold" });
    expect(settings).toHaveLength(2);

    await sessions.stop();
    expect(sessions.interjectionPolicy()).toBeNull();
    // And it outlives the session, for the next one to inherit.
    expect(sessions.settings()).toEqual({
      frequency: "normal",
      boldness: "bold",
      voiceMuted: false,
    });
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
      createModel: () => emptyModel,
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
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
      end: () => {},
    } satisfies SessionWriter;
    return { renames, writer };
  }

  it("names a speaker from a final introduction and keeps a manual correction", async () => {
    const bus = new EventBus(quiet);
    const { renames, writer } = recordingWriter();
    let emit: ((record: AsrFrameRecord) => void) | undefined;
    const sessions = new SessionManager({
      bus, apiKey: "test-key", logger: quiet, createStore: () => writer,
      createModel: () => null,
      createAsrClient: ({ onFrame }) => { emit = onFrame; return new FakeAsrClient(onFrame); },
    });
    sessions.start({ kind: "mic" });
    const say = (id: number, text: string): void => {
      for (const frame of [
        { type: "speechStart", turnId: id, audioProcessedMs: id * 1000 },
        { type: "speaker", label: "A", audioProcessedMs: id * 1000 + 100 },
        { type: "speechEnd", turnId: id, audioProcessedMs: id * 1000 + 200 },
        { type: "speechComplete", turnId: id, audioProcessedMs: id * 1000 + 200, transcript: text },
      ]) emit?.({ atMs: frame.audioProcessedMs, session: 0, frame });
    };
    say(1, "I'm Alex, I coordinate the garden.");
    expect(bus.speakerNames()).toEqual({ A: "Alex" });
    expect(renames).toEqual([["A", "Alex"]]);
    sessions.renameSpeaker("A", "Alexander");
    say(2, "I'm Alex, and I agree.");
    expect(bus.speakerNames()).toEqual({ A: "Alexander" });
    expect(renames).toEqual([["A", "Alex"], ["A", "Alexander"]]);
    await sessions.stop();
  });

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

describe("SessionManager and generated artifacts (US-020)", () => {
  /** A model that draws `drawings` times and then answers. */
  class DrawingModel implements ModelClient {
    constructor(private readonly titles: readonly string[]) {}

    async structured(call: StructuredCall): Promise<unknown> {
      return call.label === "board" ? { operations: [] } : { candidates: [] };
    }

    async grounded(): Promise<never> {
      throw new Error("an answer is prose, not JSON");
    }

    async prose(call: ProseCall): Promise<ProseReply> {
      const tool = (call.functions ?? []).find((one) => one.name === "show_html");
      if (tool === undefined) throw new Error("show_html was not offered");
      for (const title of this.titles) await tool.run({ title, html: "<svg/>" });
      return {
        text: "Four screens, end to end\n\nThe loops are at the bottom.",
        citations: [],
        searchedUrls: [],
        searched: false,
        functionCalls: this.titles.length,
      };
    }
  }

  /** A writer that records what was asked of `artifacts/`. */
  function drawingWriter(
    written: [file: string, html: string][],
    options: { dir?: string; fail?: boolean } = {},
  ): SessionWriter {
    return {
      dir: options.dir ?? "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: () => {},
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      writeArtifact: (fileName: string, html: string) => {
        written.push([fileName, html]);
        return options.fail === true ? null : `artifacts/${fileName}`;
      },
      end: () => {},
    } satisfies SessionWriter;
  }

  async function answered(
    model: ModelClient,
    writer: SessionWriter | null,
  ): Promise<{ sessions: SessionManager; cards: StageCard[] }> {
    const bus = new EventBus(quiet);
    const cards: StageCard[] = [];
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
    });
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
    sessions.start({ kind: "events", fixture: "no-wake" });
    await ended;
    expect(sessions.askQuestion("sketch the flow")).toBe("asked");
    await waitFor(() => cards.some((card) => card.state !== "thinking"), "the answer");
    return { sessions, cards };
  }

  it("numbers each artifact in the folder and serves it from that session", async () => {
    const written: [string, string][] = [];
    const { sessions, cards } = await answered(
      new DrawingModel(["User flow", "Screen states"]),
      drawingWriter(written, { dir: "/tmp/session-folder" }),
    );

    expect(written).toEqual([
      ["01-user-flow.html", "<svg/>"],
      ["02-screen-states.html", "<svg/>"],
    ]);
    expect(cards.at(-1)?.artifacts).toEqual([
      {
        title: "User flow",
        url: "/api/sessions/events-no-wake-1/artifacts/01-user-flow.html",
      },
      {
        title: "Screen states",
        url: "/api/sessions/events-no-wake-1/artifacts/02-screen-states.html",
      },
    ]);
    expect(sessions.artifactFile("events-no-wake-1", "01-user-flow.html")).toBe(
      "/tmp/session-folder/artifacts/01-user-flow.html",
    );
  });

  it("has no artifact for a name it never wrote, a bad name or another session", async () => {
    const { sessions } = await answered(
      new DrawingModel(["User flow"]),
      drawingWriter([], { dir: "/tmp/session-folder" }),
    );
    for (const name of ["../session.json", "..", "board.md", "1-user-flow.html", ""]) {
      expect(sessions.artifactFile("events-no-wake-1", name), name).toBeNull();
    }
    expect(sessions.artifactFile("events-brainstorm-1", "01-user-flow.html")).toBeNull();
  });

  it("shows nothing when the session has no folder, and answers in words", async () => {
    const { cards } = await answered(new DrawingModel(["User flow"]), null);
    expect(cards.at(-1)?.artifacts).toBeUndefined();
    expect(cards.at(-1)?.headline).toBe("Four screens, end to end");
  });

  it("shows nothing when the folder refused the write", async () => {
    const written: [string, string][] = [];
    const { sessions, cards } = await answered(
      new DrawingModel(["User flow"]),
      drawingWriter(written, { fail: true }),
    );
    expect(written).toHaveLength(1);
    expect(cards.at(-1)?.artifacts).toBeUndefined();
    // The number was spent even though the file was not written, so a retry
    // is `02` rather than a second `01`. The name still resolves to a path;
    // nothing points at it, and the route answers 404 because it is not there.
    expect(sessions.artifactFile("events-no-wake-1", "01-user-flow.html")).toBe(
      "/tmp/not-a-real-folder/artifacts/01-user-flow.html",
    );
  });
});

describe("SessionManager, the opening hello (V2-009)", () => {
  /** A voice that remembers every utterance; `npm test` never synthesizes. */
  class RecordingVoice implements VoiceOut {
    private count = 0;
    readonly utterances: string[] = [];

    begin(): Promise<VoiceUtterance | null> {
      const parts: string[] = [];
      const id = `v${(this.count += 1)}`;
      const spoken = (): string => parts.join(" ");
      return Promise.resolve({
        id,
        append: (text: string) => parts.push(text.trim()),
        firstAudioMs: () => (parts.length === 0 ? null : 10),
        cancel: () => {},
        finish: () => {
          this.utterances.push(spoken());
          return Promise.resolve({
            reason: "complete" as const,
            text: spoken(),
            spokenSoFar: spoken(),
            firstAudioMs: parts.length === 0 ? null : 10,
          });
        },
      });
    }
  }

  /** Every board prompt a session sent, so the hello can be checked out of it. */
  class WatchingModel implements ModelClient {
    readonly boardCalls: string[] = [];

    async structured(call: StructuredCall): Promise<unknown> {
      if (call.label === "board") this.boardCalls.push(call.user);
      return call.label === "board" ? { operations: [] } : { candidates: [] };
    }
    async grounded(): Promise<never> {
      throw new Error("nothing to check");
    }
    async prose(): Promise<never> {
      throw new Error("nothing to answer");
    }
  }

  function live(voice: VoiceOut | null) {
    const bus = new EventBus(quiet);
    const cards: StageCard[] = [];
    const turnsSeen: TurnUpdate[] = [];
    const saved: TurnUpdate[] = [];
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
      if (event.type === "turn") turnsSeen.push(event.turn);
    });
    const model = new WatchingModel();
    const clock = new SimulatedClock(0);
    const writer = {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: (turn: TurnUpdate) => saved.push(turn),
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: () => {},
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
      end: () => {},
    } satisfies SessionWriter;
    let client: FakeAsrClient | undefined;
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => writer,
      createModel: () => model,
      createVoice: () => voice,
      liveClock: clock,
      createAsrClient: ({ onFrame }) => {
        client = new FakeAsrClient(onFrame);
        return client;
      },
    });
    return { bus, sessions, cards, turnsSeen, saved, model, clock, client: () => client };
  }

  it("says it out loud and writes it into the transcript, but not onto the board", async () => {
    const voice = new RecordingVoice();
    const t = live(voice);
    t.sessions.start({ kind: "wav", fixture: "brainstorm" });
    await waitFor(() => voice.utterances.length === 1, "the hello to be said");

    expect(voice.utterances[0]).toBe(loadPrompt(PROMPTS.hello));
    // Spoken, so the stage stays empty.
    expect(t.cards).toEqual([]);

    const mine = t.turnsSeen.filter(isSottoTurn);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      turnId: "sotto:hello",
      speaker: SOTTO_SPEAKER,
      text: loadPrompt(PROMPTS.hello),
      final: true,
    });
    expect(t.saved.filter(isSottoTurn)).toHaveLength(1);

    // The board never hears it: the hello establishes nothing (V2-009).
    t.client()?.deliverTurn();
    await t.sessions.stop();
    await waitFor(() => t.model.boardCalls.length > 0, "a board update");
    expect(t.model.boardCalls.join("\n")).not.toContain("just say");
  });

  it("shows it as a card when there is nowhere to say it, and writes no turn", async () => {
    const t = live({ begin: async () => null });
    t.sessions.start({ kind: "wav", fixture: "brainstorm" });
    await waitFor(() => t.cards.length === 1, "the hello card");

    expect(t.cards[0]).toMatchObject({
      id: "notice-hello",
      variant: "notice",
      state: "ready",
      headline: loadPrompt(PROMPTS.hello),
    });
    expect(t.turnsSeen.filter(isSottoTurn)).toEqual([]);
    await t.sessions.stop();
  });

  it("never greets an events replay: that conversation already happened", async () => {
    const { sessions, events, ended } = harness({ apiKey: "test-key" });
    const done = ended();
    sessions.start({ kind: "events", fixture: "moment-fact" });
    await done;
    expect(events.filter((event) => event.type === "card")).toEqual([]);
    expect(turns(events).filter(isSottoTurn)).toEqual([]);
  });
});

describe("SessionManager, judgment (V2-010)", () => {
  /**
   * Lets the health check's own microtasks run, and nothing else: a session
   * that is stopped first never publishes where its judgment went, which is
   * the point of {@link JudgmentRouter.stop}.
   */
  async function settled(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** Just the judgment dot, in the order it changed. */
  function dots(events: ServerEvent[]): string[] {
    return events
      .filter((event) => event.type === "status" && event.status.channel === "judgment")
      .map((event) =>
        event.type === "status"
          ? `${event.status.state}${event.status.detail === undefined ? "" : `:${event.status.detail}`}`
          : "",
      );
  }

  function judged(glimmer: GlimmerClient | null): {
    bus: EventBus;
    sessions: SessionManager;
    events: ServerEvent[];
    warnings: string[];
  } {
    const bus = new EventBus(quiet);
    const events: ServerEvent[] = [];
    const warnings: string[] = [];
    bus.subscribe((event) => events.push(event));
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: { ...quiet, warn: (line: string) => warnings.push(line) },
      createStore: () => null,
      createModel: () => emptyModel,
      createGlimmer: () => glimmer,
      replaySpeed: "max",
      wallClock: instantWallClock(),
    });
    return { bus, sessions, events, warnings };
  }

  it("checks Glimmer at session start and judges locally when it answers", async () => {
    const glimmer = fakeGlimmer(true);
    const { sessions, events } = judged(glimmer);

    sessions.start({ kind: "events", fixture: "moment-fact" });
    // The dot cannot say where until the check comes back, so start() leaves
    // it checking rather than waiting for an answer.
    expect(dots(events)).toEqual(["connecting"]);
    await settled();
    await sessions.stop();

    // Checking, then where it landed, then idle when the session has gone —
    // a `max` replay of one fixture is over almost at once.
    expect(dots(events)).toEqual(["connecting", "active:local", "idle"]);
    // And the cold load is paid before any role needs a verdict.
    expect(glimmer.warmed()).toBe(1);
  });

  it("warns and judges in the cloud when Glimmer is not there", async () => {
    const glimmer = fakeGlimmer(false);
    const { sessions, events, warnings } = judged(glimmer);

    sessions.start({ kind: "events", fixture: "moment-fact" });
    await settled();
    await sessions.stop();

    expect(dots(events)).toEqual(["connecting", "active:cloud", "idle"]);
    expect(warnings.join("\n")).toMatch(/Glimmer is unavailable.*Muse Spark/s);
    expect(glimmer.warmed()).toBe(0);
  });

  it("judges in the cloud when no Glimmer is configured", async () => {
    const { sessions, events } = judged(null);

    sessions.start({ kind: "events", fixture: "moment-fact" });
    // Nothing to check, so the dot is already answered when start() returns.
    expect(dots(events)).toEqual(["connecting", "active:cloud"]);
    await sessions.stop();

    expect(dots(events)).toEqual(["connecting", "active:cloud", "idle"]);
  });
});

describe("SessionManager, the digest (V2-018)", () => {
  /**
   * A voice that remembers rather than speaks, like the V2-008a block's:
   * `npm test` never synthesizes anything.
   */
  class RecordingVoice implements VoiceOut {
    private count = 0;
    readonly utterances: string[] = [];

    begin(): Promise<VoiceUtterance | null> {
      const parts: string[] = [];
      const id = `v${(this.count += 1)}`;
      const spoken = (): string => parts.join(" ");
      return Promise.resolve({
        id,
        append: (text) => parts.push(text.trim()),
        firstAudioMs: () => (parts.length === 0 ? null : 10),
        cancel: () => {},
        finish: () => {
          this.utterances.push(spoken());
          return Promise.resolve({
            reason: "complete" as const,
            text: spoken(),
            spokenSoFar: spoken(),
            firstAudioMs: parts.length === 0 ? null : 10,
          });
        },
      });
    }
  }

  /**
   * Notices one thing, keeps a board, and classifies whatever is said to
   * Sotto as `request` with `question`. The question is the test's lever:
   * `ask-search`'s wake line becomes whatever this returns.
   */
  class DigestModel implements ModelClient {
    readonly labels: string[] = [];
    private addressCalls = 0;

    constructor(private readonly question: string) {}

    async structured(call: StructuredCall): Promise<unknown> {
      this.labels.push(call.label);
      if (call.label === "address") {
        // The early check (V2-008b) says the name is all it has heard, so the
        // final turn is classified again rather than reusing the verdict —
        // which is also the one path where the model's own wording of the
        // request is what reaches the wake watcher, and this test is about
        // the wording.
        this.addressCalls += 1;
        return this.addressCalls === 1
          ? { kind: "name_only", question: "" }
          : { kind: "request", question: this.question };
      }
      if (call.label === "board") {
        return {
          operations: [
            { op: "set_summary", text: "Pricing a note app." },
            { op: "add_decision", text: "Charge per seat", sourceTurnIds: [] },
            { op: "add_question", text: "Who owns onboarding?", sourceTurnIds: [] },
          ],
        };
      }
      if (call.label === "gate") {
        return { true: 0.9, new: 0.9, worthSaying: 0.2, stillRelevant: 0.9 };
      }
      if (call.label === "observer") {
        return {
          candidates: [
            {
              type: "untested_assumption",
              headline: "Nobody has checked what rivals charge",
              detail: "The plan rests on a price nobody has looked up.",
              whyNow: "The price is being set",
              evidenceTurnIds: [],
              relatedBoardItemIds: [],
              scores: { relevance: 0.9, novelty: 0.9, importance: 0.2, confidence: 0.9 },
            },
          ],
        };
      }
      return { candidates: [] };
    }

    async grounded(): Promise<never> {
      throw new Error("not used here");
    }

    async prose(call: ProseCall): Promise<ProseReply> {
      this.labels.push(call.label);
      const text =
        "Say this:\nThey charge five to twenty-five dollars a seat.\n\n" +
        "Show this:\nRivals charge $5-$25 a seat\n\n- Notion $12 a seat";
      call.onText?.({ itemId: "msg_1", text });
      return { text, citations: [], searchedUrls: [], searched: true, functionCalls: 0 };
    }
  }

  function replay(question: string): {
    model: DigestModel;
    voice: RecordingVoice;
    digests: string[];
    cards: StageCard[];
    done: Promise<void>;
  } {
    const bus = new EventBus(quiet);
    const model = new DigestModel(question);
    const voice = new RecordingVoice();
    const digests: string[] = [];
    const cards: StageCard[] = [];
    const writer = {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: () => {},
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: (markdown: string) => digests.push(markdown),
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
      end: () => {},
    } satisfies SessionWriter;
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
    });
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => writer,
      createModel: () => model,
      createVoice: () => voice,
      replaySpeed: "max",
      // Real time: the address check's deadline is on the wall clock.
      wallClock: systemClock,
    });
    const done = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "ask-search" });
    return { model, voice, digests, cards, done };
  }

  it("writes digest.md once, with all seven sections filled in from the session", async () => {
    const run = replay("what do the main competitors charge per month?");
    await run.done;

    expect(run.digests).toHaveLength(1);
    const digest = run.digests[0] ?? "";
    for (const section of DIGEST_SECTIONS) expect(digest).toContain(`## ${section}`);
    // The board's own three sections.
    expect(digest).toContain("Pricing a note app.");
    expect(digest).toContain("- Charge per seat");
    expect(digest).toContain("- Who owns onboarding?");
    // What Sotto said, and what it decided not to.
    expect(digest).toContain("They charge five to twenty-five dollars a seat.");
    expect(digest).toContain("**Nobody has checked what rivals charge** — below threshold");
  });

  it("wraps up from the digest instead of asking the model, when asked to", async () => {
    const run = replay("wrap us up");
    await run.done;

    // No answer call at all: the summary was already in hand.
    expect(run.model.labels).not.toContain("answer");
    const said = run.voice.utterances.join("\n");
    expect(said).toContain("Here's where we got to.");
    expect(said).toContain("Charge per seat");
    expect(said).toContain("Who owns onboarding?");
    // And it is in the digest's account of what Sotto said.
    expect(run.digests[0]).toContain("“wrap us up” —");
    expect(run.digests[0]).toContain(WRAP_UP_HEADLINE);
  });

  it("wraps up for a question typed into the box, while the session is running", async () => {
    const bus = new EventBus(quiet);
    const model = new DigestModel("never asked");
    const voice = new RecordingVoice();
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => null,
      createModel: () => model,
      createVoice: () => voice,
      // 1x, because a `max` replay finishes inside `start()` and a wrap-up is
      // addressed to a conversation that is still going on.
      replaySpeed: "1x",
      wallClock: systemClock,
    });
    sessions.start({ kind: "events", fixture: "ask-search" });
    expect(sessions.askQuestion("wrap us up")).toBe("asked");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sessions.stop();

    expect(model.labels).not.toContain("answer");
    expect(voice.utterances.join("\n")).toContain("wrap up yet");
  });
});

describe("SessionManager, what the room wonders aloud (V3-002)", () => {
  /**
   * A model that answers the question classifier and nothing else, so the
   * replay exercises the wiring rather than a judgment: every
   * question-shaped turn of `offsite-plan` comes back `open_question`.
   */
  class WonderingModel implements ModelClient {
    readonly labels: string[] = [];
    /** Every turn the classifier was asked about, newest last. */
    readonly asked: string[] = [];

    async structured(call: StructuredCall): Promise<unknown> {
      this.labels.push(call.label);
      if (call.label === "question") {
        this.asked.push(call.user);
        return {
          kind: "open_question",
          question: "How long is the drive to the farmhouse?",
          topic: "the drive time",
        };
      }
      if (call.label === "address") return { kind: "mention", question: "" };
      if (call.label === "board") return { operations: [] };
      if (call.label === "research-planner") return { ideas: [] };
      return { candidates: [] };
    }

    async grounded(): Promise<never> {
      throw new Error("a question classification is not grounded");
    }

    async prose(): Promise<never> {
      throw new Error("V3-002 classifies a question; it does not answer one");
    }
  }

  function timingWriter(timing: Record<string, unknown>[]): SessionWriter {
    return {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: () => {},
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      appendTiming: (record: Record<string, unknown>) => timing.push(record),
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
      end: () => {},
    } satisfies SessionWriter;
  }

  /** A voice that keeps every utterance, so a replay can be read back. */
  class ClaimingVoice implements VoiceOut {
    private count = 0;
    readonly utterances: string[] = [];

    begin(): Promise<VoiceUtterance | null> {
      const parts: string[] = [];
      const id = `v${(this.count += 1)}`;
      const spoken = (): string => parts.join(" ");
      return Promise.resolve({
        id,
        append: (text) => parts.push(text.trim()),
        firstAudioMs: () => (parts.length === 0 ? null : 10),
        cancel: () => {},
        finish: () => {
          this.utterances.push(spoken());
          return Promise.resolve({
            reason: "complete" as const,
            text: spoken(),
            spokenSoFar: spoken(),
            firstAudioMs: parts.length === 0 ? null : 10,
          });
        },
      });
    }
  }

  it("classifies the question-shaped turns of a replay and writes them down", async () => {
    const bus = new EventBus(quiet);
    const model = new WonderingModel();
    const timing: Record<string, unknown>[] = [];
    const cards: StageCard[] = [];
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
    });
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => timingWriter(timing),
      createModel: () => model,
      replaySpeed: "max",
      // The six-second deadline is on the wall clock; a `max` replay spends
      // no wall time pacing, so the real one still finishes in a moment.
      wallClock: systemClock,
    });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "offsite-plan" });
    await ended;

    // Ten of the conversation's 37 turns are question-shaped, and the one
    // that says Sotto's name is the address path's, so nine reach the model.
    const classified = timing.filter((record) => record["stage"] === "question");
    expect(classified).toHaveLength(9);
    expect(model.labels.filter((label) => label === "question")).toHaveLength(9);
    expect(timing).toContainEqual(expect.objectContaining({
      stage: "question_skipped", reason: "addressed",
    }));
    // The classifier is given the previous turns by name, not just the latest.
    expect(model.asked.at(-1)).toContain("Previous turns:");
    expect(classified[0]).toMatchObject({ kind: "open_question" });
    expect(classified[0]?.["latencyMs"]).toBeGreaterThanOrEqual(0);

    // Every verdict is a record of its own, and nothing else: an open
    // question is not a candidate, so it reaches no card and no policy.
    const wondered = timing.filter((record) => record["stage"] === "open_question");
    expect(wondered).toHaveLength(9);
    expect(wondered[0]).toMatchObject({ topic: "the drive time" });
    expect(cards.filter((card) => card.variant === "interject")).toEqual([]);
    expect(cards.filter((card) => card.variant === "glow")).toEqual([]);
  }, 60_000);

  it("spends no call at all on a conversation with no questions in it", async () => {
    const bus = new EventBus(quiet);
    const model = new WonderingModel();
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => null,
      createModel: () => model,
      replaySpeed: "max",
      wallClock: systemClock,
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

    // `moment-fact` is a conversation about a date somebody got wrong; two of
    // its 24 turns are shaped like a question (8%), which is the whole point
    // of the pre-filter.
    expect(model.labels.filter((label) => label === "question")).toHaveLength(2);
  }, 60_000);

  /**
   * The same model, with a search that comes back — which is what a claim
   * needs. In a `max` replay simulated time does not move inside
   * `clock.track`, so the search *always* finishes before the claim's pause
   * timer can fire; a model whose `grounded` throws therefore tests the
   * overtaken rule rather than the claim (`Reservations.test.ts` has both).
   */
  class SearchingModel implements ModelClient {
    readonly labels: string[] = [];

    async structured(call: StructuredCall): Promise<unknown> {
      this.labels.push(call.label);
      if (call.label === "question") {
        return {
          kind: "open_question",
          question: "How long is the drive to the farmhouse?",
          topic: "the drive time",
        };
      }
      if (call.label === "address") return { kind: "mention", question: "" };
      if (call.label === "board") return { operations: [] };
      if (call.label === "research-planner") return { ideas: [] };
      // V3-004: the room is still on the venue, so the answer is worth saying.
      if (call.label === "still-current") {
        return { verdict: "current", agrees: false, why: "still planning the day" };
      }
      return { candidates: [] };
    }

    async grounded(call: GroundedCall): Promise<GroundedReply> {
      this.labels.push(call.label);
      return {
        value: {
          title: "About two hours fifteen",
          teaser: "The quickest route is two hours ten without traffic.",
          keyPoints: ["Two hours ten via the motorway"],
          spokenAnswer: "It's about two and a quarter hours.",
          sources: [{ url: "https://maps.example.com/route", title: "Route" }],
        },
        citations: [],
        searchedUrls: ["https://maps.example.com/route"],
        searched: true,
        functionCalls: 0,
      };
    }

    async prose(): Promise<never> {
      throw new Error("a reservation is written locally, never asked for");
    }
  }

  /**
   * V3-015, through the whole pipeline: the question the classifier noticed
   * is claimed out loud at the next gap, and the line goes into the
   * transcript as Sotto's.
   *
   * One claim, not nine: the eight repeats of the same question are
   * duplicates of an idea already running (V3-003), and a duplicate starts no
   * search and claims nothing.
   */
  it("claims the question out loud and writes the line into the transcript", async () => {
    const bus = new EventBus(quiet);
    const model = new SearchingModel();
    const timing: Record<string, unknown>[] = [];
    const voice = new ClaimingVoice();
    const published: TurnUpdate[] = [];
    bus.subscribe((event) => {
      if (event.type === "turn") published.push(event.turn);
    });
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => timingWriter(timing),
      createModel: () => model,
      createVoice: () => voice,
      replaySpeed: "max",
      wallClock: systemClock,
    });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "offsite-plan" });
    await ended;

    const contributions = timing.filter(
      (record) => record["stage"] === "spoken_contribution",
    );
    const claims = contributions.filter((record) => record["kind"] === "reserve");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: "reserve",
      spoken: true,
      text: "I'll check the drive time.",
      yielded: false,
    });
    expect(claims[0]?.["questionToReserveMs"]).toBeGreaterThanOrEqual(0);

    // The search came back, so there is nothing to apologise for.
    expect(contributions.filter((record) => record["kind"] === "no_answer")).toEqual([]);

    // It was really said, and it is in the transcript as Sotto's (V2-008a).
    expect(voice.utterances).toContain("I'll check the drive time.");
    const mine = published.filter(isSottoTurn).map((turn) => turn.text);
    expect(mine).toContain("I'll check the drive time.");
  }, 60_000);

  /**
   * V3-004 through the whole pipeline: the packet the fast path produced is
   * spoken to the room at a real pause, after the claim and never before it,
   * and the card is still there with its sources.
   */
  it("speaks the answer to the room and leaves the card with its sources", async () => {
    const bus = new EventBus(quiet);
    const model = new SearchingModel();
    const timing: Record<string, unknown>[] = [];
    const voice = new ClaimingVoice();
    const published: TurnUpdate[] = [];
    const cards: StageCard[] = [];
    bus.subscribe((event) => {
      if (event.type === "turn") published.push(event.turn);
      if (event.type === "card") cards.push(event.card);
    });
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => timingWriter(timing),
      createModel: () => model,
      createVoice: () => voice,
      replaySpeed: "max",
      wallClock: systemClock,
    });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "offsite-plan" });
    await ended;

    const answers = timing.filter(
      (record) => record["stage"] === "spoken_contribution" && record["kind"] === "answer",
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      kind: "answer",
      spoken: true,
      text: "On the drive time: It's about two and a quarter hours.",
      yielded: false,
    });
    expect(answers[0]?.["questionToSpeechMs"]).toBeGreaterThanOrEqual(0);
    // The verdict it decided on was the cached one (V3-004) — and in a `max`
    // replay it is the no-call one: simulated time stands still inside the
    // search, so no final turn arrives between the question and the packet,
    // and "nobody has spoken since" needs no model.
    expect(answers[0]?.["stillCurrent"]).toMatchObject({
      verdict: "current",
      latencyMs: 0,
      turns: 0,
    });

    // Said out loud, and in the transcript as Sotto's, after the claim.
    const mine = published.filter(isSottoTurn).map((turn) => turn.text);
    expect(mine.indexOf("I'll check the drive time.")).toBeLessThan(
      mine.indexOf("On the drive time: It's about two and a quarter hours."),
    );
    // And the card is still the card, with the pages behind it.
    const research = cards.filter((card) => card.variant === "research");
    expect(research.at(-1)?.citations?.map((one) => one.url)).toEqual([
      "https://maps.example.com/route",
    ]);

    // The question is closed out, so the still-current watcher stops paying
    // for verdicts about it: the rest of the conversation is 20 more final
    // turns, and a run that left it watching made fifty checks.
    const checks = timing.filter((record) => record["stage"] === "still_current");
    expect(checks.length).toBeLessThan(4);
  }, 60_000);
});

describe("SessionManager, Sotto's own corrections (V3-008)", () => {
  /**
   * A model that notices one wrong date, and a web check that agrees it is
   * wrong — the only candidate in the six kinds that may ever be spoken.
   */
  class CorrectingModel implements ModelClient {
    readonly labels: string[] = [];
    private offered = false;

    async structured(call: StructuredCall): Promise<unknown> {
      this.labels.push(call.label);
      if (call.label === "address") return { kind: "mention", question: "" };
      if (call.label === "board") return { operations: [] };
      if (call.label === "research-planner") return { ideas: [] };
      if (call.label === "question") return { kind: "none", question: "", topic: "" };
      if (call.label === "still-current") {
        return { verdict: "current", agrees: false, why: "still costing the timeline" };
      }
      if (call.label === "observer" && !this.offered) {
        this.offered = true;
        return {
          candidates: [
            {
              type: "factual_error",
              headline: "Instagram launched in 2010, not 2014",
              detail: "The launch was October 2010, four years earlier.",
              whyNow: "the timeline is being costed off that year",
              evidenceTurnIds: ["0:3"],
              relatedBoardItemIds: [],
              scores: { relevance: 0.95, novelty: 0.9, importance: 0.9, confidence: 0.9 },
            },
          ],
        };
      }
      return { candidates: [] };
    }

    async grounded(call: GroundedCall): Promise<GroundedReply> {
      this.labels.push(call.label);
      if (call.label !== "verify") throw new Error(`no grounded call for ${call.label}`);
      return {
        value: {
          verdict: "wrong",
          correction: "Instagram launched in October 2010.",
          citations: [{ url: "https://example.com/instagram", title: "Instagram" }],
        },
        citations: [{ url: "https://example.com/instagram", title: "Instagram" }],
        searchedUrls: ["https://example.com/instagram"],
        searched: true,
        functionCalls: 0,
      };
    }

    async prose(): Promise<never> {
      throw new Error("a correction is one sentence, written locally");
    }
  }

  function timingWriter(timing: Record<string, unknown>[]): SessionWriter {
    return {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: () => {},
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      appendTiming: (record: Record<string, unknown>) => timing.push(record),
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
      end: () => {},
    } satisfies SessionWriter;
  }

  /** A voice that keeps every utterance, so a replay can be read back. */
  class SpeakingVoice implements VoiceOut {
    private count = 0;
    readonly utterances: string[] = [];

    begin(): Promise<VoiceUtterance | null> {
      const parts: string[] = [];
      const id = `v${(this.count += 1)}`;
      const spoken = (): string => parts.join(" ");
      return Promise.resolve({
        id,
        append: (text) => parts.push(text.trim()),
        firstAudioMs: () => (parts.length === 0 ? null : 10),
        cancel: () => {},
        finish: () => {
          this.utterances.push(spoken());
          return Promise.resolve({
            reason: "complete" as const,
            text: spoken(),
            spokenSoFar: spoken(),
            firstAudioMs: parts.length === 0 ? null : 10,
          });
        },
      });
    }
  }

  /** One `moment-fact` replay, with the boldness the session is set to. */
  async function replay(boldness: Boldness): Promise<{
    cards: StageCard[];
    timing: Record<string, unknown>[];
    voice: SpeakingVoice;
    turns: TurnUpdate[];
  }> {
    const bus = new EventBus(quiet);
    const timing: Record<string, unknown>[] = [];
    const cards: StageCard[] = [];
    const turns: TurnUpdate[] = [];
    const voice = new SpeakingVoice();
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
      if (event.type === "turn") turns.push(event.turn);
    });
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => timingWriter(timing),
      createModel: () => new CorrectingModel(),
      createVoice: () => voice,
      replaySpeed: "max",
      wallClock: systemClock,
    });
    sessions.setPolicySettings({ boldness });
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
    return { cards, timing, voice, turns };
  }

  it("shows the correction and says nothing at the default boldness", async () => {
    const run = await replay("normal");

    const correction = run.cards.find((card) => card.headline.includes("Instagram"));
    expect(correction).toBeDefined();
    // V3-017's hand: Sotto is holding this, and the room can call on it.
    expect(correction?.raised).toBe(true);
    expect(run.voice.utterances).toEqual([]);
    expect(
      run.timing.filter((record) => record["stage"] === "spoken_contribution"),
    ).toEqual([]);
    expect(run.turns.filter((turn) => isSottoTurn(turn))).toEqual([]);
  }, 60_000);

  it("says the verified one in a sentence when the room asked for bold", async () => {
    const run = await replay("bold");

    expect(run.voice.utterances).toEqual([
      "Quick correction: Instagram launched in 2010, not 2014.",
    ]);
    const spoken = run.timing.filter(
      (record) => record["stage"] === "spoken_contribution",
    );
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({
      kind: "correction",
      candidateId: "cand-1",
      spoken: true,
      yielded: false,
      text: "Quick correction: Instagram launched in 2010, not 2014.",
    });
    // The card is still there, and no longer a raised hand: it was said.
    const correction = run.cards.find((card) => card.headline.includes("Instagram"));
    expect(correction?.raised).toBeUndefined();
    // And the line is in the transcript as Sotto's (V2-008a).
    const sotto = run.turns.filter((turn) => isSottoTurn(turn));
    expect(sotto.map((turn) => turn.text)).toContain(
      "Quick correction: Instagram launched in 2010, not 2014.",
    );
  }, 60_000);
});

/**
 * V3-013 through the whole pipeline: a decision the group settles out loud is
 * read back at the next real pause, with the room's own unsettled question on
 * it — and one of Sotto's own corrections is pinned to the stage beside the
 * decision it bears on rather than said.
 *
 * `decision-closings` settles three things. The first (the launch costs) only
 * Sotto sees a problem with, so at the default boldness that read-back loses
 * its attachment and, being bare, is not said at `normal` frequency at all.
 * The second (six sheds) is the one the group itself raised a question about
 * and dropped. The third (paper sheets) has nothing hanging off it.
 */
describe("SessionManager: read-backs at decision points (V3-013)", () => {
  /**
   * A model that settles decisions and notices one thing, or both.
   *
   * One at a time by default, because a contradiction the policy delivers is
   * an interject, and an interject spends the frequency's cooldown (V2-017) —
   * so a session that has just put a card up cannot also read a decision back
   * fifty seconds later. That interaction is real and has a test of its own
   * below; it would otherwise hide every other assertion here.
   */
  class DecidingModel implements ModelClient {
    readonly labels: string[] = [];
    private sawCost = false;
    private sawRisk = false;

    constructor(private readonly notices: "cost" | "risk" | "both" = "both") {}

    async structured(call: StructuredCall): Promise<unknown> {
      this.labels.push(call.label);
      if (call.label === "address") return { kind: "mention", question: "" };
      if (call.label === "board") return { operations: [] };
      if (call.label === "research-planner") return { ideas: [] };
      if (call.label === "still-current") {
        return { verdict: "current", agrees: false, why: "still on the sheds" };
      }
      if (call.label === "question") return this.classify(call.user);
      if (call.label === "observer") return this.look(call.user);
      return { candidates: [] };
    }

    /** The three closings, read off the latest turn the way Spark would. */
    private classify(user: string): unknown {
      const latest = user.slice(user.lastIndexOf("LATEST turn:"));
      const decision = latest.includes("lock that in")
        ? "Saturday the 14th, mechanic and coffee cart"
        : latest.includes("we're agreed")
          ? "six sheds, one per association"
          : latest.includes("go with paper sheets")
            ? "paper sheets, typed up monthly"
            : "";
      return decision === ""
        ? { kind: "none", question: "", topic: "", closing: false, decision: "" }
        : { kind: "decision", question: "", topic: "", closing: true, decision };
    }

    /**
     * Two candidates, each on the first look that can see what it rests on:
     * the overspend is stated at line 7 and the risk at line 13, both a board
     * update before the decision they bear on.
     */
    private look(user: string): unknown {
      const cite = (fragment: string): string =>
        user.match(new RegExp(`\\[([^\\]]+)\\][^\\n]*${fragment}`))?.[1] ?? "0:0";
      const wants = this.notices;
      if (wants !== "risk" && !this.sawCost && user.includes("wants 300 for the day")) {
        this.sawCost = true;
        return {
          candidates: [
            {
              type: "contradiction",
              // Phrased the way V3-008 asks for: a question tied to what was
              // just said, which is also what makes it match the decision.
              headline: "Before the mechanic and the coffee cart: where does the 450 come from?",
              detail: "1200 of kits and 100 of insurance leaves 100 of the 1400, not 450.",
              whyNow: "the launch costs are being agreed",
              evidenceTurnIds: [cite("wants 300 for the day")],
              relatedBoardItemIds: [],
              scores: { relevance: 0.9, novelty: 0.9, importance: 0.9, confidence: 0.9 },
            },
          ],
        };
      }
      if (wants !== "cost" && !this.sawRisk && user.includes("actually signs the agreement")) {
        this.sawRisk = true;
        return {
          candidates: [
            {
              type: "unanswered_question",
              headline: "Nobody answered what happens if one association signs",
              detail: "The question was asked and the conversation moved to logos.",
              whyNow: "the six sheds are about to be committed",
              evidenceTurnIds: [cite("actually signs the agreement")],
              relatedBoardItemIds: [],
              scores: { relevance: 0.9, novelty: 0.9, importance: 0.9, confidence: 0.9 },
            },
          ],
        };
      }
      return { candidates: [] };
    }

    async grounded(): Promise<never> {
      throw new Error("a read-back needs no search");
    }

    async prose(): Promise<never> {
      throw new Error("a read-back is written locally");
    }
  }

  class SpeakingVoice implements VoiceOut {
    private count = 0;
    readonly utterances: string[] = [];

    begin(): Promise<VoiceUtterance | null> {
      const parts: string[] = [];
      const spoken = (): string => parts.join(" ");
      return Promise.resolve({
        id: `v${(this.count += 1)}`,
        append: (text) => parts.push(text.trim()),
        firstAudioMs: () => (parts.length === 0 ? null : 10),
        cancel: () => {},
        finish: () => {
          this.utterances.push(spoken());
          return Promise.resolve({
            reason: "complete" as const,
            text: spoken(),
            spokenSoFar: spoken(),
            firstAudioMs: parts.length === 0 ? null : 10,
          });
        },
      });
    }
  }

  function writer(timing: Record<string, unknown>[]): SessionWriter {
    return {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: () => {},
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      appendTiming: (record: Record<string, unknown>) => timing.push(record),
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
      end: () => {},
    } satisfies SessionWriter;
  }

  async function replay(
    settings: { frequency?: Frequency; boldness?: Boldness } = {},
    notices: "cost" | "risk" | "both" = "both",
  ): Promise<{
    cards: StageCard[];
    timing: Record<string, unknown>[];
    voice: SpeakingVoice;
    turns: TurnUpdate[];
  }> {
    const bus = new EventBus(quiet);
    const timing: Record<string, unknown>[] = [];
    const cards: StageCard[] = [];
    const turns: TurnUpdate[] = [];
    const voice = new SpeakingVoice();
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
      if (event.type === "turn") turns.push(event.turn);
    });
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => writer(timing),
      createModel: () => new DecidingModel(notices),
      createVoice: () => voice,
      replaySpeed: "max",
      wallClock: systemClock,
    });
    sessions.setPolicySettings(settings);
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "decision-closings" });
    await ended;
    return { cards, timing, voice, turns };
  }

  const closings = (timing: Record<string, unknown>[]): Record<string, unknown>[] =>
    timing.filter((record) => record["stage"] === "decision_closing");

  const readBacks = (timing: Record<string, unknown>[]): Record<string, unknown>[] =>
    timing.filter(
      (record) => record["stage"] === "spoken_contribution" && record["kind"] === "readback",
    );

  it("notices all three decisions off the question classifier's own call", async () => {
    const run = await replay();
    expect(closings(run.timing).map((record) => record["decision"])).toEqual([
      "Saturday the 14th, mechanic and coffee cart",
      "six sheds, one per association",
      "paper sheets, typed up monthly",
    ]);
    // Five of the 27 turns are shaped like a question or a closing, so five
    // calls — the whole detection, with nothing added to the bill.
    expect(run.timing.filter((record) => record["stage"] === "question")).toHaveLength(5);
  }, 60_000);

  it("reads back the decision the group left a question against, quoted", async () => {
    const run = await replay({}, "risk");
    const sheds = closings(run.timing)[1];
    expect(sheds).toMatchObject({ found: "group", attached: "group" });

    const spoken = readBacks(run.timing).find(
      (record) => record["decision"] === "six sheds, one per association",
    );
    expect(spoken).toMatchObject({ attached: "group", spoken: true });
    expect(String(spoken?.["text"])).toContain("Got it: six sheds, one per association.");
    expect(String(spoken?.["text"])).toContain("actually signs the agreement");
    expect(String(spoken?.["text"])).toContain("Did that get settled?");
    // Said out loud, and in the transcript as Sotto's line (V2-008a).
    expect(run.voice.utterances.some((text) => text.startsWith("Got it: six sheds"))).toBe(true);
    expect(run.turns.filter(isSottoTurn).map((turn) => turn.text)).toContainEqual(
      expect.stringContaining("Got it: six sheds"),
    );
  }, 60_000);

  it("pins Sotto's own question to the stage instead of saying it", async () => {
    const run = await replay({}, "cost");
    expect(closings(run.timing)[0]).toMatchObject({ found: "own", attached: "own" });

    // The card is the contribution: raised, brought forward and saying what
    // it is open against (V3-008).
    const pinned = run.cards.filter((card) => card.note !== undefined && card.raised === true);
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned.at(-1)?.note).toBe(
      'Still open against "Saturday the 14th, mechanic and coffee cart"',
    );
    expect(pinned.at(-1)?.forward).toBe(true);
    expect(pinned.at(-1)?.headline).toContain("where does the 450 come from");

    // And nothing of it was said: at the default boldness the line degraded
    // to a bare read-back, which `normal` frequency does not say either.
    const launch = readBacks(run.timing).find(
      (record) => record["decision"] === "Saturday the 14th, mechanic and coffee cart",
    );
    expect(launch).toMatchObject({ attached: null, spoken: false });
    expect(run.voice.utterances.some((text) => text.includes("450"))).toBe(false);
  }, 60_000);

  it("says nothing about a decision with nothing hanging off it", async () => {
    const run = await replay({}, "risk");
    expect(closings(run.timing)[2]).toMatchObject({ found: null, attached: null });
    const paper = readBacks(run.timing).find(
      (record) => record["decision"] === "paper sheets, typed up monthly",
    );
    // One spoken read-back per five minutes, and the sheds took it; a bare
    // one would not have been said at `normal` anyway.
    expect(paper === undefined || paper["spoken"] === false).toBe(true);
    expect(run.voice.utterances.some((text) => text.includes("paper sheets"))).toBe(false);
  }, 60_000);

  it("says Sotto's own question when the room asked for bold", async () => {
    const run = await replay({ boldness: "bold" }, "cost");
    const launch = readBacks(run.timing).find(
      (record) => record["decision"] === "Saturday the 14th, mechanic and coffee cart",
    );
    expect(launch).toMatchObject({ attached: "own", spoken: true });
    expect(String(launch?.["text"])).toContain("where does the 450 come from");
  }, 60_000);

  /**
   * The interaction worth knowing about, and the reason for V3-013's one
   * exemption: both cards went up before their decisions, and each spent an
   * interject on the frequency's cooldown (V2-017). The read-back that
   * carries a question the room can already see therefore costs nothing — it
   * is that contribution reaching their ears — so the sheds are still read
   * back, while the bare one Sotto would be volunteering is not.
   */
  it("still says the question a card already paid for", async () => {
    const run = await replay({}, "both");
    const sheds = readBacks(run.timing).find(
      (record) => record["decision"] === "six sheds, one per association",
    );
    expect(sheds).toMatchObject({ attached: "group", spoken: true });
    expect(run.voice.utterances.some((text) => text.startsWith("Got it: six sheds"))).toBe(true);
    // And both candidates reached the stage as cards in the first place.
    expect(run.cards.filter((card) => card.variant === "interject").length).toBeGreaterThanOrEqual(
      2,
    );
  }, 60_000);

  it("reads nothing back on a conversation that settles nothing", async () => {
    const bus = new EventBus(quiet);
    const timing: Record<string, unknown>[] = [];
    const voice = new SpeakingVoice();
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => writer(timing),
      createModel: () => new DecidingModel(),
      createVoice: () => voice,
      replaySpeed: "max",
      wallClock: systemClock,
    });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) {
          off();
          resolve();
        }
      });
    });
    sessions.start({ kind: "events", fixture: "brainstorm" });
    await ended;
    expect(closings(timing)).toEqual([]);
    expect(readBacks(timing)).toEqual([]);
    expect(voice.utterances).toEqual([]);
  }, 60_000);
});

/**
 * V3-017 through the whole pipeline: a correction Sotto is holding raises its
 * hand, and "Sotto, go ahead" has it read out loud.
 *
 * `ask-search` is the capture where somebody says Sotto's name six lines in,
 * so the observer has looked twice by then and the policy has put cards up.
 * The address classifier is told to read that line as a `call_on`, which is
 * what the real one does for "Sotto, go ahead" (its integration test checks
 * the wording; this checks the wiring).
 */
describe("SessionManager: raising a hand and being called on (V3-017)", () => {
  /** Offers `candidates` on its first observer look, then nothing. */
  class HoldingModel implements ModelClient {
    private looked = false;

    constructor(private readonly candidates: unknown[]) {}

    async structured(call: StructuredCall): Promise<unknown> {
      if (call.label === "address") return { kind: "call_on", question: "" };
      if (call.label === "board") return { operations: [] };
      if (call.label === "research-planner") return { ideas: [] };
      if (call.label === "question") return { kind: "none", question: "", topic: "" };
      if (call.label === "still-current") {
        return { verdict: "current", agrees: false, why: "nobody has moved on" };
      }
      if (call.label === "observer" && !this.looked) {
        this.looked = true;
        return { candidates: this.candidates };
      }
      return { candidates: [] };
    }

    async grounded(): Promise<never> {
      throw new Error("nothing here is verified");
    }

    async prose(): Promise<never> {
      throw new Error("a called-on card is read off the card, not written");
    }
  }

  function writer(timing: Record<string, unknown>[]): SessionWriter {
    return {
      dir: "/tmp/not-a-real-folder",
      appendEvent: () => {},
      appendTurn: () => {},
      renameSpeaker: () => {},
      setSettings: () => {},
      writeBoard: () => {},
      appendCandidate: () => {},
      appendFeedback: () => {},
      appendAnswer: () => {},
      appendResearch: () => {},
      writePacket: () => {},
      writeDigest: () => {},
      appendTiming: (record: Record<string, unknown>) => timing.push(record),
      writeArtifact: (fileName: string) => `artifacts/${fileName}`,
      end: () => {},
    } satisfies SessionWriter;
  }

  function noticed(headline: string, detail: string): unknown {
    return {
      type: "contradiction",
      headline,
      detail,
      whyNow: "the price is being written down",
      evidenceTurnIds: ["0:3"],
      relatedBoardItemIds: [],
      scores: { relevance: 0.95, novelty: 0.9, importance: 0.9, confidence: 0.9 },
    };
  }

  async function replay(candidates: unknown[]): Promise<{
    cards: StageCard[];
    timing: Record<string, unknown>[];
    utterances: string[];
    turns: TurnUpdate[];
  }> {
    const bus = new EventBus(quiet);
    const timing: Record<string, unknown>[] = [];
    const cards: StageCard[] = [];
    const turns: TurnUpdate[] = [];
    const utterances: string[] = [];
    bus.subscribe((event) => {
      if (event.type === "card") cards.push(event.card);
      if (event.type === "turn") turns.push(event.turn);
    });
    const voice: VoiceOut = {
      begin: () => {
        let said = "";
        return Promise.resolve<VoiceUtterance>({
          id: `v${utterances.length + 1}`,
          append: (text) => { said += text; },
          firstAudioMs: () => (said === "" ? null : 10),
          cancel: () => {},
          finish: () => {
            utterances.push(said);
            return Promise.resolve({
              reason: "complete" as const,
              text: said,
              spokenSoFar: said,
              firstAudioMs: said === "" ? null : 10,
            });
          },
        });
      },
    };
    const sessions = new SessionManager({
      bus,
      apiKey: "test-key",
      logger: quiet,
      createStore: () => writer(timing),
      createModel: () => new HoldingModel(candidates),
      createVoice: () => voice,
      replaySpeed: "max",
      wallClock: systemClock,
    });
    const ended = new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session" && event.session === null) { off(); resolve(); }
      });
    });
    sessions.start({ kind: "events", fixture: "ask-search" });
    await ended;
    return { cards, timing, utterances, turns };
  }

  it("reads out the one thing it is holding", async () => {
    const run = await replay([
      noticed("A $12 solo tier does not fit the $4,000 floor", "You would need 333 solos."),
    ]);

    // The card went up with its hand raised: shown, not said (V3-008).
    const held = run.cards.filter((card) => card.raised === true);
    expect(held).toHaveLength(1);
    const call = run.timing.filter((record) => record["stage"] === "wake_call_on");
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({ raised: 1, cardId: held[0]?.id });
    // And it was read out, headline then detail, under the card's own id.
    const spoken = run.timing.filter(
      (record) => record["stage"] === "spoken_contribution" && record["kind"] === "called_on",
    );
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ cardId: held[0]?.id, spoken: true, yielded: false });
    expect(run.utterances).toEqual([
      "A $12 solo tier does not fit the $4,000 floor. You would need 333 solos.",
    ]);
    // Said, so the hand comes down: the card is republished without the flag.
    const last = run.cards.filter((card) => card.id === held[0]?.id).at(-1);
    expect(last?.raised).toBe(false);
    // And the line is in the transcript as Sotto's (V2-008a).
    expect(run.turns.filter((turn) => isSottoTurn(turn)).map((turn) => turn.text)).toContain(
      "A $12 solo tier does not fit the $4,000 floor. You would need 333 solos.",
    );
  }, 60_000);

  it("reads out the most recent of several", async () => {
    const run = await replay([
      noticed("The $12 solo tier does not fit the floor", "You would need 333 solos."),
      noticed("Nobody has said who writes the copy", "It has been dropped twice."),
    ]);

    const held = run.cards.filter((card) => card.raised === true);
    expect(held.length).toBeGreaterThanOrEqual(2);
    const call = run.timing.find((record) => record["stage"] === "wake_call_on");
    expect(call?.["raised"]).toBeGreaterThanOrEqual(2);
    // The newest one Sotto was holding when the room asked, which is the last
    // card to have gone up before the call.
    expect(run.utterances).toEqual([
      "Nobody has said who writes the copy. It has been dropped twice.",
    ]);
  }, 60_000);

  it("says so when it is holding nothing", async () => {
    const run = await replay([]);

    expect(run.cards.filter((card) => card.raised === true)).toEqual([]);
    expect(run.timing).toContainEqual(
      expect.objectContaining({ stage: "wake_call_on", raised: 0, cardId: null }),
    );
    expect(run.utterances).toEqual(["Nothing right now."]);
  }, 60_000);
});
