import { useEffect, useId, useRef } from "react";
import { type DraftKind, type TriageStatus } from "../vocabulary";
import { KEY_FOR } from "./keyboard";
import { NewTab } from "./new-tab";

/**
 * What each decision says about Obserf, on the button that makes it. `skipped`
 * and `dismissed` both clear a finding away, so the difference has to be
 * stated where the choice is made: one is a positive label, the other a miss.
 */
const STATUS_MEANING: Record<TriageStatus, string> = {
  new: "Not decided yet",
  shortlisted: "Worth pursuing",
  skipped: "A good finding you will not pursue — counts as Obserf being right",
  dismissed: "Obserf should not have shown this — counts against it; say why with a digit",
  acted: "You posted something",
};

/**
 * The four decisions on the action bar, each with the few words that tell it
 * apart from its neighbour; the button's title carries `STATUS_MEANING`.
 */
const DECISIONS: ReadonlyArray<[status: TriageStatus, label: string, caption: string]> = [
  ["shortlisted", "Shortlist", "act on later"],
  ["skipped", "Skip", "good find · not pursuing"],
  ["dismissed", "Dismiss", "shouldn't have surfaced"],
  ["acted", "Acted", "you posted it"],
];

/**
 * Pinned to the bottom of the detail pane, so a decision never needs a scroll
 * back up past a long excerpt or a draft. Every button shows its key.
 */
export function ActionBar({
  status,
  onDecide,
  url,
  sourceId,
  draftKinds,
  suggestedKind,
  drafting,
  onDraft,
}: {
  status: TriageStatus;
  onDecide: (status: TriageStatus) => void;
  url: string;
  sourceId: string;
  /** Empty when drafting is off; the reason is shown in the pane above. */
  draftKinds: readonly DraftKind[];
  suggestedKind: DraftKind | null;
  drafting: boolean;
  onDraft: (kind: DraftKind) => void;
}) {
  const menuId = useId();
  /**
   * The bar's height, published on the detail column for the toast floating
   * above it where anchor positioning is missing: the bar wraps to two rows in
   * a narrow pane, and a fixed offset then covers its top row.
   */
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    const column = el?.closest<HTMLElement>(".detail-column");
    if (!el || !column) return;
    const observer = new ResizeObserver(() =>
      column.style.setProperty("--bar-height", `${el.offsetHeight}px`),
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      column.style.removeProperty("--bar-height");
    };
  }, []);
  // The suggestion is the main button; the menu offers the rest, or every kind
  // when there is nothing to suggest.
  const primary = suggestedKind && draftKinds.includes(suggestedKind) ? suggestedKind : null;
  const others = draftKinds.filter((k) => k !== primary);
  return (
    <div className="action-bar" ref={bar}>
      <div className="decisions">
        {DECISIONS.map(([s, label, caption]) => (
          <button
            key={s}
            className="stacked"
            data-status={s}
            title={STATUS_MEANING[s]}
            aria-pressed={s === status}
            aria-keyshortcuts={KEY_FOR[s]?.toUpperCase()}
            onClick={() => s !== status && onDecide(s)}
          >
            <span>
              {label} <kbd>{KEY_FOR[s]}</kbd>
            </span>
            <span className="caption">{caption}</span>
          </button>
        ))}
        {status !== "new" && (
          <button title={STATUS_MEANING.new} aria-keyshortcuts="N" onClick={() => onDecide("new")}>
            New <kbd>n</kbd>
          </button>
        )}
      </div>
      <div className="tools">
        <a
          className="button stacked"
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-keyshortcuts="O"
        >
          <span>
            Open page
            <NewTab /> <kbd>o</kbd>
          </span>
          <span className="caption">
            {sourceId === "github" ? "review the repository" : "read the page"}
          </span>
        </a>
        {draftKinds.length > 0 && (
          <div className="split">
            {primary && (
              <button
                className="stacked"
                title={`Draft a ${primary}: text for you to review. Obserf never posts.`}
                aria-keyshortcuts="Shift+W"
                disabled={drafting}
                onClick={() => onDraft(primary)}
              >
                <span>
                  {drafting ? (
                    "Writing…"
                  ) : (
                    <>
                      Draft<span className="kind"> {primary}</span>
                    </>
                  )}{" "}
                  <kbd>⇧W</kbd>
                </span>
                <span className="caption">uses model quota</span>
              </button>
            )}
            {others.length > 0 && (
              <>
                <button
                  className={primary ? "more" : "stacked"}
                  popoverTarget={menuId}
                  aria-label={primary ? "Draft another kind" : undefined}
                  title={primary ? "Draft another kind" : undefined}
                  disabled={drafting}
                >
                  {primary ? (
                    "▾"
                  ) : (
                    <>
                      <span>{drafting ? "Writing…" : "Draft ▾"}</span>
                      <span className="caption">uses model quota</span>
                    </>
                  )}
                </button>
                <div id={menuId} popover="auto" className="menu">
                  {others.map((k) => (
                    <button
                      key={k}
                      popoverTarget={menuId}
                      popoverTargetAction="hide"
                      disabled={drafting}
                      onClick={() => onDraft(k)}
                    >
                      Draft {k}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
