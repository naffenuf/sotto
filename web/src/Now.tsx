/**
 * The Now zone: what Sotto is doing this second, at the top of the stage.
 *
 * Listening (most of a meeting), looking something up, waiting for a gap to
 * say a line it has already written, or speaking — with the words as they
 * are handed to the voice and Stop right beside them. The one part of the
 * stage that moves, so the room can see Sotto hear, think and wait rather
 * than only see what it has already said. `nowState` decides which.
 */
import type { SessionInfo, SpeakerNames, StageCard, TurnUpdate, WaitingLine } from "../../shared/index.js";
import { SOTTO_SPEAKER, describeSource } from "../../shared/index.js";
import { KIND_LABEL } from "./Card.js";
import type { NowState } from "./stageView.js";
import type { AttentionMode } from "./useAttention.js";

export interface NowProps {
  state: NowState;
  session: SessionInfo | null;
  turnCount: number;
  /** The turn somebody is in the middle of, faded through while listening. */
  live: TurnUpdate | null;
  speakers: SpeakerNames;
  /** Stops the voice mid-sentence (V2-004). */
  onStopVoice?: (() => void) | undefined;
}

/** What a waiting line is called on the stage, by the queue's own kind. */
const WAITING_LABEL: Record<string, string> = {
  reserve: "Claim",
  no_answer: "Closing out",
  answer: "Answer",
  correction: "Correction",
  readback: "Read-back",
  offer: "Offer",
  called_on: "Called on",
  ideas: "Ideas",
};

export function Now({ state, session, turnCount, live, speakers, onStopVoice }: NowProps) {
  return (
    <div className="now" data-testid="now" data-state={state.kind} data-idle={session === null ? "true" : undefined}>
      {state.kind === "speaking" && (
        <Speaking text={state.text} heardChars={state.heardChars} playing={state.playing} onStop={onStopVoice} />
      )}
      {state.kind === "working" && <Working card={state.card} />}
      {state.kind === "waiting" && <Waiting line={state.line} behind={state.behind} />}
      {state.kind === "listening" && (
        <Listening session={session} turnCount={turnCount} live={live} speakers={speakers} />
      )}
    </div>
  );
}

function Pulse() {
  return <span className="now__pulse" aria-hidden="true" />;
}

function Speaking({
  text,
  heardChars,
  playing,
  onStop,
}: {
  text: string;
  heardChars: number;
  playing: boolean;
  onStop?: (() => void) | undefined;
}) {
  // The words the room has heard, and the ones still to come: the split is
  // the synthesis alignment's, at a word boundary so a word never lights up
  // half way through.
  const at = wordBoundary(text, Math.min(heardChars, text.length));
  return (
    // The old `voice-speaking` indicator, in its new place: the checks that
    // wait for `data-playing="true"` read it here.
    <div role="status" data-testid="voice-speaking" data-playing={playing}>
      <p className="now__state">
        <Pulse />
        Speaking
      </p>
      <p className="now__words" data-testid="now-words">
        {text === "" ? (
          <span className="now__ahead">…</span>
        ) : (
          <>
            <span className="now__heard" data-testid="now-heard">{text.slice(0, at)}</span>
            <span className="now__ahead">{text.slice(at)}</span>
          </>
        )}
      </p>
      {onStop !== undefined && (
        <button type="button" className="now__stop" data-testid="voice-stop" onClick={onStop}>
          Stop speaking
        </button>
      )}
    </div>
  );
}

function Working({ card }: { card: StageCard }) {
  const research = card.variant === "research";
  // A question's pending card (V3-003) carries "Looking up:" in its own
  // headline, and the state says that already.
  const question = card.question ?? card.headline.replace(/^(looking up|research ready):\s*/i, "");
  return (
    <div>
      <p className="now__state">
        <Pulse />
        {research ? "Looking up" : "Answering"}
      </p>
      <p className="now__text" data-testid="now-text">
        {question === "" ? "…" : question}
      </p>
      {card.askedBy !== undefined && card.askedBy !== "" && (
        <p className="now__sub">{card.askedBy === "typed" ? "typed into the box" : `${card.askedBy} asked`}</p>
      )}
      {research && <p className="now__sub">wondered aloud — {KIND_LABEL.research.toLowerCase()} on its way</p>}
      <div className="now__progress" aria-hidden="true">
        <i />
      </div>
    </div>
  );
}

function Waiting({ line, behind }: { line: WaitingLine; behind: number }) {
  return (
    <div>
      <p className="now__state">
        <Pulse />
        {line.asked === true ? "Up next" : "Waiting for a gap"}
        <span className="now__kind">{WAITING_LABEL[line.kind] ?? line.kind}</span>
      </p>
      <p className="now__text" data-testid="now-text">
        {line.text}
      </p>
      <p className="now__sub">
        {line.asked === true ? "the room asked for this" : "will say it when the room goes quiet"}
        {behind > 0 && ` · ${behind} more behind it`}
      </p>
    </div>
  );
}

function Listening({
  session,
  turnCount,
  live,
  speakers,
}: {
  session: SessionInfo | null;
  turnCount: number;
  live: TurnUpdate | null;
  speakers: SpeakerNames;
}) {
  return (
    <div>
      <p className="now__state">
        <Pulse />
        {session === null ? "Not listening" : "Listening"}
      </p>
      {live !== null && session !== null && (
        <p className="now__live" data-testid="now-live">
          <span className="now__live-speaker">{speakerText(live.speaker, speakers)}</span> {live.text}
          {!live.final && <span className="now__cursor" aria-hidden="true" />}
        </p>
      )}
      <p className="now__sub stage__hint" data-testid="session-state">
        {session === null
          ? "Sotto listens to a brainstorm and speaks up only when it matters."
          : `Listening to ${describeSource(session.source)} — ${turnCount} turns so far.`}
      </p>
    </div>
  );
}

function speakerText(label: string | null, speakers: SpeakerNames): string {
  if (label === null) return "";
  if (label === SOTTO_SPEAKER) return `${SOTTO_SPEAKER}:`;
  return `${speakers[label] ?? label}:`;
}

/** The last word boundary at or before `at`, so a word lights up whole. */
export function wordBoundary(text: string, at: number): number {
  if (at >= text.length) return text.length;
  if (at <= 0) return 0;
  if (text[at] === " ") return at;
  const space = text.lastIndexOf(" ", at);
  return space === -1 ? 0 : space;
}

/**
 * "Sotto is listening", pinned to the top of the stage (US-017, V3-014).
 *
 * Its own strip rather than a state of Now, so a lookup or a line waiting
 * for a gap stays visible underneath while somebody is still asking — and so
 * it sits in one fixed place the room learns to glance at. The checks read
 * the same test id they always did.
 */
export function Attention({ mode }: { mode: AttentionMode }) {
  if (mode === "stopped") {
    return (
      <p className="attention attention--stopped" data-testid="wake-stopped" role="status">
        Sotto is no longer listening — say its name to ask
      </p>
    );
  }
  const inConversation = mode === "conversation";
  return (
    <p
      className={`attention${inConversation ? " attention--conversation" : ""}`}
      data-testid="wake-listening"
      data-in-conversation={inConversation ? "true" : "false"}
      role="status"
    >
      <Pulse />
      {inConversation ? "Sotto is listening — carry on, no name needed" : "Sotto is listening"}
    </p>
  );
}
