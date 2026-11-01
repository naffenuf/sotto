import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Boldness,
  FeedbackVerdict,
  Frequency,
  StageCard,
  StatusChannel,
  StatusUpdate,
} from "../../shared/index.js";
import { describeSource, emptyBoard } from "../../shared/index.js";
import {
  ApiCallError,
  askSotto,
  fetchHistory,
  fetchDiscussion,
  renameSpeaker,
  sendFeedback,
  setPolicySettings,
  setVoiceMuted,
  stopVoice,
  startSession,
  stopSession,
} from "./api.js";
import { AskBox } from "./AskBox.js";
import { MicCapture, requestMicrophone, startMicCapture } from "./audio/micCapture.js";
import { useVoicePlayback } from "./audio/useVoicePlayback.js";
import { BoardFreshness, BoardPanel } from "./BoardPanel.js";
import { Fold } from "./Fold.js";
import { useStoredFlag } from "./useStoredFlag.js";
import { Backstage } from "./Backstage.js";
import { SessionControls } from "./SessionControls.js";
import type { HistoryDetail, HistoryEntry } from "../../shared/history.js";
import { RaisedHand, useRaisedHand } from "./RaisedHand.js";
import { Stage } from "./Stage.js";
import { StatusDots } from "./StatusDots.js";
import { TranscriptPanel, type TurnHighlight } from "./TranscriptPanel.js";
import { useServerStatus } from "./useServerStatus.js";
import { useSessionEvents } from "./useSessionEvents.js";

