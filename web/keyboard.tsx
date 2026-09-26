import { useEffect, useRef } from "react";
import { DISMISSAL_CATEGORIES, type TriageStatus } from "../vocabulary";

/**
 * Triage from the keyboard. `x` for skipped: `s` is taken, and a skip crosses a
 * good finding off without calling it a mistake, which is what `d` says.
 */
export const TRIAGE_KEYS = {
  n: "new",
  s: "shortlisted",
  x: "skipped",
  d: "dismissed",
  a: "acted",
} as const satisfies Record<string, TriageStatus>;

export const KEY_FOR: Partial<Record<TriageStatus, string>> = Object.fromEntries(
  Object.entries(TRIAGE_KEYS).map(([key, status]) => [status, key]),
);

/**
 * The key map shown by `?`, grouped by what the operator is doing. The one place
 * the keys are described, so it must change with the handlers in `App` and
 * `Detail`.
 */
const SHORTCUTS: ReadonlyArray<{
  title: string;
  keys: ReadonlyArray<[keys: string[], does: string]>;
}> = [
  {
    title: "Move",
    keys: [
      [["j", "↓"], "next finding"],
      [["k", "↑"], "previous finding"],
      [["o"], "open the page"],
      [["?"], "show or hide this list"],
    ],
  },
  {
    title: "Decide",
    keys: [
      [["s"], "shortlist · worth pursuing"],
      [["x"], "skip · a good finding you will not pursue"],
      [["d"], "dismiss · should not have been shown, counts against the ranking"],
      [["a"], "acted · you posted something"],
      [["n"], "back to new"],
      [["u"], "undo the last status change"],
    ],
  },
  {
    title: "Judgment and drafts",
    keys: [
      [["r"], "reveal hidden judgment"],
      [["⇧W"], "write the suggested draft · uses model quota"],
      [["c"], "copy the newest draft"],
    ],
  },
  {
    title: "Right after deciding",
    keys: [
      [[`1–${DISMISSAL_CATEGORIES.length}`], "after d: why it should not have been shown"],
      [["Enter"], "after a: add where you posted to the note"],
      [["Esc"], "after a: leave the note as it is"],
    ],
  },
];

/**
 * Whether a keystroke is the inbox's to take: no modifier beyond Shift, and not
 * typed into a field. Text boxes and a select's type-ahead own their letters;
 * buttons, links and checkboxes use no letter, digit or arrow, so keys pass
 * through them — a mouse click on one must not strand the keyboard mid-queue.
 */
export function isShortcut(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  // A modal dialog owns the keyboard. An open menu does too, even though it is
  // not modal: a key meant for it must not triage or move the selection.
  if (document.querySelector("dialog:modal, :popover-open")) return false;
  const target = event.target as HTMLElement | null;
  return !target?.closest('textarea, select, input:not([type="checkbox"]), [contenteditable]');
}

/**
 * The `?` overlay. A native modal dialog, so focus is trapped and returned and
 * Esc closes it without code here; `isShortcut` stands the page's keys down
 * while it is open. `?` closes it too, and so does a click on the backdrop,
 * which is the only place the dialog element itself receives one.
 */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="shortcuts"
      aria-labelledby="shortcuts-title"
      onClose={onClose}
      onClick={(event) => event.target === event.currentTarget && onClose()}
      onKeyDown={(event) => {
        if (event.key === "?") {
          // Not only default: once this closes the dialog, App's window
          // listener no longer sees a modal and would open it again.
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div>
        <header>
          <h2 id="shortcuts-title">Keyboard</h2>
          <span className="muted small">
            Keys act on the selected finding and are off while you type. <kbd>?</kbd> or{" "}
            <kbd>Esc</kbd> closes.
          </span>
        </header>
        <div className="groups">
          {SHORTCUTS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.keys.map(([keys, does]) => (
                  <div key={does}>
                    <dt>
                      {keys.map((key, i) => (
                        <span key={key}>
                          {i > 0 && " / "}
                          <kbd>{key}</kbd>
                        </span>
                      ))}
                    </dt>
                    <dd>{does}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </dialog>
  );
}
