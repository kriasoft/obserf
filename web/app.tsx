import { StrictMode, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Assessment, Draft, Finding, Run } from "../db/schema";
import {
  DISMISSAL_CATEGORIES,
  DRAFT_KINDS,
  FIRST_FIX,
  EVERGREEN,
  TRIAGE_STATUSES,
  compactAge,
  defaultKindFor,
  draftContextNote,
  type DismissalCategory,
  type DraftKind,
  type LatestScanMark,
  type OpportunityType,
  type TriageStatus,
} from "../vocabulary";
import "./app.css";

interface FindingView {
  finding: Finding;
  assessment: Assessment | null;
  status: TriageStatus;
  note: string | null;
  dismissalCategory: DismissalCategory | null;
}
/** `score` is computed by the server at request time, never stored. */
type ListedFinding = FindingView & {
  drafts: number;
  score: number;
  latestScan: LatestScanMark | null;
};
type FindingDetail = FindingView & {
  score: number;
  /** Older verdicts, newest first, of snapshots that were not kept. */
  earlier: Assessment[];
  drafts: Draft[];
  /** Profile present in the workspace now; required for new drafts and venue guidance. */
  profileAvailable: boolean;
  /** Rule from that profile, shown with stored drafts too; not draft provenance. */
  venueRule: string | null;
  /** Why the profiles on disk do not load; drafting is off until they do. */
  profileError: string | null;
};

/**
 * Bound the list request and rendering cost. The toolbar marks a result at the
 * cap; it may be incomplete, including when zero scores are shown.
 */
const LIMIT = 200;

/**
 * Triage from the keyboard. `x` for skipped: `s` is taken, and a skip crosses a
 * good finding off without calling it a mistake, which is what `d` says.
 */
const TRIAGE_KEYS = {
  n: "new",
  s: "shortlisted",
  x: "skipped",
  d: "dismissed",
  a: "acted",
} as const satisfies Record<string, TriageStatus>;

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

const KEY_FOR: Partial<Record<TriageStatus, string>> = Object.fromEntries(
  Object.entries(TRIAGE_KEYS).map(([key, status]) => [status, key]),
);

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
 * The question each component answers, verbatim from docs/product/scoring.md.
 * Without them the tiles are four bare numbers, and the operator disagreeing
 * with a score cannot tell which judgment they are disagreeing with.
 */
const COMPONENTS: ReadonlyArray<[key: "relevance" | "intent" | "welcome" | "reach", ask: string]> =
  [
    ["relevance", "Is this actually about the problem the project solves?"],
    ["intent", "Is someone looking for a solution now?"],
    ["welcome", "Would a mention be welcome here, under this venue's norms?"],
    ["reach", "Will anyone actually read it?"],
  ];

const DAY_MS = 86_400_000;

/** localStorage key for the reason-hidden review toggle. */
const HIDE_JUDGMENT_KEY = "obserf.hideJudgment";

/**
 * The colour theme. "system" is stored as absence, so the page follows the OS
 * until the operator pins a scheme; `app.css` resolves every colour through
 * `light-dark()`, so pinning is only a `color-scheme` override on the root.
 */
const THEME_KEY = "obserf.theme";
type Theme = "system" | "light" | "dark";
const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

