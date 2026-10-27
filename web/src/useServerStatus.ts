import { useEffect, useState } from "react";
import type { HealthResponse } from "../../shared/index.js";

export type ServerStatus = "connecting" | "connected" | "disconnected";

const POLL_INTERVAL_MS = 5_000;

/** Polls `/api/health` and reports whether the local server is answering. */
export function useServerStatus(): ServerStatus {
  const [status, setStatus] = useState<ServerStatus>("connecting");

  useEffect(() => {
    let cancelled = false;

    async function check(): Promise<void> {
      try {
        const response = await fetch("/api/health");
        const body = (await response.json()) as HealthResponse;
        if (!cancelled) setStatus(response.ok && body.ok === true ? "connected" : "disconnected");
      } catch {
        if (!cancelled) setStatus("disconnected");
      }
    }

    void check();
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return status;
}
