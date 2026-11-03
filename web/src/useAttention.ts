/**
 * What the strip at the top of the stage says about Sotto's attention.
 *
 * `listening` while somebody is addressing it by name, `conversation` while
 * the follow-up window is open, and — for a few seconds after either ends —
 * `stopped`, so the room sees that it has to say the name again rather than
 * finding out by being ignored. Nothing at all once that has faded, and
 * nothing when a session ends.
 */
import { useEffect, useRef, useState } from "react";

export type AttentionMode = "listening" | "conversation" | "stopped";

/** How long "no longer listening" stays up. */
export const STOPPED_MS = 4_000;

export function useAttention(
  listening: boolean,
  inConversation: boolean,
  running: boolean,
): AttentionMode | null {
  const [stopped, setStopped] = useState(false);
  const was = useRef(false);

  useEffect(() => {
    if (listening) {
      was.current = true;
      setStopped(false);
      return;
    }
    if (!was.current) return;
    was.current = false;
    if (!running) return;
    setStopped(true);
    const timer = window.setTimeout(() => setStopped(false), STOPPED_MS);
    return () => window.clearTimeout(timer);
  }, [listening, running]);

  if (listening) return inConversation ? "conversation" : "listening";
  return stopped && running ? "stopped" : null;
}
