import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  FixtureListResponse,
  SessionSource,
  StatusChannel,
  StatusUpdate,
} from "../../shared/index.js";
import { describeSource } from "../../shared/index.js";
import { ApiCallError, fetchFixtures, startSession, stopSession } from "./api.js";
import { SessionControls, parseSourceValue, sourceValue } from "./SessionControls.js";
import { StatusDots } from "./StatusDots.js";
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
    void startSession(source)
      .catch((error: unknown) =>
        setProblem(error instanceof ApiCallError ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [selected]);

  const onStop = useCallback(() => {
    setBusy(true);
    void stopSession()
      .catch((error: unknown) =>
        setProblem(error instanceof ApiCallError ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, []);

  const session = events.session;

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
