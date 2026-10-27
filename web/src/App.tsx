import { useServerStatus } from "./useServerStatus.js";

const STATUS_LABEL: Record<ReturnType<typeof useServerStatus>, string> = {
  connecting: "server: connecting",
  connected: "server: connected",
  disconnected: "server: disconnected",
};

export function App() {
  const status = useServerStatus();

  return (
    <div className="app">
      <header className="header">
        <h1 className="brand">Sotto</h1>
        <span className={`status status--${status}`} data-testid="server-status">
          <span className="status__dot" aria-hidden="true" />
          {STATUS_LABEL[status]}
        </span>
      </header>
      <main className="stage">
        <p className="stage__hint">
          Sotto listens to a brainstorm and speaks up only when it matters.
        </p>
      </main>
    </div>
  );
}
