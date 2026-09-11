import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Assessment, Draft, Finding } from "../db/schema";
import type { DraftResult } from "../pipeline/draft";
import {
  DRAFT_KINDS,
  EVERGREEN,
  TRIAGE_STATUSES,
  defaultKindFor,
  type DraftKind,
  type OpportunityType,
  type TriageStatus,
} from "../vocabulary";
import "./app.css";

interface FindingView {
  finding: Finding;
  assessment: Assessment | null;
  status: TriageStatus;
  note: string | null;
}
type ListedFinding = FindingView & { drafts: number };
type FindingDetail = FindingView & {
  drafts: Draft[];
  /** Profile present at server startup; required for new drafts and venue guidance. */
  profileAvailable: boolean;
  /** Rule from that profile, shown with stored drafts too; not draft provenance. */
  venueRule: string | null;
};

/**
 * Bound the list request and rendering cost. The toolbar marks a result at the
 * cap; it may be incomplete, including when zero scores are shown.
 */
const LIMIT = 200;

/** Triage from the keyboard. */
const TRIAGE_KEYS = {
  n: "new",
  s: "shortlisted",
  d: "dismissed",
  a: "acted",
} as const satisfies Record<string, TriageStatus>;

const KEY_FOR: Partial<Record<TriageStatus, string>> = Object.fromEntries(
  Object.entries(TRIAGE_KEYS).map(([key, status]) => [status, key]),
);

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

