import {
  DISMISSAL_CATEGORIES,
  FIRST_FIX,
  type DismissalCategory,
  type TriageStatus,
} from "../vocabulary";

export interface UndoRecord {
  /** Identity across the copies `categorize` makes; ids repeat, records do not. */
  seq: number;
  id: number;
  title: string;
  from: TriageStatus;
  /** The category `from` carried, so undoing restores the whole dismissal. */
  fromCategory: DismissalCategory | null;
  to: TriageStatus;
  /** Set by a digit after `d`; see `categorize`. */
  category?: DismissalCategory;
  /** Set once where an `acted` finding was posted has been recorded. */
  posted?: string;
}

/**
 * The decision just made, floating above the action bar: what it was, how to
 * take it back, and the one follow-up it invites. Belongs to the undo record,
 * not the selection, which the decision has already moved on — so it stays up
 * while the operator reads the next finding, and nothing waits for it.
 */
export function UndoToast({
  undo,
  onUndo,
  onCategorize,
  onPosted,
  onClose,
}: {
  undo: UndoRecord;
  onUndo: () => void;
  onCategorize: (category: DismissalCategory) => void;
  onPosted: (where: string) => void;
  /** Keeps the decision; only the offer to undo it, and its follow-up, go. */
  onClose: () => void;
}) {
  const label = undo.to === "new" ? "Back to new" : undo.to[0]!.toUpperCase() + undo.to.slice(1);
  return (
    <div className="toast" role="region" aria-label="Last decision">
      <div className="toast-head">
        <span aria-live="polite">
          <span className="dot" data-status={undo.to} />
          <b>
            {label}
            {undo.category && ` · ${undo.category}`}
          </b>{" "}
          <span className="muted">{undo.title}</span>
        </span>
        <button onClick={onUndo} aria-keyshortcuts="U">
          Undo <kbd>u</kbd>
        </button>
        <button
          className="icon"
          aria-label="Close"
          title="Close. The decision stays; it can no longer be undone with u."
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {undo.to === "dismissed" &&
        (undo.category ? (
          FIRST_FIX[undo.category] && (
            <p className="muted small">First fix: {FIRST_FIX[undo.category]}</p>
          )
        ) : (
          <div className="reasons" role="group" aria-label="Why it should not have been shown">
            {DISMISSAL_CATEGORIES.map((c, i) => (
              <button
                key={c}
                title={FIRST_FIX[c] ? `First fix: ${FIRST_FIX[c]}` : undefined}
                aria-keyshortcuts={String(i + 1)}
                onClick={() => onCategorize(c)}
              >
                <kbd>{i + 1}</kbd> {c}
              </button>
            ))}
          </div>
        ))}
      {undo.to === "acted" &&
        (undo.posted ? (
          <p className="muted small">Posted: {undo.posted}</p>
        ) : (
          <p className="posted small">
            <input
              // Keyed to the record, so the next `a` starts empty.
              key={undo.seq}
              autoFocus
              aria-label="Where was it posted"
              placeholder="Where was it posted?"
              onKeyDown={(event) => {
                if (event.key === "Enter") onPosted(event.currentTarget.value);
                if (event.key === "Escape") event.currentTarget.blur();
              }}
            />
            {/* Beside the field, not in its placeholder: typing hides a
                placeholder, and this is how keyboard review resumes. */}
            <span className="muted">
              <kbd>Enter</kbd> adds it to the note · <kbd>Esc</kbd> skips
            </span>
          </p>
        ))}
    </div>
  );
}