export function App() {
  const health = useServerStatus();
  const events = useSessionEvents();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [discussion, setDiscussion] = useState<HistoryDetail | null>(null);
  /** Which of a previous discussion's views is open; the current one stacks them instead. */
  const [view, setView] = useState<"board" | "transcript" | "backstage">("board");
  /** The notes fold under the transcript: open unless this browser closed it. */
  const [notesOpen, setNotesOpen] = useStoredFlag("notes-open", true);
  /** The history fold: closed while a session runs, unless this browser chose otherwise. */
  const [historyOpenChoice, setHistoryOpen] = useStoredFlag("history-open", events.session === null);
  /** The transcript's search text, which the notes light up too. */
  const [query, setQuery] = useState("");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useVoicePlayback(setProblem);
  const [busy, setBusy] = useState(false);
  /** The microphone, while a `mic` session is running (US-012). */
  const mic = useRef<MicCapture | null>(null);
  /** The turn an evidence quote last asked the transcript to show (US-015). */
  const [cited, setCited] = useState<TurnHighlight | null>(null);
  /** What Sotto is holding and has not said (V3-017). */
  const hand = useRaisedHand(events.cards);

  const stopMic = useCallback(() => {
    mic.current?.stop();
    mic.current = null;
  }, []);

  const refreshHistory = useCallback(() => {
    void fetchHistory().then((items) => { setHistory(items); setHistoryError(null); }).catch(() => setHistoryError("Could not load previous discussions."));
  }, []);
  useEffect(() => { refreshHistory(); }, [refreshHistory]);

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
    const source = { kind: "mic" } as const;
    setDiscussion(null);
    setView("board");
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
  }, []);

  const onStop = useCallback(() => {
    setBusy(true);
    // Let go of the microphone first, so the light goes out on the click
    // rather than when the API has finished flushing.
    stopMic();
    void stopSession()
      .catch((error: unknown) =>
        setProblem(error instanceof ApiCallError ? error.message : String(error)),
      )
      .finally(() => { setBusy(false); refreshHistory(); });
  }, [stopMic, refreshHistory]);

  // The server owns both settings and pushes them back on `/ws/events`, so
  // there is nothing to remember here: each selector shows what came back.
  const onFrequencyChange = useCallback((frequency: Frequency) => {
    setProblem(null);
    void setPolicySettings({ frequency }).catch((error: unknown) =>
      setProblem(error instanceof ApiCallError ? error.message : String(error)),
    );
  }, []);

  const onBoldnessChange = useCallback((boldness: Boldness) => {
    setProblem(null);
    void setPolicySettings({ boldness }).catch((error: unknown) =>
      setProblem(error instanceof ApiCallError ? error.message : String(error)),
    );
  }, []);

  // Same as those two: the server owns it and the checkbox shows what came
  // back. Muting also stops whatever Sotto is saying (V2-004).
  const onVoiceMutedChange = useCallback((muted: boolean) => {
    setProblem(null);
    void setVoiceMuted(muted).catch((error: unknown) =>
      setProblem(error instanceof ApiCallError ? error.message : String(error)),
    );
  }, []);

  const onStopVoice = useCallback(() => {
    void stopVoice().catch((error: unknown) =>
      setProblem(error instanceof ApiCallError ? error.message : String(error)),
    );
  }, []);

  // A fresh object every click, so clicking the same quote twice scrolls back
  // to it twice rather than being seen as the same request.
  const onQuoteClick = useCallback((turnId: string) => {
    setDiscussion(null);
    setView("transcript");
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

  // A typed question (US-019). It is sent, not answered here: what comes
  // back is an answer card on `/ws/events`, the same as a spoken one. The
  // rejection is re-thrown so the box keeps what was typed.
  const onAsk = useCallback(async (question: string) => {
    setProblem(null);
    try {
      return await askSotto(question);
    } catch (error) {
      setProblem(error instanceof ApiCallError ? error.message : String(error));
      throw error;
    }
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
    if (session === null) { stopMic(); refreshHistory(); }
  }, [session, stopMic, refreshHistory]);

  // And neither should navigating away.
  useEffect(() => stopMic, [stopMic]);

  return (
    <div className="app">
      <header className="header">
        <h1 className="brand">Sotto</h1>
        <SessionControls
          running={session !== null}
          busy={busy}
          onStart={onStart}
          onStop={onStop}
          frequency={events.settings.frequency}
          onFrequencyChange={onFrequencyChange}
          boldness={events.settings.boldness}
          onBoldnessChange={onBoldnessChange}
          voiceMuted={events.settings.voiceMuted}
          onVoiceMutedChange={onVoiceMutedChange}
        />
        {/* Beside the dots, as the PRD puts it: the one place that says
            Sotto has something it has not said (V3-017). */}
        <RaisedHand cards={hand.cards} onOpenAll={hand.openAll} />
        <StatusDots statuses={statuses} />
      </header>
      <div className="layout">
        <aside className="sidebar">
          <div className="discussion-header">
            <span className="discussion-eyebrow">{discussion ? "PREVIOUS DISCUSSION" : "CURRENT DISCUSSION"}</span>
            {discussion && <button className="discussion-return" onClick={() => { setDiscussion(null); setView("board"); }}>← Back to current</button>}
            {discussion && (
              <div className="discussion-tabs" aria-label="Discussion view">
                <button aria-pressed={view === "board"} onClick={() => setView("board")}>Discussion notes</button>
                <button aria-pressed={view === "transcript"} onClick={() => setView("transcript")}>Transcript</button>
                <button aria-pressed={view === "backstage"} onClick={() => setView("backstage")}>Backstage</button>
              </div>
            )}
          </div>
          {discussion ? (
            view === "backstage" ? <Backstage log={discussion.candidateLog ?? []} digest={discussion.digest ?? ""} /> : view === "transcript" ? (
              <section className="history-transcript"><h2 className="panel__title">Transcript</h2><pre>{historyTranscript(discussion.transcript) || "No transcript saved."}</pre></section>
            ) : <BoardPanel board={discussion.board ?? emptyBoard()} changedIds={[]} updatedAt={0} historical updating={false} />
          ) : (
            <>
              {/* The conversation and the board at once: the transcript takes
                  what the folds leave, so a viewer sees words land and the
                  notes fill in the same frame. */}
              <TranscriptPanel turns={events.turns} speakers={events.speakers} onRename={onRenameSpeaker} highlight={cited} onSearch={setQuery} />
              <Fold
                name="notes"
                title="Discussion notes"
                open={notesOpen}
                onToggle={setNotesOpen}
                // The model dot goes `connecting` for exactly as long as a board
                // update is out (`BoardUpdater.onModelState`), so it is also the
                // panel's spinner.
                aside={<BoardFreshness updatedAt={events.boardReceivedAtMs} updating={statuses.model.state === "connecting"} />}
              >
                <BoardPanel
                  board={events.board}
                  changedIds={events.boardChangedIds}
                  updatedAt={events.boardReceivedAtMs}
                  updating={statuses.model.state === "connecting"}
                  bare
                  query={query}
                />
              </Fold>
            </>
          )}
          {discussion && view !== "backstage" && discussion.contributions.length > 0 && <section className="history-contributions"><h2 className="panel__title">Sotto’s contributions</h2>{discussion.contributions.map((item, index) => <article key={index}><small>{item.kind}</small><strong>{item.headline}</strong><p>{item.detail}</p></article>)}</section>}
          <Fold name="history" title="Previous discussions" open={historyOpenChoice} onToggle={setHistoryOpen}>
            <div className="history-list" aria-label="Previous discussions">
              {historyError && <p>{historyError}</p>}
              {!historyError && history.length === 0 && <p>No previous discussions yet.</p>}
              {history.map((item) => <button key={item.folder} className="history-item" aria-current={discussion?.folder === item.folder ? "true" : undefined} onClick={() => { void fetchDiscussion(item.folder).then((value) => { setDiscussion(value); setView("board"); setHistoryError(null); }).catch(() => setHistoryError("Could not open that discussion.")); }}><span>{item.title}</span><time>{new Date(item.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></button>)}
            </div>
          </Fold>
        </aside>
        <Stage
          cards={events.cards}
          // V3-016: what Sotto noticed and held back, under the cards.
          almostSaid={events.suppressed}
          onQuoteClick={onQuoteClick}
          onFeedback={onFeedback}
          onOpen={(card) => hand.open(card.id)}
          footer={<AskBox onAsk={onAsk} />}
          banner={
            <>
              {/* Sotto is talking (V2-004), with the way to make it stop
                  right next to it. Muting is in the header. */}
              {events.voice.speaking && (
                <div
                  className="voice-status"
                  role="status"
                  data-testid="voice-speaking"
                  data-playing={events.voice.playing}
                >
                  <span className="voice-status__dot" aria-hidden="true" />
                  Sotto is speaking
                  <button type="button" onClick={onStopVoice}>
                    Stop speaking
                  </button>
                </div>
              )}
              {/* Somebody has said Sotto's name and is still asking (US-017).
                  It sits above the cards because the answer lands there. */}
              {events.listening && (
                <p className="stage__listening" data-testid="wake-listening" role="status">
                  Sotto is listening
                  <span className="stage__listening-dots" aria-hidden="true">
                    <span className="card__dot" />
                    <span className="card__dot" />
                    <span className="card__dot" />
                  </span>
                </p>
              )}
              {discussion && <p className="history-stage-note">The stage shows the current discussion. The selected previous discussion is shown on the left.</p>}
              {problem !== null && (
                <p className="stage__problem" data-testid="session-problem" role="alert">
                  {problem}
                </p>
              )}
            </>
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

/**
 * `transcript.md` read as plain text: the file is markdown, and this view is a
 * `<pre>`, so the emphasis around a speaker's name and around V2-008a's
 * interrupted marker would otherwise be read out as punctuation.
 */
function historyTranscript(transcript: string): string {
  return transcript.replaceAll("**", "").replaceAll("_(interrupted)_", "(interrupted)");
}
