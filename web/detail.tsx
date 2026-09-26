import { useCallback, useEffect, useRef, useState } from "react";
import type { Assessment, Draft, Finding } from "../db/schema";
import {
  DISMISSAL_CATEGORIES,
  DRAFT_KINDS,
  FIRST_FIX,
  EVERGREEN,
  defaultKindFor,
  draftContextNote,
  type DismissalCategory,
  type DraftKind,
  type OpportunityType,
  type TriageStatus,
} from "../vocabulary";
import { type FindingDetail, messageOf, requestJson, postJson } from "./api";
import { isShortcut } from "./keyboard";
import { ActionBar } from "./action-bar";

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

export interface TriageOptions {
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

export function scoreClass(score: number): string {
  return score >= 70 ? "high" : score >= 40 ? "mid" : "low";
}

export function Detail({
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
