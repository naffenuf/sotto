import type { StatusChannel, StatusState, StatusUpdate } from "../../shared/index.js";
import { statusChannels } from "../../shared/index.js";

/**
 * What each state is called next to its dot. `server` reads as a connection
 * because that is what it is; the others read as what they are doing.
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
  judgment: { idle: "idle", connecting: "checking", active: "ready", error: "off" },
};

/**
 * The one channel whose dot reads out its `detail` rather than its state:
 * `local` and `cloud` are both working, so the state says that it works and
 * the detail says where (V2-010). The tooltip spells out the consequence,
 * since "cloud" is the one that sends the conversation off this Mac.
 */
const JUDGMENT_TITLES: Record<string, string> = {
  local: "judgment: Muse Glimmer, running on this Mac",
  cloud: "judgment: Muse Spark in the cloud — Glimmer is not available",
};

/** What a dot says, and what hovering it says. */
function describe(status: StatusUpdate): { label: string; title: string } {
  const fallback = LABELS[status.channel][status.state];
  if (status.channel === "judgment" && status.detail !== undefined) {
    return {
      label: status.detail,
      title: JUDGMENT_TITLES[status.detail] ?? `judgment: ${status.detail}`,
    };
  }
  return { label: fallback, title: status.detail ?? `${status.channel}: ${fallback}` };
}

export interface StatusDotsProps {
  statuses: Record<StatusChannel, StatusUpdate>;
}

/** The four dots in the header: server, transcription, model, judgment. */
export function StatusDots({ statuses }: StatusDotsProps) {
  return (
    <div className="dots">
      {statusChannels.map((channel) => {
        const status = statuses[channel];
        const { label, title } = describe(status);
        return (
          <span
            key={channel}
            className={`status status--${status.state}`}
            data-testid={`status-${channel}`}
            data-state={status.state}
            data-detail={status.detail ?? ""}
            title={title}
          >
            <span className="status__dot" aria-hidden="true" />
            {channel}: {label}
          </span>
        );
      })}
    </div>
  );
}