function storedTheme(): Theme {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    return theme === "light" || theme === "dark" ? theme : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/**
 * Whether a keystroke is the inbox's to take: no modifier beyond Shift, and not
 * typed into a field. Text boxes and a select's type-ahead own their letters;
 * buttons, links and checkboxes use no letter, digit or arrow, so keys pass
 * through them — a mouse click on one must not strand the keyboard mid-queue.
 */
function isShortcut(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  // A modal dialog owns the keyboard. An open menu does too, even though it is
  // not modal: a key meant for it must not triage or move the selection.
  if (document.querySelector("dialog:modal, :popover-open")) return false;
  const target = event.target as HTMLElement | null;
  return !target?.closest('textarea, select, input:not([type="checkbox"]), [contenteditable]');
}

interface UndoRecord {
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

interface TriageOptions {
  /** Omitted leaves the stored note alone; see `setTriage`. */
  note?: string;
  /** Added to the end of the stored note by the server, which reads it in the same statement. */
  appendNote?: string;
  /** Omitted leaves a dismissal's category alone; `null` clears it. */
  category?: DismissalCategory | null;
  /**
   * False for anything that is not a new decision: an undo, or an amendment to
   * the current one (its category, where it was posted). Only decisions install
   * an undo record, and only a failed decision blocks category digits.
   */
  undoable?: boolean;
  /**
   * Checked when the write reaches the front of the queue; false drops it. For a
   * write whose premise a queued one ahead of it can remove.
   */
  stillWanted?: () => boolean;
  /** An amendment: refused unless the stored status is still `next`; see `setTriage`. */
  amend?: boolean;
}

function scoreClass(score: number): string {
  return score >= 70 ? "high" : score >= 40 ? "mid" : "low";
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Every request the inbox makes. A failed fetch, a non-2xx, and a body that is
 * not JSON all have to arrive as one thrown error: the previous version stored
 * an error body as though it were a finding, then crashed rendering it.
 */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const where = `${init?.method ?? "GET"} ${path}`;
  const response = await fetch(path, init);
  const text = await response.text();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Including on a 2xx. Handing an unparsed body back as `T` is how an error
    // page ends up rendered as a finding.
    throw new Error(`${where} returned ${response.status} and a body that is not JSON`);
  }

  if (!response.ok) {
    throw new Error(
      (body as { error?: string } | null)?.error ?? `${where} failed (${response.status})`,
    );
  }
  return body as T;
}

const postJson = <T,>(path: string, payload: unknown): Promise<T> =>
  requestJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

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
            onClose={() => recordUndo(null)}
          />
        )}
      </div>
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

