import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Run } from "../db/schema";
import {
  DISMISSAL_CATEGORIES,
  TRIAGE_STATUSES,
  compactAge,
  type DismissalCategory,
  type TriageStatus,
} from "../vocabulary";
import { type ListedFinding, messageOf, requestJson, postJson } from "./api";
import { TRIAGE_KEYS, isShortcut, ShortcutsDialog } from "./keyboard";
import { ThemeToggle, applyTheme, storedTheme } from "./theme";
import { type UndoRecord, UndoToast } from "./undo-toast";
import { ScanStatus } from "./scan-status";
import { type TriageOptions, scoreClass, Detail } from "./detail";
import "./app.css";

/**
 * Bound the list request and rendering cost. The toolbar marks a result at the
 * cap; it may be incomplete, including when zero scores are shown.
 */
const LIMIT = 200;

/** localStorage key for the reason-hidden review toggle. */
const HIDE_JUDGMENT_KEY = "obserf.hideJudgment";

function App() {
  /**
   * Null until loaded, with its own error: scan status names each profile without
   * a run, so an unread list must not pass for an empty one, nor its error be
   * cleared by the next list load.
   */
  const [projects, setProjects] = useState<Array<{ key: string; name: string }> | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  /** The profiles on disk do not load; the server is using the last ones that did. */
  const [profileError, setProfileError] = useState<string | null>(null);
  const [project, setProject] = useState("");
  const [status, setStatus] = useState<TriageStatus>("new");
  /**
   * A score control, not a "show rejected" one. `pipeline/score.ts` zeroes
   * anything disqualified, irrelevant, or unwelcome; the operator's own decision
   * is `status`, and never touches the score.
   */
  const [withZeros, setWithZeros] = useState(false);
  /**
   * Reason-hidden review: a `new` finding's score, components, opportunity type
   * and reason stay hidden until it is triaged or revealed, so the operator
   * judges the evidence before the model's explanation can persuade them — the
   * bias docs/product/evaluation.md names. Not blind: the rank order still says
   * what the model rated highest. Per browser, because it is a review habit, and
   * storage can be unavailable, so every access is guarded.
   */
  const [hideJudgment, setHideJudgment] = useState(() => {
    try {
      return localStorage.getItem(HIDE_JUDGMENT_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(HIDE_JUDGMENT_KEY, hideJudgment ? "1" : "0");
    } catch {
      // Unavailable storage only costs remembering the choice.
    }
  }, [hideJudgment]);
  /** Findings revealed with `r`: shown whatever the toggle says. */
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  /**
   * Findings whose judgment was on screen this session: revealed, or listed or
   * opened while hiding was off. A decision about one was not made hidden, even
   * if the toggle hides it again by then. Separate from `revealed` so turning the
   * toggle on still hides what was listed before. Memory only, so a finding seen
   * in an earlier session counts as hidden: the flag measures what this review
   * showed, not everything ever read.
   */
  const exposed = useRef(new Set<number>());
  const reveal = useCallback((id: number) => {
    exposed.current.add(id);
    setRevealed((current) => (current.has(id) ? current : new Set(current).add(id)));
  }, []);
  const [items, setItems] = useState<ListedFinding[] | null>(null);
  /**
   * The latest scan of each project in view; null until loaded, so no project
   * reads as unscanned before the answer arrives. The error is separate: "no scan
   * recorded" and "could not read the record" are different answers.
   */
  const [scans, setScans] = useState<Run[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // With hiding off, every listed score and the open finding's reason are on
  // screen, so each is exposed for the rest of the session.
  useEffect(() => {
    if (hideJudgment) return;
    for (const row of items ?? []) exposed.current.add(row.finding.id);
    if (selectedId !== null) exposed.current.add(selectedId);
  }, [hideJudgment, items, selectedId]);
  /**
   * The single reload trigger. Everything that changes stored state bumps it, so
   * the list and the open detail refresh from one place — and, because the list
   * request is built inside the effect, always under the filters showing now
   * rather than the ones in scope when the mutation started.
   */
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * The last status change, so a mis-keystroke is recoverable. One level and in
   * memory only: this exists because `d` is one key away from `s` and the row
   * vanishes from the filtered list either way, not to be a history.
   */
  const [undo, setUndo] = useState<UndoRecord | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /**
   * The same record for callbacks queued on `chain`, which run after later
   * keystrokes and must see what is current then, not what they closed over.
   */
  const undoRef = useRef<UndoRecord | null>(null);
  const undoSeq = useRef(0);
  /** The `seq` of the record whose undo is in flight, so a digit cannot re-dismiss it. */
  const undoing = useRef<number | null>(null);
  /** The `seq` whose posted location is being saved: an append is not idempotent. */
  const posting = useRef<number | null>(null);
  /**
   * A decision failed or changed nothing after the current undo record was made,
   * so that record no longer names the latest thing the operator did. Category
   * digits are dropped until the next decision lands rather than filed against
   * the wrong finding.
   */
  const staleRecord = useRef(false);
  const recordUndo = useCallback((next: UndoRecord | null) => {
    undoRef.current = next;
    staleRecord.current = false;
    setUndo(next);
  }, []);

  // Filter changes fire overlapping requests; without this the slower earlier
  // one can land last and repopulate the list with the previous filter.
  const listTicket = useRef(0);
  /** The same guard for the scan line, which follows the project filter too. */
  const scanTicket = useRef(0);
  /** Where to land if the current selection leaves the filtered list. */
  const prefer = useRef<number[]>([]);
  const pane = useRef<HTMLDivElement>(null);
  /**
   * Mutations run one at a time. A note saved on blur and the status change from
   * the click that caused that blur are two writes to the same row; left
   * unserialized, the note's write can land second and put the old status back.
   */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * Note edits that have not been saved, by finding id. They outlive the keyed
   * detail pane deliberately: clicking another finding unmounts the component
   * holding the text, and the operator's own reasoning is the one thing here
   * obserf cannot produce again.
   */
  const pendingNotes = useRef(new Map<number, string>()).current;

  /** Everything that writes calls this; the list and the open detail both watch it. */
  const changed = useCallback(() => setRevision((n) => n + 1), []);

  /**
   * A note is the only thing here obserf cannot produce again, and it is saved on
   * blur — so closing the window with the cursor still in the box would take it.
   * Nothing else is worth a prompt: a triage is one keystroke to redo.
   */
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pendingNotes.size) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pendingNotes]);

  // The detail pane keeps its scroll position across a remount, so without this
  // the next finding opens partway down, at wherever the last one was left.
  useEffect(() => {
    pane.current?.scrollTo(0, 0);
  }, [selectedId]);

  // Reloaded on returning to the window, the usual way back from editing a
  // profile, and after every write. The server rereads edited profiles on each
  // request; fetched once, this list would not.
  useEffect(() => {
    // Reloads overlap, and StrictMode mounts twice: only the newest may answer.
    let current = true;
    requestJson<{ projects: Array<{ key: string; name: string }>; profileError: string | null }>(
      "/api/projects",
    )
      .then((loaded) => {
        if (!current) return;
        setProjects(loaded.projects);
        setProfileError(loaded.profileError);
        setProjectsError(null);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setProjects(null);
        // Unknown now, which is weaker than the failure last reported.
        setProfileError(null);
        setProjectsError(messageOf(cause));
      });
    return () => {
      current = false;
    };
  }, [revision]);

  /**
   * Emptied the moment the filters change, and refilled only by the request
   * below. Otherwise a failed reload leaves the previous filter's rows on screen
   * under the new filter's controls — still clickable, still triageable by
   * keystroke — and its finding open in the detail pane with live triage and
   * draft buttons, indefinitely. A background refresh keeps both, so this does
   * not flash on every reload.
   *
   * Toggling `zeros` therefore drops the selection even when the row survives the
   * filter. That is the cheaper mistake: the alternative is machinery to carry a
   * selection across a transition where it may no longer exist.
   */
  useEffect(() => {
    setItems(null);
    setSelectedId(null);
  }, [project, status, withZeros]);

  /**
   * The same for the scan line, on the project alone: status and zeros do not
   * change which scan applies. Left on screen, it would describe another
   * project's scan, and a filtered view drops the label that would betray it.
   */
  useEffect(() => {
    setScans(null);
    setScanError(null);
  }, [project]);

  useEffect(() => {
    const params = new URLSearchParams({
      status,
      min: withZeros ? "0" : "1",
      limit: String(LIMIT),
    });
    if (project) params.set("project", project);

    const ticket = ++listTicket.current;
    const wanted = prefer.current;
    prefer.current = [];

    void (async () => {
      try {
        const rows = await requestJson<ListedFinding[]>(`/api/findings?${params}`);
        if (ticket !== listTicket.current) return;
        setItems(rows);
        setError(null);
        setSelectedId(
          (current) =>
            [current, ...wanted].find(
              (id) => id !== null && rows.some((row) => row.finding.id === id),
            ) ?? null,
        );
      } catch (cause) {
        if (ticket === listTicket.current) setError(messageOf(cause));
      }
    })();
  }, [project, status, withZeros, revision]);

  // Reloaded with the list, not only on a project change, so a scan that finished
  // meanwhile leaves no stale warning. A separate request: each is usable when
  // the other fails.
  useEffect(() => {
    const params = project ? `?project=${encodeURIComponent(project)}` : "";
    const ticket = ++scanTicket.current;

    requestJson<Run[]>(`/api/runs/latest${params}`)
      .then((runs) => {
        if (ticket !== scanTicket.current) return;
        setScans(runs);
        setScanError(null);
      })
      .catch((cause: unknown) => {
        // Guarded too: a superseded failure must not overwrite a newer answer.
        if (ticket === scanTicket.current) setScanError(messageOf(cause));
      });
  }, [project, status, withZeros, revision]);

  // A scan runs in a terminal beside this window, so returning to the tab is the
  // moment the list is most likely to be stale. An unsaved note survives it.
  useEffect(() => {
    window.addEventListener("focus", changed);
    return () => window.removeEventListener("focus", changed);
  }, [changed]);

  const select = useCallback((id: number) => {
    setSelectedId(id);
    // The list scrolls; keyboard selection off-screen would otherwise look like
    // nothing happened.
    document.getElementById(`finding-${id}`)?.scrollIntoView({ block: "nearest" });
  }, []);

  /**
   * The one place triage is written, so a keystroke and a button cannot diverge.
   * Reports failure through the shared banner and returns whether it stuck —
   * the note editor must not clear an edit that was never saved.
   */
  const triage = useCallback(
    (id: number, next: TriageStatus, options: TriageOptions = {}): Promise<boolean> => {
      const { note, appendNote, category, undoable = true, stillWanted, amend } = options;
      const rows = items ?? [];
      const index = rows.findIndex((row) => row.finding.id === id);
      // Recorded before the write: a status change usually removes the finding
      // from the filtered list, and stopping on every triage is the difference
      // between working through an inbox and clicking through one.
      const neighbours =
        index >= 0
          ? [rows[index + 1]?.finding.id, rows[index - 1]?.finding.id].filter(
              (value) => value !== undefined,
            )
          : []; // Not in the visible list — an undo, which moves nothing.
      const title = rows[index]?.finding.title;

      const run = chain.current.then(async () => {
        if (stillWanted && !stillWanted()) return false;
        try {
          const { previous, previousCategory } = await postJson<{
            previous: TriageStatus | null;
            previousCategory: DismissalCategory | null;
          }>(
            `/api/findings/${id}/triage`,
            // What the operator could see while deciding; the server records it
            // only on the first decision out of `new`.
            {
              status: next,
              note,
              appendNote,
              category,
              amend,
              hidden: hideJudgment && !exposed.current.has(id),
            },
          );
          // The server's `previous`, not the rendered row's: a queued write may
          // already have moved it. A note saved on blur posts the status the
          // finding already had, so neither of these applies to it — offering to
          // undo it would be a lie, and advancing the selection would make saving
          // text quietly move the operator somewhere else.
          const moved = previous !== null && previous !== next;
          if (moved) prefer.current = neighbours;
          if (undoable && moved) {
            recordUndo({
              seq: ++undoSeq.current,
              id,
              title: title ?? `#${id}`,
              from: previous,
              fromCategory: previousCategory,
              to: next,
            });
          } else if (undoable) {
            // `d` on a finding already dismissed: the record still names an
            // earlier one, which a digit meant for this one must not reach.
            staleRecord.current = true;
          }
          changed();
          return true;
        } catch (cause) {
          setError(messageOf(cause));
          // The undo record still names the decision before this one, so a
          // digit meant for this one would be filed against that.
          if (undoable) staleRecord.current = true;
          return false;
        }
      });
      // `run` settles rather than rejects, so the queue cannot be poisoned by one
      // failed write.
      chain.current = run;
      return run;
    },
    [items, changed, recordUndo, hideJudgment],
  );

  /**
   * Restores the status only. The note is deliberately left as it stands: undoing
   * a mis-keystroke should not also discard reasoning typed on purpose. Selection
   * does not move either — the operator is still working where they were, and the
   * bar names which finding came back. The record survives a failed undo so it
   * can be retried.
   */
  const undoLast = useCallback(async () => {
    // Undo the latest decision made before `u`, which may still be queued: read
    // now, the record would name the one before it, and that one would be undone
    // while the decision the operator meant stayed.
    await chain.current;
    const record = undoRef.current;
    if (!record || undoing.current === record.seq) return;
    undoing.current = record.seq;
    const ok = await triage(record.id, record.from, {
      undoable: false,
      // Only ever set when `from` is a dismissal, which is where a category is valid.
      category: record.fromCategory ?? undefined,
    });
    if (undoing.current === record.seq) undoing.current = null;
    // Only this record: a change queued behind the undo installs its own while
    // this one is in flight, and that one has not been taken back.
    if (ok && undoRef.current?.seq === record.seq) recordUndo(null);
  }, [triage, recordUndo]);

  /**
   * Drops the offer to undo, never the decision. Queued: a reason or posted
   * location submitted just before still waits on `chain`, and must find the
   * record it names when its turn comes.
   */
  const closeUndo = useCallback(
    (seq: number) => {
      chain.current = chain.current.then(() => {
        if (undoRef.current?.seq === seq) recordUndo(null);
      });
    },
    [recordUndo],
  );

  /**
   * The cause of the latest dismissal, from a digit pressed after `d`. Tied to
   * the undo record rather than to the selection, which `d` has already moved
   * on: the category belongs to the finding just dismissed, and the operator is
   * already looking at the next one. Skippable — nothing waits for it.
   */
  const categorize = useCallback(
    (category: DismissalCategory, forSeq?: number): Promise<boolean> => {
      // Queued when the digit is pressed, so a decision typed after it cannot land
      // first and replace the record it is meant for; resolved at its turn, when
      // every decision typed before it, `d`'s own write included, has landed. Not
      // through `triage`: a category changes no status, moves no selection and
      // installs no undo record.
      const run = chain.current.then(async () => {
        const record = undoRef.current;
        // The server refuses a category once the finding is no longer dismissed;
        // this drops one quietly for what the tab already knows: a dismissal
        // undone, being undone, or no longer the latest decision.
        if (record?.to !== "dismissed" || staleRecord.current || undoing.current === record.seq) {
          return false;
        }
        // A click names the record its toast showed; a digit means whichever
        // dismissal is latest by now, `d`'s own write included.
        if (forSeq !== undefined && record.seq !== forSeq) return false;
        try {
          await postJson(`/api/findings/${record.id}/triage`, {
            status: "dismissed",
            category,
            amend: true,
          });
          const current = undoRef.current;
          if (current?.seq === record.seq) recordUndo({ ...current, category });
          changed();
          return true;
        } catch (cause) {
          setError(messageOf(cause));
          return false;
        }
      });
      chain.current = run;
      return run;
    },
    [recordUndo, changed],
  );

  /**
   * Where an `acted` finding was posted, typed into the undo bar right after
   * `a`. The same reasoning as `categorize`: `a` has moved the selection on, and
   * the operator has just posted, so this is the moment they know the answer.
   * Appended to the note rather than replacing it, and optional. Not the outcome
   * record, which stays blocked until enough findings are acted on to design it.
   */
  const recordPosted = useCallback(
    async (where: string) => {
      const record = undoRef.current;
      if (record?.to !== "acted" || !where.trim() || posting.current === record.seq) return;
      const active = () =>
        undoRef.current?.seq === record.seq &&
        undoing.current !== record.seq &&
        !undoRef.current.posted;
      if (!active()) return;
      posting.current = record.seq;
      // Appended by the server, never re-sent whole: the note may have been
      // edited since `a`, and a copy taken then would overwrite that edit.
      const appendNote = `Posted: ${where.trim()}`;
      const ok = await triage(record.id, "acted", {
        appendNote,
        undoable: false,
        stillWanted: active,
        amend: true,
      });
      if (ok) {
        const current = undoRef.current;
        if (current?.seq === record.seq) recordUndo({ ...current, posted: where.trim() });
      }
      // Released either way: after a failure Enter retries; after success `posted` guards.
      if (posting.current === record.seq) posting.current = null;
    },
    [triage, recordUndo],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isShortcut(event)) return;

      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // Undo must also work after the last row leaves the filtered list.
      if (event.key === "u") {
        event.preventDefault();
        void undoLast();
        return;
      }
      if (event.key === "r" && selectedId !== null) {
        event.preventDefault();
        reveal(selectedId);
        return;
      }
      const category = DISMISSAL_CATEGORIES[Number(event.key) - 1];
      if (category && /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        void categorize(category);
        return;
      }

      const rows = items ?? [];
      if (!rows.length) return;
      const index = rows.findIndex((row) => row.finding.id === selectedId);

      const step =
        event.key === "j" || event.key === "ArrowDown"
          ? 1
          : event.key === "k" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (step) {
        event.preventDefault();
        // From no selection either direction lands on the first row.
        const next = rows[Math.min(Math.max(index + step, 0), rows.length - 1)];
        if (next) select(next.finding.id);
        return;
      }

      const current = rows[index];
      if (!current) return;
      if (event.key === "o") {
        window.open(current.finding.url, "_blank", "noopener");
        return;
      }
      const next = TRIAGE_KEYS[event.key as keyof typeof TRIAGE_KEYS];
      if (next && next !== current.status) void triage(current.finding.id, next);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, selectedId, select, triage, undoLast, categorize, reveal]);

  // Every profile, and every project in the list: a retired one has rows but no
  // profile, and either may have no run to show. Unknown until the profiles are,
  // filtered or not, so the profile error's "not shown" holds.
  const requiredScanProjects =
    projects &&
    (project
      ? [project]
      : [
          ...new Set([
            ...projects.map((p) => p.key),
            ...(items ?? []).map((row) => row.finding.project),
          ]),
        ]);

  return (
    <div className="layout">
      <div className="list">
        <div className="toolbar">
          <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {projects?.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
            {/* The control must always name the filter in force: a project retired
                while selected still has findings to read, and a failed refresh
                empties the list without changing what the findings are filtered by.
                "No profile" only when the list loaded and lacks it, and not from the
                last good profiles while the current ones fail to load. */}
            {project && !projects?.some((p) => p.key === project) && (
              <option value={project}>
                {project}
                {projects && !profileError ? " (no profile)" : ""}
              </option>
            )}
          </select>
          <select
            aria-label="Triage status"
            value={status}
            onChange={(e) => setStatus(e.target.value as TriageStatus)}
          >
            {TRIAGE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <label
            className="muted"
            title="Zero-scored findings, including everything the model disqualified"
          >
            <input
              type="checkbox"
              aria-label="Show zero-scored findings"
              checked={withZeros}
              onChange={(e) => setWithZeros(e.target.checked)}
            />
            zeros
          </label>
          <label
            className="muted"
            title="Hide the model's score, type and reason on new findings until you triage them or press r"
          >
            <input
              type="checkbox"
              aria-label="Hide the model's score and reason on new findings"
              checked={hideJudgment}
              onChange={(e) => setHideJudgment(e.target.checked)}
            />
            hide reasons
          </label>
          <span
            className="muted count"
            title={
              items?.length === LIMIT ? `The list stops at ${LIMIT}; there may be more.` : undefined
            }
          >
            {items ? `${items.length}${items.length === LIMIT ? " (cap)" : ""}` : "…"}
          </span>
          <ThemeToggle />
          <button
            type="button"
            className="icon"
            aria-label="Keyboard shortcuts"
            aria-keyshortcuts="?"
            title="Keyboard shortcuts (?)"
            onClick={() => setShortcutsOpen(true)}
          >
            ?
          </button>
        </div>

        <ScanStatus
          runs={scans}
          error={scanError}
          requiredProjects={requiredScanProjects}
          showProject={!project}
        />

        {projectsError && (
          <p className="error pad">
            Could not read the profiles, so scan status is not shown — {projectsError}
          </p>
        )}
        {profileError && (
          <p className="warn pad">
            The profiles on disk do not load, so the inbox is using the last ones that did and
            drafting is off until they do: {profileError}
          </p>
        )}
        {error && <p className="error pad">{error}</p>}

        {items?.map(
          ({ finding, assessment, note, drafts, score, status: rowStatus, latestScan }) => {
            const hidden = hideJudgment && rowStatus === "new" && !revealed.has(finding.id);
            return (
              <button
                type="button"
                id={`finding-${finding.id}`}
                key={finding.id}
                className="item"
                aria-current={finding.id === selectedId}
                onClick={() => select(finding.id)}
              >
                {hidden ? (
                  <span className="score" title="Hidden until triaged or revealed (r)">
                    ·
                  </span>
                ) : (
                  <span className={`score ${scoreClass(score)}`}>{assessment ? score : "–"}</span>
                )}
                <span>
                  <span className="title">
                    {finding.title}
                    {latestScan && (
                      <span
                        className="mark"
                        title={
                          latestScan === "new"
                            ? "First found by this project's latest scan"
                            : "Assessed again by this project's latest scan"
                        }
                      >
                        {latestScan}
                      </span>
                    )}
                  </span>
                  <span className="meta">
                    {/* Only when unfiltered: which project a finding belongs to
                    decides the voice a draft is written in. */}
                    {!project && <b>{finding.project} · </b>}
                    {finding.venue} ·{" "}
                    <span title="The thread's age">{compactAge(finding.publishedAt)}</span>
                    {!hidden && ` · ${assessment?.opportunity ?? "unassessed"}`}
                    {/* Never "ready to post": a draft is unread text until the
                    operator has read it. */}
                    {drafts > 0 && ` · ${drafts} draft${drafts === 1 ? "" : "s"}`}
                  </span>
                  {/* Keep the operator's optional note distinct from the model's verdict. */}
                  {note && <span className="rownote">{note}</span>}
                </span>
              </button>
            );
          },
        )}

        {!error && !items && <p className="muted pad">Loading…</p>}
        {items?.length === 0 && (
          <p className="muted pad">
            No {status} findings{project ? " for this project" : ""}
            {withZeros ? "" : " scoring above zero"}.
          </p>
        )}
      </div>

      <div className="detail-column">
        <div className="detail" ref={pane}>
          {selectedId === null ? (
            <p className="muted">Select a finding.</p>
          ) : (
            // Keyed so switching findings remounts: without it the previous
            // finding stays rendered while the next loads, and the buttons
            // already act on the next one.
            <Detail
              key={selectedId}
              id={selectedId}
              revision={revision}
              judgmentHidden={hideJudgment && !revealed.has(selectedId)}
              onReveal={() => reveal(selectedId)}
              onTriage={triage}
              onChanged={changed}
              pendingNotes={pendingNotes}
            />
          )}
        </div>
        {undo && (
          <UndoToast
            undo={undo}
            onUndo={() => void undoLast()}
            onCategorize={(category) => void categorize(category, undo.seq)}
            onPosted={(where) => void recordPosted(where)}
            onClose={() => closeUndo(undo.seq)}
          />
        )}
      </div>
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

// Before the first render, so a pinned theme does not paint over the OS one.
applyTheme(storedTheme());

/**
 * Kept across hot updates. Bun re-runs this module on every edit, and a second
 * `createRoot` on the same container warns and abandons the tree the first root
 * is still driving. Writing to `import.meta.hot.data` also makes the module
 * self-accepting, so an edit replaces the component tree instead of reloading
 * the page — which is what keeps the open finding and an unsaved note alive
 * while the file is being worked on. In a production build `data` inlines to
 * `{}` and this collapses to a plain `createRoot`.
 */
const root: Root = (import.meta.hot.data.root ??= createRoot(document.getElementById("root")!));

root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
