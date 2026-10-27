import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FixtureListResponse,
  SessionSource,
  StatusChannel,
  StatusUpdate,
} from "../../shared/index.js";
import { describeSource } from "../../shared/index.js";
import {
  ApiCallError,
  fetchFixtures,
  renameSpeaker,
  startSession,
  stopSession,
} from "./api.js";
import { MicCapture, requestMicrophone, startMicCapture } from "./audio/micCapture.js";
import { SessionControls, parseSourceValue, sourceValue } from "./SessionControls.js";
import { StatusDots } from "./StatusDots.js";
import { TranscriptPanel } from "./TranscriptPanel.js";
import { useServerStatus } from "./useServerStatus.js";
import { useSessionEvents } from "./useSessionEvents.js";

const NO_FIXTURES: FixtureListResponse = { wav: [], events: [] };

export function App() {
  const health = useServerStatus();
  const events = useSessionEvents();
  const [fixtures, setFixtures] = useState<FixtureListResponse>(NO_FIXTURES);
  const [selected, setSelected] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The microphone, while a `mic` session is running (US-012). */
  const mic = useRef<MicCapture | null>(null);

  const stopMic = useCallback(() => {
    mic.current?.stop();
    mic.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchFixtures()
      .then((list) => {
        if (cancelled) return;
        setFixtures(list);
        const first = defaultSource(list);
        if (first !== null) setSelected(sourceValue(first));
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const statuses = useMemo(
    (): Record<StatusChannel, StatusUpdate> => ({
      ...events.statuses,
      // The socket is the better witness of whether the server is there: it
      // notices a drop the moment it happens, where the health poll waits.
      server: serverStatus(events.connected, health),
    }),
    [events.statuses, events.connected, health],
  );

  const onStart = useCallback(() => {
    const source = parseSourceValue(selected);
    if (source === null) return;
    setProblem(null);
    setBusy(true);
    void (async () => {
      // The permission prompt comes before the session: a microphone the user
      // refuses should leave nothing running behind it.
      let stream: MediaStream | null = null;
      try {
        if (source.kind === "mic") stream = await requestMicrophone();
        await startSession(source);
        // The server has its MicSource now, so `/ws/audio` has somewhere to land.
        if (stream !== null) mic.current = await startMicCapture({ stream, onError: setProblem });
      } catch (error) {
        for (const track of stream?.getTracks() ?? []) track.stop();
        setProblem(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [selected]);

  const onStop = useCallback(() => {
    setBusy(true);
    // Let go of the microphone first, so the light goes out on the click
    // rather than when the API has finished flushing.
    stopMic();
    void stopSession()
      .catch((error: unknown) =>
        setProblem(error instanceof ApiCallError ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [stopMic]);

  const onRenameSpeaker = useCallback((label: string, name: string | null) => {
    setProblem(null);
    void renameSpeaker(label, name).catch((error: unknown) =>
      setProblem(error instanceof ApiCallError ? error.message : String(error)),
    );
  }, []);

  const session = events.session;

  // A session can also end on its own — the capture runs out, the stream
  // fails — and the microphone must not stay on when it does.
  useEffect(() => {
    if (session === null) stopMic();
  }, [session, stopMic]);

  // And neither should navigating away.
  useEffect(() => stopMic, [stopMic]);

  return (
    <div className="app">
      <header className="header">
        <h1 className="brand">Sotto</h1>
        <SessionControls
          fixtures={fixtures}
          value={selected}
          onChange={setSelected}
          running={session !== null}
          busy={busy}
          onStart={onStart}
          onStop={onStop}
        />
        <StatusDots statuses={statuses} />
      </header>
      <div className="layout">
        {/* The board lands under the transcript in this column (US-009). */}
        <aside className="sidebar">
          <TranscriptPanel
            turns={events.turns}
            speakers={events.speakers}
            onRename={onRenameSpeaker}
          />
        </aside>
        <main className="stage">
          {problem !== null && (
            <p className="stage__problem" data-testid="session-problem" role="alert">
              {problem}
            </p>
          )}
          <p className="stage__hint" data-testid="session-state">
            {session === null
              ? "Sotto listens to a brainstorm and speaks up only when it matters."
              : `Listening to ${describeSource(session.source)} — ${events.turnCount} turns so far.`}
          </p>
        </main>
      </div>
    </div>
  );
}

/**
 * What the selector starts on: the brainstorm replay, which needs no API key
 * and no waiting; failing that, whatever this checkout has.
 */
function defaultSource(fixtures: FixtureListResponse): SessionSource | null {
  if (fixtures.events.includes("brainstorm")) return { kind: "events", fixture: "brainstorm" };
  const events = fixtures.events[0];
  if (events !== undefined) return { kind: "events", fixture: events };
  const wav = fixtures.wav[0];
  return wav === undefined ? null : { kind: "wav", fixture: wav };
}

/** The server dot: the events socket first, the health poll as the fallback. */
function serverStatus(
  connected: boolean,
  health: ReturnType<typeof useServerStatus>,
): StatusUpdate {
  if (connected) return { channel: "server", state: "active", detail: "events socket attached" };
  if (health === "connecting") return { channel: "server", state: "connecting" };
  return {
    channel: "server",
    state: "error",
    detail:
      health === "connected" ? "server is up but /ws/events is not" : "no answer from the server",
  };
}
