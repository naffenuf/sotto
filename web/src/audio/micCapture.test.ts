import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIC_REDIAL_FOR_MS,
  MIC_REDIAL_MAX_WAIT_MS,
  MIC_REDIAL_WAIT_MS,
  MicCapture,
} from "./micCapture.js";

/** Enough of a WebSocket for the capture to dial, send and lose. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static dialled: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  closedWith: { code: number; reason: string } | undefined;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.dialled.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(): void {}

  close(code: number, reason: string): void {
    this.readyState = FakeSocket.CLOSED;
    this.closedWith = { code, reason };
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    for (const listener of this.listeners.get("open") ?? []) listener({});
  }

  /** The server, or the network, closes it. */
  drop(code: number, reason = ""): void {
    this.readyState = FakeSocket.CLOSED;
    for (const listener of this.listeners.get("close") ?? []) listener({ code, reason });
  }
}

function capture(onError?: (message: string) => void): MicCapture {
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  const context = { sampleRate: 48_000, close: () => Promise.resolve() } as unknown as AudioContext;
  return new MicCapture(stream, context, [], "ws://test/ws/audio", onError);
}

describe("MicCapture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.dialled = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("redials a socket that dropped, backing off up to the cap", () => {
    const errors: string[] = [];
    const mic = capture((message) => errors.push(message));
    expect(FakeSocket.dialled).toHaveLength(1);
    FakeSocket.dialled[0]?.open();

    // A laptop going to sleep: the socket goes without the page asking.
    FakeSocket.dialled[0]?.drop(1006);
    expect(FakeSocket.dialled).toHaveLength(1);
    vi.advanceTimersByTime(MIC_REDIAL_WAIT_MS);
    expect(FakeSocket.dialled).toHaveLength(2);
    expect(mic.redials).toBe(1);

    // Still down: the wait doubles.
    FakeSocket.dialled[1]?.drop(1006);
    vi.advanceTimersByTime(MIC_REDIAL_WAIT_MS * 2 - 1);
    expect(FakeSocket.dialled).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.dialled).toHaveLength(3);

    // Back: the next drop starts the backoff over.
    FakeSocket.dialled[2]?.open();
    FakeSocket.dialled[2]?.drop(1006);
    vi.advanceTimersByTime(MIC_REDIAL_WAIT_MS);
    expect(FakeSocket.dialled).toHaveLength(4);
    expect(errors).toEqual([]);

    for (let i = 0; i < 10; i += 1) {
      FakeSocket.dialled.at(-1)?.drop(1006);
      vi.advanceTimersByTime(MIC_REDIAL_MAX_WAIT_MS);
    }
    expect(FakeSocket.dialled.length).toBeGreaterThan(5);
    mic.stop();
    const dialled = FakeSocket.dialled.length;
    vi.advanceTimersByTime(MIC_REDIAL_MAX_WAIT_MS * 2);
    expect(FakeSocket.dialled).toHaveLength(dialled);
  });

  it("gives up after the server's grace period and says so", () => {
    const errors: string[] = [];
    capture((message) => errors.push(message));
    FakeSocket.dialled[0]?.open();
    FakeSocket.dialled[0]?.drop(1006);
    vi.setSystemTime(Date.now() + MIC_REDIAL_FOR_MS + 1);
    vi.advanceTimersByTime(MIC_REDIAL_WAIT_MS);
    FakeSocket.dialled[1]?.drop(1006);
    expect(errors).toEqual(["The microphone stream dropped and could not be reconnected."]);
    vi.advanceTimersByTime(MIC_REDIAL_MAX_WAIT_MS * 2);
    expect(FakeSocket.dialled).toHaveLength(2);
  });

  it("stops rather than redials when the server turned it away", () => {
    const errors: string[] = [];
    capture((message) => errors.push(message));
    FakeSocket.dialled[0]?.drop(1008, "a microphone is already streaming into this session");
    vi.advanceTimersByTime(MIC_REDIAL_MAX_WAIT_MS * 2);
    expect(FakeSocket.dialled).toHaveLength(1);
    expect(errors).toEqual([
      "The microphone stream was closed by the server: a microphone is already streaming into this session.",
    ]);
  });

  it("closes cleanly on stop, which the server reads as done", () => {
    const mic = capture();
    FakeSocket.dialled[0]?.open();
    mic.stop();
    expect(FakeSocket.dialled[0]?.closedWith).toEqual({ code: 1000, reason: "capture stopped" });
    // The close event that follows our own close is not a drop.
    FakeSocket.dialled[0]?.drop(1000);
    vi.advanceTimersByTime(MIC_REDIAL_MAX_WAIT_MS);
    expect(FakeSocket.dialled).toHaveLength(1);
  });
});
