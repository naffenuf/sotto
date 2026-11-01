/**
 * A boolean the browser remembers (a collapsed section, say), so a screen set
 * up once stays set up across reloads. Per browser, never shared: this is a
 * viewing preference, not session state, which is why it is `localStorage`
 * rather than the bus. Storage can be missing or refused (private windows,
 * blocked site data), so every touch is guarded and the page works without it.
 */
import { useCallback, useState } from "react";

const PREFIX = "sotto:";

function readFlag(key: string): boolean | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? null : raw === "1";
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(PREFIX + key, value ? "1" : "0");
  } catch {
    // Nothing to do: the choice holds for this page and is forgotten after.
  }
}

/**
 * The stored value, or `fallback` until the user has ever chosen one. The
 * fallback may change (the history list closes while a session runs) and is
 * followed until a choice is made; after that the choice wins.
 */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [stored, setStored] = useState<boolean | null>(() => readFlag(key));
  const set = useCallback(
    (value: boolean) => {
      setStored(value);
      writeFlag(key, value);
    },
    [key],
  );
  return [stored ?? fallback, set];
}