function Detail({
  id,
  revision,
  judgmentHidden,
  onReveal,
  onTriage,
  onChanged,
  pendingNotes,
}: {
  id: number;
  revision: number;
  /** The toggle is on and this finding was not revealed; applies only while `new`. */
  judgmentHidden: boolean;
  onReveal: () => void;
  onTriage: (id: number, status: TriageStatus, options?: TriageOptions) => Promise<boolean>;
  onChanged: () => void;
  pendingNotes: Map<number, string>;
}) {
  const [detail, setDetail] = useState<FindingDetail | null>(null);
  /**
   * The operator's unsaved edit; `null` means they have not touched the note.
   * Seeded from `pendingNotes` so an edit survives being unmounted and come back to.
   */
  const [note, setNote] = useState<string | null>(() => pendingNotes.get(id) ?? null);
  const [drafting, setDrafting] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  /**
   * `W` writes the suggested draft and `c` copies the newest one — the last step
   * of a review, kept on the keyboard with the rest. `W` is Shift+W because a
   * draft spends model quota and `w` sits beside the triage keys. Read through a
   * ref, set each render, so the one listener acts on the drafts shown now.
   */
  const keys = useRef<{ write?: () => void; copyLatest?: () => void }>({});
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isShortcut(event)) return;
      const action =
        event.key === "W"
          ? keys.current.write
          : event.key === "c"
            ? keys.current.copyLatest
            : undefined;
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [error, setError] = useState<string | null>(null);
  /**
   * Discards a detail response that a newer read — or a write this pane already
   * applied — has overtaken. Without it a slow GET issued before a note was saved
   * can land afterwards and put the old note back, which reads as the save having
   * been silently undone.
   */
  const detailTicket = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++detailTicket.current;
    try {
      const next = await requestJson<FindingDetail>(`/api/findings/${id}`);
      if (ticket !== detailTicket.current) return;
      setDetail(next);
      setError(null);
    } catch (cause) {
      if (ticket === detailTicket.current) setError(messageOf(cause));
    }
  }, [id]);

  // `revision` covers a triage made from the keyboard while this was open, and
  // a scan that landed while the window was in the background.
  useEffect(() => {
    void load();
  }, [load, revision]);

  if (!detail) return <p className={error ? "error" : "muted"}>{error ?? "Loading…"}</p>;
  const {
    finding,
    assessment,
    score,
    drafts,
    earlier,
    status,
    dismissalCategory,
    venueRule,
    profileAvailable,
    profileError,
  } = detail;
  // A profile that failed to reload is still the last good one for reminders,
  // but not for writing: the draft would come from the text the operator replaced.
  const canDraft = profileAvailable && !profileError;
  const hidden = judgmentHidden && status === "new";
  // Null when the model named no opportunity — there is nothing to suggest,
  // and the buttons below offer every kind instead of promoting one. Null while
  // hidden too: the suggested kind follows from the opportunity type.
  const suggestedKind =
    assessment?.opportunity && !hidden
      ? defaultKindFor(assessment.opportunity, finding.isThreadComment)
      : null;

  const latest = drafts[0];
  keys.current = {
    // Cleared on use, so a second press before the next render cannot start a
    // second draft; the render that follows sets it again once writing is done.
    write:
      canDraft && suggestedKind && !drafting
        ? () => {
            keys.current.write = undefined;
            void draft(suggestedKind);
          }
        : undefined,
    copyLatest: latest ? () => void copy(latest.id, latest.body) : undefined,
  };

  const stored = detail.note ?? "";
  const noteValue = note ?? stored;
  // Compared and sent the way the server stores it — it trims, and turns
  // whitespace alone into no note.
  const noteToSave = noteValue.trim();
  const noteDirty = note !== null && noteToSave !== stored;

  /**
   * Saved on blur rather than behind a button: navigating away with a half-typed
   * note is the ordinary case, and silently discarding it is the one outcome the
   * note must never have. Triage owns the note, as it does in `obserf triage
   * --note`, so this needs no endpoint of its own.
   */
  async function saveNote() {
    // Every blur with an unsettled edit, not only one that differs from the note
    // last loaded: while a write is in flight that loaded value is already out of
    // date, so typing B, blurring, and typing A back would leave B in the
    // database. Guarded on `note` rather than `noteDirty`, and not on `saving` at
    // all — the mutation chain serializes the writes, so the newest lands last.
    if (note === null) return;
    const submitted = noteValue;
    const written = noteToSave;
    const ok = await onTriage(id, status, { note: written, undoable: false });
    if (!ok) return; // The edit stays in the box, and in `pendingNotes`, to retry.
    // The write succeeded, so this is the stored note now. Adopting it here
    // rather than waiting for the reload keeps the box from flashing the old
    // text back — and, if that reload fails, from measuring later edits against
    // a value the database no longer holds.
    detailTicket.current++; // Any read still in flight predates this write.
    setDetail((current) => (current ? { ...current, note: written || null } : current));
    // Both guarded on what was actually sent: this save may outlive its own
    // component, and by the time it lands the operator can be back on the same
    // finding with newer text. Dropping that is the loss `pendingNotes` exists to
    // prevent.
    if (pendingNotes.get(id) === submitted) pendingNotes.delete(id);
    setNote((current) => (current === submitted ? null : current));
  }

  async function draft(kind: DraftKind) {
    setDrafting(true);
    setError(null);
    try {
      // Always explicit. The server would otherwise re-derive the kind from the
      // assessment as it stands now, which a scan can have changed since this
      // pane loaded — and the button would have promised the wrong thing.
      await postJson<Draft>(`/api/findings/${id}/draft`, { kind });
      // Through the parent rather than `load()`: the list row shows a draft
      // count, and it would otherwise stay wrong until something else reloaded —
      // including when the model finishes after the operator has moved on.
      onChanged();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      // In a finally because a rejected fetch used to leave the button reading
      // "Writing…" for the rest of the session.
      setDrafting(false);
    }
  }

  async function copy(draftId: number, body: string) {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(draftId);
    } catch {
      setError("The browser refused clipboard access — select the text and copy it.");
    }
  }

  return (
    <>
      <div className="detail-body">
        <h1>{finding.title}</h1>
        <p className="muted">
          <a href={finding.url} target="_blank" rel="noreferrer">
            {finding.url}
          </a>
          <br />
          {finding.project} · {finding.venue} · {finding.sourceId} ·{" "}
          {finding.publishedAt ? new Date(finding.publishedAt).toDateString() : "date unknown"} ·{" "}
          {status}
          {dismissalCategory && ` (${dismissalCategory})`}
          {/* What the model is told beyond the text; bears on `reach` and `welcome`. */}
          {(finding.isThreadComment || finding.author) && (
            <>
              <br />
              {[
                finding.isThreadComment ? "one comment inside a thread, not the thread itself" : "",
                finding.author ? `author: ${finding.author}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </>
          )}
        </p>

        {finding.repository && <Repository facts={finding.repository} />}
        {finding.metrics && <Engagement metrics={finding.metrics} />}

        {assessment && hidden ? (
          <>
            {/* The age is evidence, not judgment, so it stays. */}
            <div className="components">
              <Age publishedAt={finding.publishedAt} opportunity={null} />
            </div>
            <p className="muted">
              The model's judgment is hidden until you triage this.{" "}
              <button onClick={onReveal}>
                reveal <kbd>r</kbd>
              </button>
            </p>
          </>
        ) : assessment ? (
          <>
            <div className="components">
              {/* Scales spelled out: a 12 beside a 5 is unreadable otherwise. */}
              <div title="The four components, weighted and then decayed by the thread's age — or zero outright if the finding is disqualified, irrelevant, or unwelcome.">
                <b className={`score ${scoreClass(score)}`}>
                  {score}
                  <span className="of">/100</span>
                </b>
                score
              </div>
              {COMPONENTS.map(([key, ask]) => (
                <div key={key} title={ask}>
                  <b>
                    {assessment[key]}
                    <span className="of">/5</span>
                  </b>
                  {key}
                </div>
              ))}
              <Age publishedAt={finding.publishedAt} opportunity={assessment.opportunity} />
            </div>
            <p>
              {assessment.disqualified && <span className="flag">disqualified</span>}
              <strong>{assessment.opportunity ?? "no shape"}</strong> — {assessment.reason}
            </p>
            {/* When the judgment was made. The publication date above is the
              thread's age, which is a different question. */}
            <p className="muted small">
              judged {new Date(assessment.createdAt).toLocaleString()} by {assessment.model} ·
              rubric/brief {assessment.promptFingerprint}
            </p>
            <EarlierVerdicts earlier={earlier} current={assessment.promptFingerprint} />
          </>
        ) : (
          // Not muted: a missing verdict is not secondary metadata.
          <p className="warn">No assessment recorded.</p>
        )}

        {status === "dismissed" && (
          <p className="small">
            <label>
              Why dismissed{" "}
              <select
                value={dismissalCategory ?? ""}
                onChange={(event) =>
                  void onTriage(id, "dismissed", {
                    category: (event.target.value || null) as DismissalCategory | null,
                    amend: true,
                    // An amendment, like a digit after `d`: its failure is not a
                    // failed decision, and must not block the digits.
                    undoable: false,
                  })
                }
              >
                <option value="">not recorded</option>
                {DISMISSAL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>{" "}
            {dismissalCategory && FIRST_FIX[dismissalCategory] && (
              <span className="muted">First fix: {FIRST_FIX[dismissalCategory]}</span>
            )}
          </p>
        )}
        {profileError && (
          <p className="warn small">
            The profiles on disk do not load, so drafting is off until they do: {profileError}
          </p>
        )}
        {!profileAvailable && !profileError && (
          <p className="warn small">
            No profile for "{finding.project}" any more. Restore it to write a draft; what is
            already here stays readable.
          </p>
        )}

        {error && <p className="error">{error}</p>}

        {finding.excerpt && <div className="excerpt">{finding.excerpt}</div>}

        <label className="note">
          <span className="muted small">Note {noteDirty && "· unsaved"}</span>
          <textarea
            rows={2}
            value={noteValue}
            placeholder="Why this is or is not worth acting on"
            onChange={(e) => {
              setNote(e.target.value);
              pendingNotes.set(id, e.target.value);
            }}
            onBlur={() => void saveNote()}
          />
        </label>

        {/* Keep the venue reminder beside stored drafts as well as new ones.
          The three states are explained in docs/product/opportunities.md. */}
        {drafts.length > 0 && (
          <p className={venueRule ? "muted small" : "warn small"}>
            {!profileAvailable
              ? `Whatever the profile for "${finding.project}" recorded about ${finding.venue} is unreadable with it gone — read the venue's rules and what a submission actually requires before posting.`
              : venueRule
                ? `Your verified note for ${finding.venue}: ${venueRule} — confirm it still holds and that taking part costs nothing before posting.`
                : `No verified guidance recorded for ${finding.venue}. Obserf cannot check whether a mention is permitted there or what taking part costs — read the venue's rules and what a submission actually requires before posting. A rule you verify yourself goes in the profile's venueGuidance, with its source and the date you checked.`}
          </p>
        )}

        {drafts.map((d) => (
          <div key={d.id} className="draft">
            <div className="draft-head">
              <span className="muted small">
                {d.kind} · {new Date(d.createdAt).toLocaleString()} — review, edit, and post it
                yourself
              </span>
              <button onClick={() => void copy(d.id, d.body)}>
                {copied === d.id ? "Copied" : "Copy"} {d.id === latest?.id && <kbd>c</kbd>}
              </button>
            </div>
            <DraftContext draft={d} />
            {d.body}
          </div>
        ))}
      </div>
      <ActionBar
        status={status}
        onDecide={(s) => void onTriage(id, s, { note: noteDirty ? noteToSave : undefined })}
        url={finding.url}
        sourceId={finding.sourceId}
        // Withheld rather than disabled: without a profile the drafter has no
        // pitch, voice or venue rule to write from, so the request can only come
        // back a 409. Triage and the stored drafts above still work.
        draftKinds={canDraft ? DRAFT_KINDS : []}
        suggestedKind={suggestedKind}
        drafting={drafting}
        onDraft={(kind) => void draft(kind)}
      />
    </>
  );
}