interface TriageOptions {
  /** Omitted leaves the stored note alone; see `setTriage`. */
  note?: string;
  /** False for an undo, which is a correction rather than a new decision. */
  undoable?: boolean;
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
  const [projects, setProjects] = useState<Array<{ key: string; name: string }>>([]);
  const [project, setProject] = useState("");
  const [status, setStatus] = useState<TriageStatus>("new");
  /**
   * A score control, not a "show rejected" one. `pipeline/score.ts` zeroes
   * anything disqualified, irrelevant, or unwelcome; the operator's own decision
   * is `status`, and never touches the score.
   */
  const [withZeros, setWithZeros] = useState(false);
  const [items, setItems] = useState<ListedFinding[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
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
  const [undo, setUndo] = useState<{
    id: number;
    title: string;
    from: TriageStatus;
    to: TriageStatus;
  } | null>(null);

  // Filter changes fire overlapping requests; without this the slower earlier
  // one can land last and repopulate the list with the previous filter.
  const listTicket = useRef(0);
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

  useEffect(() => {
    requestJson<Array<{ key: string; name: string }>>("/api/projects")
      .then(setProjects)
      .catch((cause: unknown) => setError(messageOf(cause)));
  }, []);

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
      const { note, undoable = true } = options;
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
        try {
          const { previous } = await postJson<{ previous: TriageStatus | null }>(
            `/api/findings/${id}/triage`,
            { status: next, note },
          );
          // The server's `previous`, not the rendered row's: a queued write may
          // already have moved it. A note saved on blur posts the status the
          // finding already had, so neither of these applies to it — offering to
          // undo it would be a lie, and advancing the selection would make saving
          // text quietly move the operator somewhere else.
          if (previous !== null && previous !== next) {
            prefer.current = neighbours;
            if (undoable) setUndo({ id, title: title ?? `#${id}`, from: previous, to: next });
          }
          changed();
          return true;
        } catch (cause) {
          setError(messageOf(cause));
          return false;
        }
      });
      // `run` settles rather than rejects, so the queue cannot be poisoned by one
      // failed write.
      chain.current = run;
      return run;
    },
    [items, changed],
  );

  /**
   * Restores the status only. The note is deliberately left as it stands: undoing
   * a mis-keystroke should not also discard reasoning typed on purpose. Selection
   * does not move either — the operator is still working where they were, and the
   * bar names which finding came back. The record survives a failed undo so it
   * can be retried.
   */
  const undoLast = useCallback(async () => {
    if (!undo) return;
    if (await triage(undo.id, undo.from, { undoable: false })) {
      // Only this record: a change queued behind the undo installs its own while
      // this one is in flight, and that one has not been taken back.
      setUndo((current) => (current === undo ? null : current));
    }
  }, [undo, triage]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Never take a keystroke away from a focused control. List rows are buttons
      // as well, and moving through them from the keyboard is the whole point, so
      // they are the exception.
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, a, button:not(.item)")) return;

      // Undo must also work after the last row leaves the filtered list.
      if (event.key === "u") {
        event.preventDefault();
        void undoLast();
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
  }, [items, selectedId, select, triage, undoLast]);

  return (
    <div className="layout">
      <div className="list">
        <div className="toolbar">
          <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
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
              checked={withZeros}
              onChange={(e) => setWithZeros(e.target.checked)}
            />
            zeros
          </label>
          <span
            className="muted count"
            title={
              items?.length === LIMIT ? `The list stops at ${LIMIT}; there may be more.` : undefined
            }
          >
            {items ? `${items.length}${items.length === LIMIT ? " (cap)" : ""}` : "…"}
          </span>
        </div>

        {undo && (
          <div className="undo">
            <span className="muted small">
              {undo.to} · {undo.title}
            </span>
            <button onClick={() => void undoLast()}>
              undo <kbd>u</kbd>
            </button>
          </div>
        )}

        {error && <p className="error pad">{error}</p>}

        {items?.map(({ finding, assessment, note, drafts }) => (
          <button
            type="button"
            id={`finding-${finding.id}`}
            key={finding.id}
            className="item"
            aria-current={finding.id === selectedId}
            onClick={() => select(finding.id)}
          >
            <span className={`score ${scoreClass(assessment?.score ?? 0)}`}>
              {assessment?.score ?? "–"}
            </span>
            <span>
              <span className="title">{finding.title}</span>
              <span className="meta">
                {/* Only when unfiltered: which project a finding belongs to
                    decides the voice a draft is written in. */}
                {!project && <b>{finding.project} · </b>}
                {finding.venue} · {assessment?.opportunity ?? "unassessed"}
                {/* Never "ready to post": a draft is unread text until the
                    operator has read it. */}
                {drafts > 0 && ` · ${drafts} draft${drafts === 1 ? "" : "s"}`}
              </span>
              {/* Keep the operator's optional note distinct from the model's verdict. */}
              {note && <span className="rownote">{note}</span>}
            </span>
          </button>
        ))}

        {!error && !items && <p className="muted pad">Loading…</p>}
        {items?.length === 0 && (
          <p className="muted pad">
            No {status} findings{project ? " for this project" : ""}
            {withZeros ? "" : " scoring above zero"}.
            {/* Only `new` arrives from a scan; the rest are decisions. */}
            {status === "new" && (
              <>
                {" "}
                Run <code>obserf scan</code>.
              </>
            )}
          </p>
        )}
      </div>

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
            onTriage={triage}
            onChanged={changed}
            pendingNotes={pendingNotes}
          />
        )}
      </div>
    </div>
  );
}

