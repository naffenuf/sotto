import type { Boldness, Frequency, SessionSource } from "../../shared/index.js";
import { boldnessLevels, frequencyLevels } from "../../shared/index.js";

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
  /** How often Sotto contributes (V2-017), as the server last reported it. */
  frequency: Frequency;
  /** Changes it mid-conversation: the policy picks it up at once. */
  onFrequencyChange: (frequency: Frequency) => void;
  /** How sure it has to be before it does (V2-017). */
  boldness: Boldness;
  onBoldnessChange: (boldness: Boldness) => void;
  voiceMuted: boolean;
  onVoiceMutedChange: (muted: boolean) => void;
}

/**
 * The two contribution controls, Mute voice and Start / Stop, in the header.
 *
 * Two selectors rather than one, because V2-017 split what used to be
 * "chattiness" into the two things it conflated: **how often** Sotto speaks
 * up and **how sure** it has to be. They are compact and side by side — the
 * pair is read as one setting — and each is its own `POST`, so a group
 * turning Sotto down without raising its bar does exactly that.
 */
export function SessionControls({
  running,
  busy,
  onStart,
  onStop,
  frequency,
  onFrequencyChange,
  boldness,
  onBoldnessChange,
  voiceMuted,
  onVoiceMutedChange,
}: SessionControlsProps) {
  return (
    <div className="controls">
      <label className="controls__label" htmlFor="frequency">
        How often
      </label>
      <select
        id="frequency"
        className="controls__select controls__select--setting"
        data-testid="frequency-select"
        value={frequency}
        onChange={(event) => onFrequencyChange(event.target.value as Frequency)}
      >
        {frequencyLevels.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      <label className="controls__label" htmlFor="boldness">
        How sure
      </label>
      <select
        id="boldness"
        className="controls__select controls__select--setting"
        data-testid="boldness-select"
        value={boldness}
        onChange={(event) => onBoldnessChange(event.target.value as Boldness)}
      >
        {boldnessLevels.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      <label className="controls__label"><input type="checkbox" checked={voiceMuted} onChange={(event) => onVoiceMutedChange(event.target.checked)} /> Mute voice</label>
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
