import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import type { ServerEvent } from "../shared/events.js";
import type { FixtureListResponse } from "../shared/session.js";
import { buildApp } from "./app.js";
import { EventBus } from "./events/bus.js";
import type { ReplaySpeed } from "./asr/EventReplaySource.js";
import { SessionManager } from "./session/SessionManager.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/**
 * An app with its own bus and session manager, so a test can look at the bus
 * and choose the replay speed. Nothing here touches the network: `max` runs a
 * capture through in milliseconds, `1x` leaves it running until it is stopped.
 */
async function buildTestApp(
  options: { apiKey?: string; speed?: ReplaySpeed } = {},
): Promise<{ app: FastifyInstance; bus: EventBus }> {
  const bus = new EventBus(quiet);
  const sessions = new SessionManager({
    bus,
    apiKey: options.apiKey ?? "test-key",
    logger: quiet,
    // `npm test` writes no session folders; US-008 has its own tests for those.
    createStore: () => null,
    replaySpeed: options.speed ?? "max",
  });
  app = await buildApp({ bus, sessions });
  return { app, bus };
}

describe("GET /api/health", () => {
  it("returns { ok: true }", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});

describe("listen", () => {
  it("binds to 127.0.0.1 only", async () => {
    app = await buildApp();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("GET /api/fixtures", () => {
  it("lists the fixtures that have audio and the ones that have captures", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/fixtures" });
    expect(response.statusCode).toBe(200);
    const body = response.json<FixtureListResponse>();
    expect(body.wav).toContain("brainstorm");
    expect(body.events).toContain("brainstorm");
    expect(body.wav).toEqual([...body.wav].sort());
  });
});

describe("POST /api/session/start", () => {
  it("starts an events replay", async () => {
    const { app: server } = await buildTestApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "brainstorm" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      session: {
        id: "events-brainstorm-1",
        source: { kind: "events", fixture: "brainstorm" },
        startedAtMs: 0,
      },
    });
  });

  it("rejects a body that is not a source", async () => {
    const { app: server } = await buildTestApp();
    for (const payload of [
      {},
      { source: { kind: "tape", fixture: "brainstorm" } },
      { source: { kind: "events" } },
      { source: { kind: "events", fixture: "../secrets" } },
    ]) {
      const response = await server.inject({ method: "POST", url: "/api/session/start", payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<{ error: string }>().error).toBeTruthy();
    }
  });

  it("answers 409 while a session is running", async () => {
    // At 1x the replay is still going when the second request arrives; at max
    // the whole capture would be through before it.
    const { app: server } = await buildTestApp({ speed: "1x" });
    const start = {
      method: "POST" as const,
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "brainstorm" } },
    };
    await server.inject(start);
    const second = await server.inject(start);
    expect(second.statusCode).toBe(409);
  });

  it("answers 501 for the microphone until US-012", async () => {
    const { app: server } = await buildTestApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "mic" } },
    });
    expect(response.statusCode).toBe(501);
  });
});

describe("POST /api/session/stop", () => {
  it("stops a running session and reports when there was none", async () => {
    const { app: server } = await buildTestApp({ speed: "1x" });
    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "brainstorm" } },
    });

    const stopped = await server.inject({ method: "POST", url: "/api/session/stop" });
    expect(stopped.json()).toEqual({ stopped: true });

    const again = await server.inject({ method: "POST", url: "/api/session/stop" });
    expect(again.json()).toEqual({ stopped: false });
  });
});

describe("/ws/events", () => {
  /**
   * Opens a socket and starts reading before the server can speak. The
   * snapshot goes out the moment the route handler runs, so a listener
   * attached after `injectWS` resolves would miss it.
   */
  async function open(
    server: FastifyInstance,
    done: (events: ServerEvent[]) => boolean,
  ): Promise<{
    socket: Awaited<ReturnType<FastifyInstance["injectWS"]>>;
    events: Promise<ServerEvent[]>;
  }> {
    const seen: ServerEvent[] = [];
    let settle: (events: ServerEvent[]) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const events = new Promise<ServerEvent[]>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // `injectWS` routes through the router, so the app has to be ready first.
    await server.ready();
    const socket = await server.injectWS("/ws/events", undefined, {
      onInit: (ws) => {
        ws.on("message", (data: unknown) => {
          seen.push(JSON.parse(String(data)) as ServerEvent);
          if (done(seen)) settle(seen);
        });
        ws.on("error", fail);
      },
    });
    return { socket, events };
  }

  it("catches a new socket up with the statuses and the session", async () => {
    const { app: server, bus } = await buildTestApp();
    bus.setStatus("transcription", "active", "replaying brainstorm events at max");

    const { socket, events } = await open(server, (seen) => seen.length === 4);
    const snapshot = await events;
    socket.close();

    expect(snapshot).toEqual([
      { type: "status", status: { channel: "server", state: "active" } },
      {
        type: "status",
        status: {
          channel: "transcription",
          state: "active",
          detail: "replaying brainstorm events at max",
        },
      },
      // The model dot only claims to be ready while a session is running.
      { type: "status", status: { channel: "model", state: "idle" } },
      { type: "session", session: null },
    ]);
  });

  it("pushes turns and status changes while a session runs", async () => {
    const { app: server } = await buildTestApp();
    // The four snapshot events, then the session's own, ending back at null.
    const { socket, events } = await open(server, (seen) => {
      const last = seen.at(-1);
      return seen.length > 4 && last?.type === "session" && last.session === null;
    });

    await server.inject({
      method: "POST",
      url: "/api/session/start",
      payload: { source: { kind: "events", fixture: "moment-fact" } },
    });
    const seen = await events;
    socket.close();

    expect(seen.filter((event) => event.type === "turn").length).toBeGreaterThan(10);
    expect(
      seen.filter((event) => event.type === "session").map((event) => event.session !== null),
    ).toEqual([false, true, false]);
    const dots = seen
      .filter((event) => event.type === "status")
      .map((event) => `${event.status.channel}:${event.status.state}`);
    expect(dots).toContain("transcription:active");
    expect(dots.at(-1)).toBe("model:idle");
  });

  it("drops its subscription when the socket closes", async () => {
    // A real socket on a real local port: an injected one does not complete
    // the closing handshake, so the server would never hear about it.
    const { app: server, bus } = await buildTestApp();
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const client = new WebSocket(`${address.replace("http", "ws")}/ws/events`);
    await new Promise((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });
    expect(bus.listenerCount).toBe(1);

    await new Promise<void>((resolve) => {
      client.on("close", () => resolve());
      client.close();
    });
    // The close has to reach the server before the subscription goes.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bus.listenerCount).toBe(0);
  });
});
