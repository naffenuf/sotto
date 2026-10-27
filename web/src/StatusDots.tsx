import type { StatusChannel, StatusState, StatusUpdate } from "../../shared/index.js";
import { statusChannels } from "../../shared/index.js";

/**
 * What each state is called next to its dot. `server` reads as a connection
 * because that is what it is; the other two read as what they are doing.
 */
const LABELS: Record<StatusChannel, Record<StatusState, string>> = {
  server: {
    idle: "disconnected",
    connecting: "connecting",
    active: "connected",
    error: "disconnected",
  },
  transcription: { idle: "idle", connecting: "connecting", active: "listening", error: "error" },
  model: { idle: "idle", connecting: "thinking", active: "ready", error: "error" },
};

export interface StatusDotsProps {
  statuses: Record<StatusChannel, StatusUpdate>;
}

/** The three dots in the header: server, transcription, model. */
export function StatusDots({ statuses }: StatusDotsProps) {
  return (
    <div className="dots">
      {statusChannels.map((channel) => {
        const status = statuses[channel];
        return (
          <span
            key={channel}
            className={`status status--${status.state}`}
            data-testid={`status-${channel}`}
            data-state={status.state}
            title={status.detail ?? `${channel}: ${LABELS[channel][status.state]}`}
          >
            <span className="status__dot" aria-hidden="true" />
            {channel}: {LABELS[channel][status.state]}
          </span>
        );
      })}
    </div>
  );
}
