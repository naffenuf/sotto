import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Chattiness,
  FeedbackVerdict,
  FixtureListResponse,
  SessionSource,
  StageCard,
  StatusChannel,
  StatusUpdate,
} from "../../shared/index.js";
import { describeSource } from "../../shared/index.js";
import {
  ApiCallError,
  fetchFixtures,
  renameSpeaker,
  sendFeedback,
  setChattiness,
  startSession,
  stopSession,
} from "./api.js";
import { MicCapture, requestMicrophone, startMicCapture } from "./audio/micCapture.js";
import { BoardPanel } from "./BoardPanel.js";
import { SessionControls, parseSourceValue, sourceValue } from "./SessionControls.js";
import { Stage } from "./Stage.js";
import { StatusDots } from "./StatusDots.js";
import { TranscriptPanel, type TurnHighlight } from "./TranscriptPanel.js";
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
  /** The turn an evidence quote last asked the transcript to show (US-015). */
  const [cited, setCited] = useState<TurnHighlight | null>(null);

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

  // The server owns the setting and pushes it back on `/ws/events`, so there
  // is nothing to remember here: the selector shows what came back.
  const onChattinessChange = useCallback((chattiness: Chattiness) => {
    setProblem(null);
    void setChattiness(chattiness).catch((error: unknown) =>
      setProblem(error instanceof ApiCallError ? error.message : String(error)),
    );
  }, []);

  // A fresh object every click, so clicking the same quote twice scrolls back
  // to it twice rather than being seen as the same request.
  const onQuoteClick = useCallback((turnId: string) => {
    setCited({ turnId, at: Date.now() });
  }, []);

  // Nothing comes back but a line in the session folder, so a failure is
  // shown and otherwise ignored: the card keeps the button it just pressed.
  const onFeedback = useCallback((card: StageCard, verdict: FeedbackVerdict) => {
    setProblem(null);
    void sendFeedback(card.id, verdict).catch((error: unknown) =>
      setProblem(error instanceof ApiCallError ? error.message : String(error)),
    );
  }, []);

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
          chattiness={events.settings.chattiness}
          onChattinessChange={onChattinessChange}
        />
        <StatusDots statuses={statuses} />
      </header>
      <div className="layout">
        <aside className="sidebar">
          <TranscriptPanel
            turns={events.turns}
            speakers={events.speakers}
            onRename={onRenameSpeaker}
            highlight={cited}
          />
          <BoardPanel
            board={events.board}
            changedIds={events.boardChangedIds}
            updatedAt={events.boardReceivedAtMs}
            // The model dot goes `connecting` for exactly as long as a board
            // update is out (`BoardUpdater.onModelState`), so it is also the
            // panel's spinner.
            updating={statuses.model.state === "connecting"}
          />
        </aside>
        <Stage
          cards={events.cards}
          onQuoteClick={onQuoteClick}
          onFeedback={onFeedback}
          banner={
            problem !== null ? (
              <p className="stage__problem" data-testid="session-problem" role="alert">
                {problem}
              </p>
            ) : undefined
          }
          placeholder={
            <p className="stage__hint" data-testid="session-state">
              {session === null
                ? "Sotto listens to a brainstorm and speaks up only when it matters."
                : `Listening to ${describeSource(session.source)} — ${events.turnCount} turns so far.`}
            </p>
          }
        />
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
