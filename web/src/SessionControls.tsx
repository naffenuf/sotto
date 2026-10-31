import type { Chattiness, SessionSource } from "../../shared/index.js";
import { chattinessLevels } from "../../shared/index.js";

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
  /** True while a session is running, which is what the buttons key off. */
  running: boolean;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  /** How talkative Sotto is (US-014), as the server last reported it. */
  chattiness: Chattiness;
  /** Changes it mid-conversation: the policy picks it up at once. */
  onChattinessChange: (chattiness: Chattiness) => void;
}

/** Source selector, chattiness and Start / Stop, in the header. */
export function SessionControls({
  running,
  busy,
  onStart,
  onStop,
  chattiness,
  onChattinessChange,
}: SessionControlsProps) {
  return (
    <div className="controls">
      <label className="controls__label" htmlFor="chattiness">
        Chattiness
      </label>
      <select
        id="chattiness"
        className="controls__select"
        data-testid="chattiness-select"
        value={chattiness}
        onChange={(event) => onChattinessChange(event.target.value as Chattiness)}
      >
        {chattinessLevels.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="controls__button"
        data-testid="start-session"
        disabled={running || busy}
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