function Detail({
  id,
  revision,
  onTriage,
  onChanged,
  pendingNotes,
}: {
  id: number;
  revision: number;
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
  /**
   * Context used for the latest draft generated in this mounted detail pane.
   * Matched by draft id; lost on switching findings or reloading the page.
   */
  const [provenance, setProvenance] = useState<DraftResult | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
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
  const { finding, assessment, drafts, status, venueRule, profileAvailable } = detail;
  // Null when the model named no opportunity — there is nothing to suggest,
  // and the buttons below offer every kind instead of promoting one.
  const suggestedKind = assessment?.opportunity
    ? defaultKindFor(assessment.opportunity, finding.isThreadComment)
    : null;

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
    const ok = await onTriage(id, status, { note: written });
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
      const result = await postJson<DraftResult>(`/api/findings/${id}/draft`, { kind });
      setProvenance(result);
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
      <h1>{finding.title}</h1>
      <p className="muted">
        <a href={finding.url} target="_blank" rel="noreferrer">
          {finding.url}
        </a>
        <br />
        {finding.project} · {finding.venue} · {finding.sourceId} ·{" "}
        {finding.publishedAt ? new Date(finding.publishedAt).toDateString() : "date unknown"} ·{" "}
        {status}
      </p>

      {finding.repository && <Repository facts={finding.repository} />}
      {finding.metrics && <Engagement metrics={finding.metrics} />}

      {assessment && (
        <>
          <div className="components">
            {/* Scales spelled out: a 12 beside a 5 is unreadable otherwise. */}
            <div title="The four components, weighted and then decayed by the thread's age — or zero outright if the finding is disqualified, irrelevant, or unwelcome.">
              <b className={`score ${scoreClass(assessment.score)}`}>
                {assessment.score}
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
            judged {new Date(assessment.createdAt).toLocaleString()} by {assessment.model}
          </p>
        </>
      )}

      <div className="actions">
        {TRIAGE_STATUSES.filter((s) => s !== status).map((s) => (
          <button
            key={s}
            onClick={() => void onTriage(id, s, { note: noteDirty ? noteToSave : undefined })}
          >
            {s} {KEY_FOR[s] && <kbd>{KEY_FOR[s]}</kbd>}
          </button>
        ))}
        {/* Withheld rather than disabled: without a profile the drafter has no
            pitch, voice or venue rule to write from, so the request can only
            come back a 409. Triage and the stored drafts below still work. */}
        {profileAvailable && suggestedKind && (
          <button onClick={() => void draft(suggestedKind)} disabled={drafting}>
            {drafting ? "Writing…" : `Write a ${suggestedKind}`}
          </button>
        )}
        {profileAvailable &&
          DRAFT_KINDS.filter((k) => k !== suggestedKind).map((k) => (
            <button key={k} onClick={() => void draft(k)} disabled={drafting}>
              {suggestedKind ? `as ${k}` : `Write a ${k}`}
            </button>
          ))}
      </div>
      {!profileAvailable && (
        <p className="warn small">
          No profile for "{finding.project}" any more. Restore it to write a draft; what is already
          here stays readable.
        </p>
      )}
      <p className="muted small">
        <kbd>j</kbd> <kbd>k</kbd> move · <kbd>o</kbd> opens the page · <kbd>u</kbd> undoes the last
        status change · triage keys apply to the selected finding
      </p>

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
              : `No verified guidance recorded for ${finding.venue}. Obserf cannot check whether a mention is permitted there or what taking part costs — read the venue's rules and what a submission actually requires before posting.`}
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
              {copied === d.id ? "Copied" : "Copy"}
            </button>
          </div>
          {/* Another client may have generated a newer draft before this reload;
              retrieval context belongs to the returned id, not list position. */}
          {provenance?.id === d.id && (
            <p className={provenance.contextVia ? "muted small" : "warn small"}>
              {provenance.contextVia
                ? `written from the live thread (${provenance.contextVia})`
                : `written from the stored excerpt only${provenance.contextWarning ? ` — ${provenance.contextWarning}` : ""}`}
            </p>
          )}
          {d.body}
        </div>
      ))}
    </>
  );
}

/**
 * How old the thread is — the term in the score that has no tile of its own.
 * A row reading "12 score, 5 relevance, 4 intent" looks like broken arithmetic
 * until you know the thread is two hundred days old, and the decision it drives
 * is a different one: not a weak match, a dead room.
 *
 * The age, not the multiplier that was applied to it: the stored score was
 * decayed whenever it was last computed, and `obserf rescore` recomputes scores
 * against a fresh clock without touching the assessment's timestamp. Nothing the
 * browser can calculate reliably reproduces the number actually baked in, and a
 * multiplier that is quietly wrong is worse than none.
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
          : "The thread's age now. Scores decay with age — halved every 30 days, floored at 15% — but the stored score used the age this thread had when it was last scored, which may be younger than this."
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
const root: Root = (import.meta.hot.data.root ??= createRoot(document.getElementById("root")!));

root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
