import type { FixtureListResponse, SessionSource } from "../../shared/index.js";

/**
 * The selector's option values, since a `<select>` only carries strings:
 * `wav:<fixture>`, `events:<fixture>` or `mic`.
 */
export function sourceValue(source: SessionSource): string {
  return source.kind === "mic" ? "mic" : `${source.kind}:${source.fixture}`;
}

/** Reads an option value back, or `null` if it is not one we wrote. */
export function parseSourceValue(value: string): SessionSource | null {
  if (value === "mic") return { kind: "mic" };
  const [kind, fixture] = value.split(":", 2);
  if (fixture === undefined || fixture === "") return null;
  if (kind === "wav" || kind === "events") return { kind, fixture };
  return null;
}

export interface SessionControlsProps {
  fixtures: FixtureListResponse;
  value: string;
  onChange: (value: string) => void;
  /** True while a session is running, which is what the buttons key off. */
  running: boolean;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}

/** Source selector plus Start / Stop, in the header. */
export function SessionControls({
  fixtures,
  value,
  onChange,
  running,
  busy,
  onStart,
  onStop,
}: SessionControlsProps) {
  const micSelected = value === "mic";
  return (
    <div className="controls">
      <label className="controls__label" htmlFor="source">
        Source
      </label>
      <select
        id="source"
        className="controls__select"
        data-testid="source-select"
        value={value}
        disabled={running}
        onChange={(event) => onChange(event.target.value)}
      >
        <optgroup label="Audio (live transcription)">
          {fixtures.wav.map((fixture) => (
            <option key={`wav:${fixture}`} value={`wav:${fixture}`}>
              {fixture}
            </option>
          ))}
          {/* The mic lands in US-012; the option is here so the shape is visible. */}
          <option value="mic" disabled>
            Microphone (not yet)
          </option>
        </optgroup>
        <optgroup label="Captured events (replayed at 1x)">
          {fixtures.events.map((fixture) => (
            <option key={`events:${fixture}`} value={`events:${fixture}`}>
              Replay events: {fixture}
            </option>
          ))}
        </optgroup>
      </select>
      <button
        type="button"
        className="controls__button"
        data-testid="start-session"
        disabled={running || busy || micSelected || value === ""}
        onClick={onStart}
      >
        Start
      </button>
      <button
        type="button"
        className="controls__button"
        data-testid="stop-session"
        disabled={!running || busy}
        onClick={onStop}
      >
        Stop
      </button>
    </div>
  );
}
