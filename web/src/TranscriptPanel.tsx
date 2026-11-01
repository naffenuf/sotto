/**
 * The live transcript: one row per turn, newest at the bottom (US-007).
 *
 * Turns arrive over `/ws/events` as snapshots — several partials, then a
 * final one — so a row changes under the reader rather than repeating. A
 * partial is gray and italic, which is the only signal that the words may
 * still change; a partial also has no diarization label yet, so its chip
 * stays blank until the API sends one.
 *
 * It is also where an interjection's evidence lands: clicking a quote on a
 * card (US-015) asks this panel to show that turn, which means scrolling to
 * it, marking it, and stopping following the live edge — the reader has gone
 * back to check something and should not be yanked forward again.
 *
 * A row is a run, not a turn (`shared/transcript.ts`): one person carrying on
 * after a breath is one paragraph, with each turn a segment inside it so a
 * cited turn can still be pointed at.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SOTTO_SPEAKER, mergeRuns } from "../../shared/index.js";
import type { SpeakerNames, TranscriptRun, TurnUpdate } from "../../shared/index.js";
import { Marked } from "./Marked.js";
import { matchesQuery, normalizeQuery } from "./search.js";

/** How close to the bottom still counts as following the conversation. */
const AT_BOTTOM_PX = 48;

/**
 * One colour per speaker, picked by label so a speaker keeps its colour for
 * the whole session (and across a reload).
 */
const SPEAKER_COLORS = [
  "#7fb069",
  "#d8a657",
  "#7daea3",
  "#d3869b",
  "#e78a4e",
  "#a9b665",
  "#89b482",
  "#c38080",
] as const;

/** Sotto's own chip colour (V2-008a): the accent, never one of the room's. */
const SOTTO_COLOR = "#86551b";

/** The colour of a diarization label, or a muted grey while there is none. */
export function speakerColor(label: string | null): string {
  if (label === null) return "#6f6a60";
  if (label === SOTTO_SPEAKER) return SOTTO_COLOR;
  let hash = 0;
  for (const character of label) hash = (hash * 31 + character.charCodeAt(0)) % 4096;
  return SPEAKER_COLORS[hash % SPEAKER_COLORS.length] ?? SPEAKER_COLORS[0];
}

/** What the chip says: the name the user gave, or the bare label. */
function speakerText(label: string | null, speakers: SpeakerNames): string {
  if (label === null) return "…";
  // Sotto's label is not a diarization label and is never renamed, so a
  // speaker who happened to be named "Sotto" cannot take it over.
  if (label === SOTTO_SPEAKER) return SOTTO_SPEAKER;
  return speakers[label] ?? label;
}

/**
 * Which turn to show, and a fresh object each time it is asked for: clicking
 * the same quote twice has to scroll twice, so the request carries the moment
 * it was made rather than only the turn.
 */
export interface TurnHighlight {
  turnId: string;
  /** `Date.now()` of the click, which is what makes a repeat a new request. */
  at: number;
}

export interface TranscriptPanelProps {
  turns: TurnUpdate[];
  speakers: SpeakerNames;
  /** Saves a display name for one label; `null` goes back to the bare label. */
  onRename: (label: string, name: string | null) => void;
  /** The turn an evidence quote asked for, or `null` (US-015). */
  highlight?: TurnHighlight | null;
  /** Told the (normalized) search text, so the notes can light up the same word. */
  onSearch?: (query: string) => void;
}

