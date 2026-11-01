/**
 * A sidebar section that folds: a title row that toggles it, and a body that
 * fills what is left when it is open. The notes and the list of previous
 * discussions are folds under the transcript, so a reader sees the
 * conversation and the board at once and can give either the room.
 */
import type { ReactNode } from "react";

export interface FoldProps {
  title: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** A `data-testid`, and the modifier class `fold--<name>`. */
  name: string;
  /** Rendered at the right of the title row, open or closed. */
  aside?: ReactNode;
  children: ReactNode;
}

export function Fold({ title, open, onToggle, name, aside, children }: FoldProps) {
  return (
    <section className={`fold fold--${name}${open ? " fold--open" : ""}`} data-testid={name} data-open={open}>
      <div className="fold__row">
        <button
          type="button"
          className="fold__toggle"
          aria-expanded={open}
          data-testid={`${name}-toggle`}
          onClick={() => onToggle(!open)}
        >
          <span className="fold__chevron" aria-hidden="true">{open ? "▾" : "▸"}</span> {title}
        </button>
        {aside}
      </div>
      {open && <div className="fold__body">{children}</div>}
    </section>
  );
}
