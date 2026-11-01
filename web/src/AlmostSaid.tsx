/**
 * The "almost said" tray (PRD V3-016).
 *
 * Everything on the stage is something Sotto decided was worth a card. This is
 * the other side of that: the contradictions, the questions nobody answered
 * and the numbers that looked wrong which it noticed and kept to itself —
 * below the cards, collapsed, with the policy's own reason beside each one.
 *
 * It is built from the same records `digest.md`'s "What Sotto almost said" is
 * rendered from ({@link SuppressedCandidate}), published on `/ws/events` as
 * the policy decides, so nothing here is computed in the browser and nothing
 * has to wait for Stop. Restraint made visible, which is the cheapest
 * demonstration of judgment there is — and the one thing a group reading its
 * own notes would otherwise never find out about.
 */
import { useState } from "react";
import type { SuppressedCandidate } from "../../shared/index.js";

export interface AlmostSaidProps {
  /** What the policy held back this session, best first. */
  held: readonly SuppressedCandidate[];
}

/** The toggle's label. One thought is not "1 things". */
export function almostSaidLabel(count: number): string {
  return `${count} thing${count === 1 ? "" : "s"} Sotto didn’t say`;
}

/** Collapsed by default: it is a record, not a contribution. */
export function AlmostSaid({ held }: AlmostSaidProps) {
  const [open, setOpen] = useState(false);
  if (held.length === 0) return null;

  return (
    <div className="almost-said" data-testid="almost-said">
      <button
        type="button"
        className="stage__tray-toggle"
        data-testid="almost-said-toggle"
        aria-expanded={open}
        data-count={held.length}
        onClick={() => setOpen((shown) => !shown)}
      >
        {almostSaidLabel(held.length)} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <ul className="almost-said__list" data-testid="almost-said-list">
          {held.map((one) => (
            <li key={one.candidateId} className="almost-said__item">
              <span className="almost-said__headline">{one.headline}</span>
              <span className="almost-said__reason">
                {words(one.type)} · {one.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A type as a person reads it: `untested_assumption` → untested assumption. */
function words(value: string): string {
  return value.replaceAll("_", " ");
}