export function TranscriptPanel({
  turns,
  speakers,
  onRename,
  highlight = null,
  onSearch,
}: TranscriptPanelProps) {
  const list = useRef<HTMLDivElement>(null);
  /** True while the newest turn should stay in view. */
  const [following, setFollowing] = useState(true);
  /** The label being named, or `null` when nobody is being named. */
  const [editing, setEditing] = useState<string | null>(null);
  /** What is typed in the search box, and the normalized form everything matches on. */
  const [typed, setTyped] = useState("");
  const query = normalizeQuery(typed);
  /** Which match is being looked at, and when it was asked for (a repeat is a new scroll). */
  const [focus, setFocus] = useState<{ index: number; at: number }>({ index: 0, at: 0 });

  const runs = useMemo(() => mergeRuns(turns), [turns]);
  /** Ids of the rows that contain the query, in order. */
  const matchIds = useMemo(
    () =>
      query === ""
        ? []
        : runs
            .filter((run) => run.segments.some((turn) => matchesQuery(turn.text, query)))
            .map((run) => run.id),
    [runs, query],
  );

  // A new query starts at its first match; the notes hear about it too.
  useEffect(() => {
    setFocus({ index: 0, at: Date.now() });
    onSearch?.(query);
  }, [query, onSearch]);

  // Scroll the current match into view, the way a cited turn is.
  useEffect(() => {
    if (matchIds.length === 0 || focus.at === 0) return;
    const id = matchIds[Math.min(focus.index, matchIds.length - 1)];
    if (id === undefined) return;
    const node = list.current;
    if (node === null) return;
    const row = node.querySelector(`[data-testid="turn"][data-turn-id="${CSS.escape(id)}"]`);
    if (row === null) return;
    setFollowing(false);
    const rowBox = row.getBoundingClientRect();
    const listBox = node.getBoundingClientRect();
    node.scrollTop += rowBox.top - listBox.top - (listBox.height - rowBox.height) / 2;
  }, [focus, matchIds]);

  const step = useCallback(
    (by: number) => {
      setFocus((current) => {
        if (matchIds.length === 0) return current;
        const index = (((current.index + by) % matchIds.length) + matchIds.length) % matchIds.length;
        return { index, at: Date.now() };
      });
    },
    [matchIds.length],
  );

  // Before the browser paints the new row, not after, so the list never
  // flashes the second-to-last turn.
  useLayoutEffect(() => {
    const node = list.current;
    if (node === null || !following) return;
    node.scrollTop = node.scrollHeight;
  }, [turns, following]);

  // After the rows are laid out, so the turn being looked for is on the page.
  useEffect(() => {
    if (highlight === null) return;
    const node = list.current;
    if (node === null) return;
    const row = node
      .querySelector(`[data-turn-id="${CSS.escape(highlight.turnId)}"]`)
      ?.closest('[data-testid="turn"]') ?? null;
    // A cited turn can be off the end of the capped list; there is then
    // nothing to scroll to, and nothing to apologise for either.
    if (row === null) return;
    // Reading an old line is the opposite of following the live edge.
    setFollowing(false);
    // Centred in the list by hand rather than with `scrollIntoView`, which
    // would scroll every ancestor and can take the whole page with it.
    const rowBox = row.getBoundingClientRect();
    const listBox = node.getBoundingClientRect();
    node.scrollTop += rowBox.top - listBox.top - (listBox.height - rowBox.height) / 2;
  }, [highlight]);

  const onScroll = useCallback(() => {
    const node = list.current;
    if (node === null) return;
    const fromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setFollowing(fromBottom <= AT_BOTTOM_PX);
  }, []);

  const jumpToLive = useCallback(() => {
    const node = list.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
    setFollowing(true);
  }, []);

  const save = useCallback(
    (label: string, name: string | null) => {
      setEditing(null);
      onRename(label, name);
    },
    [onRename],
  );

  return (
    <section className="transcript" data-testid="transcript">
      <div className="transcript__header">
        <h2 className="panel__title">Transcript</h2>
        <input
          type="search"
          className="search"
          data-testid="transcript-search"
          placeholder="Find…"
          aria-label="Find in the conversation"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            // Enter walks the matches; Shift+Enter walks them backwards.
            if (event.key === "Enter") {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              setTyped("");
            }
          }}
        />
        {query !== "" && (
          <span className="search__nav" data-testid="search-nav">
            <span className="search__count" data-testid="search-count">
              {matchIds.length === 0 ? "0" : `${Math.min(focus.index, matchIds.length - 1) + 1} of ${matchIds.length}`}
            </span>
            <button type="button" className="search__step" title="Previous match (Shift+Enter)" disabled={matchIds.length === 0} onClick={() => step(-1)}>▲</button>
            <button type="button" className="search__step" title="Next match (Enter)" disabled={matchIds.length === 0} onClick={() => step(1)}>▼</button>
          </span>
        )}
      </div>
      {editing !== null && (
        <SpeakerNameForm
          label={editing}
          current={speakers[editing] ?? ""}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}
      <div className="transcript__list" ref={list} onScroll={onScroll}>
        {turns.length === 0 ? (
          <p className="transcript__empty" data-testid="transcript-empty">
            Nothing yet. Start a session and the conversation shows up here.
          </p>
        ) : (
          runs.map((run) => (
            <TranscriptRow
              key={run.id}
              run={run}
              speakers={speakers}
              citedTurnId={highlight?.turnId ?? null}
              query={query}
              focused={matchIds.length > 0 && run.id === matchIds[Math.min(focus.index, matchIds.length - 1)]}
              onName={setEditing}
            />
          ))
        )}
      </div>
      {!following && (
        <button
          type="button"
          className="transcript__jump"
          data-testid="jump-to-live"
          onClick={jumpToLive}
        >
          ↓ Jump to live
        </button>
      )}
    </section>
  );
}