/**
 * Pinned to the bottom of the detail pane, so a decision never needs a scroll
 * back up past a long excerpt or a draft. Every button shows its key.
 */
function ActionBar({
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
  // The suggestion is the main button; the menu offers the rest, or every kind
  // when there is nothing to suggest.
  const primary = suggestedKind && draftKinds.includes(suggestedKind) ? suggestedKind : null;
  const others = draftKinds.filter((k) => k !== primary);
  return (
    <div className="action-bar">
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
            Open page ↗ <kbd>o</kbd>
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
                title="Writes text for you to review. Obserf never posts."
                aria-keyshortcuts="Shift+W"
                disabled={drafting}
                onClick={() => onDraft(primary)}
              >
                <span>
                  {drafting ? "Writing…" : `Draft ${primary}`} <kbd>⇧W</kbd>
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

/**
 * The decision just made, floating above the action bar: what it was, how to
 * take it back, and the one follow-up it invites. Belongs to the undo record,
 * not the selection, which the decision has already moved on — so it stays up
 * while the operator reads the next finding, and nothing waits for it.
 */
function UndoToast({
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

/**
 * The latest scan of each project in view, and whether it saw everything it was
 * asked to: one that skipped sources, died halfway or failed otherwise yields an
 * inbox indistinguishable from a complete one with less in it.
 */
function ScanStatus({
  runs,
  error,
  requiredProjects,
  showProject,
}: {
  runs: Run[] | null;
  error: string | null;
  /** Projects whose missing run is said rather than left out; null while unknown. */
  requiredProjects: string[] | null;
  /** Name each scan's project, when the list is not filtered to one. */
  showProject: boolean;
}) {
  // Said rather than swallowed: the completeness warnings below are the reason
  // this exists, so their absence must not be readable as "all clear".
  if (error) {
    return <div className="scan warn small">Could not read the scan record — {error}</div>;
  }
  if (!runs || !requiredProjects) return null;
  // Only projects in view: a retired one outside the list is no more reported
  // for having a run than for lacking one.
  const shown = runs.filter((run) => requiredProjects.includes(run.project));
  const unscanned = requiredProjects.filter((key) => !shown.some((run) => run.project === key));
  if (!shown.length && !unscanned.length) return null;

  return (
    <div className="scan small">
      {unscanned.map((key) => (
        <span className="warn" key={key}>
          {showProject && `${key} · `}no scan recorded
        </span>
      ))}
      {shown.map((run) => {
        // Still running, or the process died. Totals are written when a scan
        // finishes, so an open row's are the insert's zeros, not a count.
        const open = run.finishedAt === null;
        // Finalized by a discovery failure: the candidates are real, but an arrow
        // to "0 assessed" would say they went through a gate that never ran.
        const counts = open
          ? ""
          : run.gated === null
            ? ` · ${run.candidates} candidates · the gate did not run`
            : ` · ${run.candidates} candidates → ${run.assessed} assessed`;
        // Named on every run, as `obserf runs` does: a `--source` scan that
        // succeeded is otherwise indistinguishable from one of every source.
        const { skipped } = run;
        const ran = skipped && run.sources.filter((id) => !(id in skipped));
        return (
          <div className="scan-run" key={run.id}>
            <span className="muted">
              {showProject && `${run.project} · `}
              {open ? "scan started" : "last scan"} {ago(new Date(run.startedAt))}
              {ran && (ran.length ? ` · ran ${ran.join(", ")}` : " · nothing ran")}
              {counts}
            </span>
            {/* `!== null`: `new Error("")` is stored as an empty message. */}
            {run.error !== null && (
              <span className="error">scan failed{run.error && `: ${run.error}`}</span>
            )}
            {open && (
              <span className="warn">
                this scan is unfinished — still running, or stopped — so the list may be short
              </span>
            )}
            {Object.entries(run.skipped ?? {}).map(([source, reason]) => (
              <span className="warn" key={source}>
                {source} did not run: {reason}
              </span>
            ))}
            {/* Null is not `{}`: a row written before discovery finished never
                recorded which sources ran. */}
            {run.skipped === null && (
              <span className="muted">
                selected {run.sources.join(", ")}; which of them ran was not recorded
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Coarse on purpose: the question is "is this list stale", not how stale.
 * Floored, so a scan is never made to sound older than it is.
 */
function ago(date: Date): string {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * How old the thread is — the term in the score that has no tile of its own.
 * A row reading "12 score, 5 relevance, 4 intent" looks like broken arithmetic
 * until you know the thread is two hundred days old, and the decision it drives
 * is a different one: not a weak match, a dead room.
 */
function Age({
  publishedAt,
  opportunity,
}: {
  publishedAt: Finding["publishedAt"];
  opportunity: OpportunityType | null;
}) {
  if (!publishedAt) {
    return (
      <div title="No publication date, so no decay was applied.">
        <b>?</b>age unknown
      </div>
    );
  }
  const days = Math.max(0, Math.floor((Date.now() - new Date(publishedAt).getTime()) / DAY_MS));
  const evergreen = opportunity !== null && EVERGREEN.has(opportunity);
  return (
    <div
      title={
        evergreen
          ? "The thread's age now. Listings do not decay: an old curated list still merging pull requests is a live opportunity."
          : "The thread's age now. Scores decay with age — halved every 30 days, floored at 15%."
      }
    >
      <b>{days}d</b>
      {evergreen ? "old · evergreen" : "old"}
    </div>
  );
}

/**
 * Engagement on a discussion, as last observed. Shown for the same reason as the
 * repository facts: `reach` was judged on these numbers, and the operator
 * second-guessing that score should not have to open the thread to see them.
 */
function Engagement({ metrics }: { metrics: NonNullable<Finding["metrics"]> }) {
  const { points, comments } = metrics;
  if (points === undefined && comments === undefined) return null;
  return (
    <div className="components">
      {points !== undefined && (
        <div>
          <b>{points}</b>points
        </div>
      )}
      {comments !== undefined && (
        <div>
          <b>{comments}</b>comments
        </div>
      )}
    </div>
  );
}

/**
 * The repository evidence the model was given, in the same terms — `obserf show`
 * prints the same numbers. Read as a merge rate, never an acceptance rate: a
 * pull request closed unmerged was not necessarily refused, and the counts
 * include the maintainers' own work.
 */
function Repository({ facts }: { facts: NonNullable<Finding["repository"]> }) {
  const { stars, pullRequests } = facts;
  const resolved = pullRequests ? pullRequests.merged + pullRequests.closedUnmerged : 0;

  return (
    <div className="components">
      <div>
        <b>{stars}</b>stars
      </div>
      {pullRequests && (
        <>
          <div>
            <b>{pullRequests.open}</b>open PRs
          </div>
          {/* Both counts are windowed, and separate tiles do not share a
              qualifier the way the CLI's one line does. */}
          <div>
            <b>{pullRequests.merged}</b>merged / {pullRequests.windowDays}d
          </div>
          <div>
            <b>{pullRequests.closedUnmerged}</b>closed unmerged / {pullRequests.windowDays}d
          </div>
          {resolved > 0 && (
            <div>
              <b>{Math.round((pullRequests.merged / resolved) * 100)}%</b>
              merged of {resolved} resolved / {pullRequests.windowDays}d
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Kept across hot updates. Bun re-runs this module on every edit, and a second
 * `createRoot` on the same container warns and abandons the tree the first root
 * is still driving. Writing to `import.meta.hot.data` also makes the module
 * self-accepting, so an edit replaces the component tree instead of reloading
 * the page — which is what keeps the open finding and an unsaved note alive
 * while the file is being worked on. In a production build `data` inlines to
 * `{}` and this collapses to a plain `createRoot`.
 */
// Before the first render, so a pinned theme does not paint over the OS one.
applyTheme(storedTheme());
const root: Root = (import.meta.hot.data.root ??= createRoot(document.getElementById("root")!));

root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const THEME_ICONS: Record<Theme, ReactNode> = {
  system: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  dark: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
};

/** Cycles system → light → dark; the icon shows the theme in force, the label the next. */
function ThemeToggle() {
  const [theme, setTheme] = useState(storedTheme);
  useEffect(() => {
    applyTheme(theme);
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Unavailable storage only costs remembering the choice.
    }
  }, [theme]);
  const label = `Theme: ${theme}. Switch to ${NEXT_THEME[theme]}`;
  return (
    <button
      type="button"
      className="icon"
      aria-label={label}
      title={label}
      onClick={() => setTheme(NEXT_THEME[theme])}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {THEME_ICONS[theme]}
      </svg>
    </button>
  );
}

/**
 * The `?` overlay. A native modal dialog, so focus is trapped and returned and
 * Esc closes it without code here; `isShortcut` stands the page's keys down
 * while it is open. `?` closes it too, and so does a click on the backdrop,
 * which is the only place the dialog element itself receives one.
 */
function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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

/** What a draft was written against, shown with stored drafts too. */
function DraftContext({ draft }: { draft: Draft }) {
  const { text, complete } = draftContextNote(draft.contextSource, draft.contextWarning);
  return <p className={complete ? "muted small" : "warn small"}>{text}</p>;
}

/**
 * The verdicts before the current one, collapsed: most findings have none, and
 * where they do, the first question is whether the rubric or the project brief
 * changed between them — so the summary says that without opening the list. It
 * says no more: the fingerprint leaves out how the candidate was formatted, so
 * matching fingerprints do not mean the model saw the same prompt. No score, as in
 * `obserf show`: one computed now would apply today's weights and clock to a
 * snapshot that was not kept, and the evidence each saw is gone, so these show
 * that a verdict moved, not why.
 */
function EarlierVerdicts({ earlier, current }: { earlier: Assessment[]; current: string }) {
  if (!earlier.length) return null;
  const briefChanged = earlier.some((a) => a.promptFingerprint !== current);
  return (
    <details className="earlier small">
      <summary className="muted">
        {earlier.length} earlier assessment{earlier.length === 1 ? "" : "s"}
        {briefChanged ? ", rubric or brief changed since" : ", same rubric and brief"}
      </summary>
      {earlier.map((a) => (
        <div key={a.id}>
          <p>
            {a.disqualified && <span className="flag">disqualified</span>}
            {COMPONENTS.map(([key]) => `${key} ${a[key]}`).join(" · ")}
          </p>
          <p className="muted">
            <strong>{a.opportunity ?? "no shape"}</strong> — {a.reason}
          </p>
          <p className="muted">
            judged {new Date(a.createdAt).toLocaleString()} by {a.model} · rubric/brief{" "}
            {a.promptFingerprint}
          </p>
        </div>
      ))}
    </details>
  );
}
