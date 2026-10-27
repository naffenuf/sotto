/**
 * The live transcript: one row per turn, newest at the bottom (US-007).
 *
 * Turns arrive over `/ws/events` as snapshots — several partials, then a
 * final one — so a row changes under the reader rather than repeating. A
 * partial is gray and italic, which is the only signal that the words may
 * still change; a partial also has no diarization label yet, so its chip
 * stays blank until the API sends one.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { SpeakerNames, TurnUpdate } from "../../shared/index.js";

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

/** The colour of a diarization label, or a muted grey while there is none. */
export function speakerColor(label: string | null): string {
  if (label === null) return "#6f6a60";
  let hash = 0;
  for (const character of label) hash = (hash * 31 + character.charCodeAt(0)) % 4096;
  return SPEAKER_COLORS[hash % SPEAKER_COLORS.length] ?? SPEAKER_COLORS[0];
}

/** What the chip says: the name the user gave, or the bare label. */
function speakerText(label: string | null, speakers: SpeakerNames): string {
  if (label === null) return "…";
  return speakers[label] ?? label;
}

export interface TranscriptPanelProps {
  turns: TurnUpdate[];
  speakers: SpeakerNames;
  /** Saves a display name for one label; `null` goes back to the bare label. */
  onRename: (label: string, name: string | null) => void;
}

export function TranscriptPanel({ turns, speakers, onRename }: TranscriptPanelProps) {
  const list = useRef<HTMLDivElement>(null);
  /** True while the newest turn should stay in view. */
  const [following, setFollowing] = useState(true);
  /** The label being named, or `null` when nobody is being named. */
  const [editing, setEditing] = useState<string | null>(null);

  // Before the browser paints the new row, not after, so the list never
  // flashes the second-to-last turn.
  useLayoutEffect(() => {
    const node = list.current;
    if (node === null || !following) return;
    node.scrollTop = node.scrollHeight;
  }, [turns, following]);

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
      <h2 className="panel__title">Transcript</h2>
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
          turns.map((turn) => (
            <p
              key={turn.turnId}
              className={`turn ${turn.final ? "turn--final" : "turn--partial"}`}
              data-testid="turn"
              data-turn-id={turn.turnId}
              data-final={turn.final}
              data-speaker={turn.speaker ?? ""}
            >
              <button
                type="button"
                className="turn__chip"
                data-testid="speaker-chip"
                style={{ background: speakerColor(turn.speaker), color: "#11100e" }}
                disabled={turn.speaker === null}
                title={
                  turn.speaker === null
                    ? "waiting for the speaker label"
                    : `Name speaker ${turn.speaker}${turn.speakerMappingUncertain ? " (this label is a guess after a reconnect)" : ""}`
                }
                onClick={() => setEditing(turn.speaker)}
              >
                {speakerText(turn.speaker, speakers)}
                {/* A label from a later ASR session is a guess, not a fact
                    (`fixtures/events/NOTES.md`), so it is marked as one. */}
                {turn.speakerMappingUncertain && <span className="turn__guess">?</span>}
              </button>{" "}
              <span className="turn__text">{turn.text.trim()}</span>
            </p>
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