interface TranscriptRowProps {
  run: TranscriptRun;
  speakers: SpeakerNames;
  citedTurnId: string | null;
  /** The normalized search text, or `""`. */
  query: string;
  /** True for the match being looked at. */
  focused: boolean;
  onName: (label: string | null) => void;
}

/** One paragraph: the chip once, then every turn of the run as a segment. */
function TranscriptRow({ run, speakers, citedTurnId, query, focused, onName }: TranscriptRowProps) {
  const cited = citedTurnId !== null && run.segments.some((turn) => turn.turnId === citedTurnId);
  const matches = query !== "" && run.segments.some((turn) => matchesQuery(turn.text, query));
  // While searching, what does not match steps back rather than disappearing:
  // the conversation around a hit is what makes the hit mean anything.
  const dim = query !== "" && !matches;
  // A row is a partial only while nothing in it is final yet.
  const final = run.segments.some((turn) => turn.final);
  const last = run.segments[run.segments.length - 1];
  return (
    <p
      className={`turn ${final ? "turn--final" : "turn--partial"}${run.sotto ? " turn--sotto" : ""}${
        cited ? " turn--cited" : ""
      }${dim ? " turn--dim" : ""}${focused ? " turn--found" : ""}`}
      data-testid="turn"
      data-match={matches ? true : undefined}
      data-found={focused ? true : undefined}
      data-turn-id={run.id}
      data-turn-ids={run.segments.map((turn) => turn.turnId).join(" ")}
      data-cited={cited ? true : undefined}
      data-final={final}
      data-speaker={run.speaker ?? ""}
      data-sotto={run.sotto ? true : undefined}
      data-interrupted={last?.interrupted === true ? true : undefined}
    >
      <button
        type="button"
        className="turn__chip"
        data-testid="speaker-chip"
        // Sotto's chip is the accent, which needs light ink on it; the
        // room's colours are all pale.
        style={{
          background: speakerColor(run.speaker),
          color: run.sotto ? "#fdfbf7" : "#11100e",
        }}
        // Sotto is not one of the room's labels, so there is no name
        // to give it (V2-008a).
        disabled={run.speaker === null || run.sotto}
        title={
          run.sotto
            ? "Sotto said this out loud"
            : run.speaker === null
              ? "waiting for the speaker label"
              : `Name speaker ${run.speaker}${run.speakerMappingUncertain ? " (this label is a guess after a reconnect)" : ""}`
        }
        onClick={() => onName(run.speaker)}
      >
        {speakerText(run.speaker, speakers)}
        {/* A label from a later ASR session is a guess, not a fact
            (`fixtures/events/NOTES.md`), so it is marked as one. */}
        {run.speakerMappingUncertain && <span className="turn__guess">?</span>}
      </button>{" "}
      <span className="turn__text">
        {run.segments.map((turn, index) => (
          <span
            key={turn.turnId}
            className={`turn__segment${turn.final ? "" : " turn__segment--partial"}${
              turn.turnId === citedTurnId ? " turn__segment--cited" : ""
            }`}
            data-testid="turn-segment"
            data-turn-id={turn.turnId}
            data-final={turn.final}
          >
            {index > 0 ? " " : ""}
            <Marked text={turn.text.trim()} query={query} />
          </span>
        ))}
      </span>
      {/* The room heard this much and no more: the rest was cut off. */}
      {last?.interrupted === true && (
        <span className="turn__interrupted" data-testid="turn-interrupted">
          {" "}
          (interrupted)
        </span>
      )}
    </p>
  );
}

interface SpeakerNameFormProps {
  label: string;
  current: string;
  onSave: (label: string, name: string | null) => void;
  onCancel: () => void;
}

/** The one place a name is typed, whichever row's chip was clicked. */
function SpeakerNameForm({ label, current, onSave, onCancel }: SpeakerNameFormProps) {
  const [value, setValue] = useState(current);

  return (
    <form
      className="rename"
      data-testid="speaker-rename"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(label, value.trim() === "" ? null : value.trim());
      }}
    >
      <label className="rename__label" htmlFor="speaker-name">
        Speaker {label}
      </label>
      <input
        id="speaker-name"
        className="rename__input"
        data-testid="speaker-name-input"
        autoFocus
        maxLength={40}
        placeholder={label}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
      <button type="submit" className="rename__button" data-testid="speaker-name-save">
        Save
      </button>
      <button
        type="button"
        className="rename__button"
        data-testid="speaker-name-cancel"
        onClick={onCancel}
      >
        Cancel
      </button>
    </form>
  );
}
