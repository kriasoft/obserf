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
import type { ScoreExplanation } from "../pipeline/score";
import { type FindingDetail, type TriageOptions, messageOf, requestJson, postJson } from "./api";
import { isShortcut } from "./keyboard";
import { ActionBar } from "./action-bar";

/**
 * Characters past which a draft opens collapsed to its first dozen lines —
 * about twice what those lines hold, so collapsing always hides something worth
 * a click to open.
 */
const LONG_DRAFT = 1200;

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

/**
 * Why the score is zero when a hard rule made it so. Worded as what the model
 * judged, not as fact about the venue: welcome 0 is its reading of the page, not
 * a recorded rule.
 */
const ZEROED_BY: Record<NonNullable<ScoreExplanation["zeroedBy"]>, string> = {
  disqualified: "The model disqualified it; the verdict says why.",
  relevance: "Relevance is 0: not about the problem the project solves.",
  welcome: "Welcome is 0: the model judged a mention unwelcome here.",
};

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
  /** Long drafts opened past their first lines. */
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
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

  /**
   * Whether the header has scrolled out of the pane, which brings up a compact
   * title: a long finding otherwise leaves the operator mid-draft with no way to
   * see which finding the action bar below will act on.
   */
  const head = useRef<HTMLElement>(null);
  const [pastHead, setPastHead] = useState(false);
  const loaded = detail !== null;
  useEffect(() => {
    const el = head.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Above the pane, not merely out of it: the header can never be below.
        if (!entry) return;
        const top = entry.rootBounds?.top ?? 0;
        setPastHead(!entry.isIntersecting && entry.boundingClientRect.bottom <= top);
      },
      // Less the bar's own height: it takes over as the header slides under it.
      { root: el.closest(".detail"), rootMargin: "-36px 0px 0px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loaded]);

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
    breakdown,
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
      {/* Takes no room in the flow, so appearing never moves the content. A
          visual echo of the heading below, so assistive technology skips it. */}
      <div className="mini-head" data-shown={pastHead} aria-hidden="true" inert={!pastHead}>
        <span className="title">{finding.title}</span>
        <span className="pill" data-status={status}>
          {status}
        </span>
      </div>
      <div className="detail-body">
        <div className="main">
          <header className="finding-head" ref={head}>
            <p className="crumbs">
              <span>{finding.project}</span>
              <span aria-hidden="true">/</span>
              <code>{finding.sourceId}</code>
              <span className="pill" data-status={status}>
                {status}
              </span>
              {dismissalCategory && <code className="reason">reason: {dismissalCategory}</code>}
            </p>
            <h1>{finding.title}</h1>
            <p className="meta">
              <a href={finding.url} target="_blank" rel="noreferrer" title={finding.url}>
                {finding.venue} ↗
              </a>
              {/* What the model is told beyond the text; bears on `reach` and `welcome`. */}
              {finding.author && <span>by {finding.author}</span>}
              <span>
                {finding.publishedAt
                  ? new Date(finding.publishedAt).toDateString()
                  : "date unknown"}
              </span>
              {finding.isThreadComment && (
                <span>one comment inside a thread, not the thread itself</span>
              )}
            </p>
            {/* The operator's own reading, above the model's: what they decided
                last time is the first thing to see on coming back. The saved
                note only; an edit shows here once it is saved. Clamped, so a long
                one does not push the verdict away; the editor below holds it all. */}
            {stored && (
              <p className="you-note">
                <span className="chip you">YOU</span>
                <span title={stored}>{stored}</span>
              </p>
            )}
          </header>

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

          {/* The verdict first: it is the sentence the decision turns on. */}
          {assessment && hidden ? (
            <div className="judgment-hidden">
              <p>
                <b>Judgment hidden.</b> Score, components, type and verdict stay covered until you
                decide or reveal them.
              </p>
              <button onClick={onReveal} aria-keyshortcuts="R">
                Reveal <kbd>r</kbd>
              </button>
            </div>
          ) : assessment ? (
            <section className="verdict" aria-label="Model verdict">
              <p className="label">
                <span className="chip model">MODEL</span>
                verdict · {assessment.opportunity ?? "no shape"} · {assessment.model}
              </p>
              {breakdown?.zeroedBy && (
                <p className="forced">
                  <b>Score forced to 0.</b> {ZEROED_BY[breakdown.zeroedBy]}
                </p>
              )}
              <p className="verdict-text">{assessment.reason}</p>
            </section>
          ) : (
            // Not muted: a missing verdict is not secondary metadata.
            <p className="warn">No assessment recorded.</p>
          )}

          {finding.excerpt && (
            <section>
              <h2>From the page</h2>
              <div className="excerpt">{finding.excerpt}</div>
            </section>
          )}

          <section className="scoreline" aria-label="Score">
            {assessment && !hidden && (
              <>
                <p>
                  <span
                    className="chip"
                    title="Computed by code from the model's components and the thread's age — or zero outright if the finding is disqualified, irrelevant or unwelcome."
                  >
                    SCORE · CODE
                  </span>
                  <b className={breakdown?.zeroedBy ? "score zeroed" : "score"}>
                    {score}
                    <span className="of">/100</span>
                  </b>
                  <Age publishedAt={finding.publishedAt} opportunity={assessment.opportunity} />
                </p>
                <p
                  role="group"
                  aria-label={`Model components: ${COMPONENTS.map(([key]) => `${key} ${assessment[key]} of 5`).join(", ")}`}
                >
                  <span className="chip model" aria-hidden="true">
                    MODEL
                  </span>
                  {/* Scales spelled out: a 12 beside a 5 is unreadable otherwise. */}
                  {COMPONENTS.map(([key, ask]) => (
                    <span key={key} title={ask} aria-hidden="true">
                      {key} <b>{assessment[key]}</b>
                      <span className="of">/5</span>
                    </span>
                  ))}
                </p>
                {breakdown && <Working breakdown={breakdown} />}
              </>
            )}
            {/* The age is evidence, not judgment, so it stays while hidden. */}
            {(!assessment || hidden) && (
              <p>
                <Age publishedAt={finding.publishedAt} opportunity={null} />
              </p>
            )}
          </section>

          <section>
            <h2>Drafts {drafts.length > 0 && <span className="count">{drafts.length}</span>}</h2>
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
            {drafts.map((d) => {
              // Long enough to push the note and the next draft out of view.
              const long = d.body.length > LONG_DRAFT;
              const open = !long || expanded.has(d.id);
              const words = d.body.trim().split(/\s+/).length;
              return (
                <article key={d.id} className="draft" aria-label={`${d.kind} draft`}>
                  <header className="draft-head">
                    <b>{d.kind}</b>
                    <span className="muted">
                      {new Date(d.createdAt).toLocaleString()} · {words} words
                    </span>
                    <button onClick={() => void copy(d.id, d.body)}>
                      {copied === d.id ? "Copied" : "Copy"} {d.id === latest?.id && <kbd>c</kbd>}
                    </button>
                  </header>
                  {/* Never "ready to post": a draft is unread text until the
                      operator has read it. */}
                  <p className="muted small">Review, edit, and post it yourself.</p>
                  <DraftContext draft={d} />
                  <div className={open ? "draft-text" : "draft-text collapsed"}>{d.body}</div>
                  {long && (
                    <button
                      className="link"
                      aria-expanded={open}
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (open) next.delete(d.id);
                          else next.add(d.id);
                          return next;
                        })
                      }
                    >
                      {open ? "Show less" : "Read full draft"}
                    </button>
                  )}
                </article>
              );
            })}
            {drafts.length === 0 && <p className="muted small">No drafts yet.</p>}
          </section>

          {/* Last, and marked as the operator's own words rather than the model's. */}
          <section className="note">
            <div className="note-label">
              <span className="chip you">YOU</span>
              <h2 id="note-heading">Note</h2>
              {noteDirty && <span className="muted small">unsaved</span>}
            </div>
            <textarea
              rows={2}
              aria-labelledby="note-heading"
              value={noteValue}
              placeholder="Why this is or is not worth acting on"
              onChange={(e) => {
                setNote(e.target.value);
                pendingNotes.set(id, e.target.value);
              }}
              onBlur={() => void saveNote()}
            />
          </section>
        </div>
        {/* Evidence and provenance: beside the reading column when the pane is
            wide enough, after it otherwise. The facts the model was given, and
            when it judged them. */}
        <aside className="rail" aria-label="Evidence and provenance">
          {(finding.repository || finding.metrics) && (
            <section>
              <h2>Evidence</h2>
              {finding.repository && <Repository facts={finding.repository} />}
              {finding.metrics && <Engagement metrics={finding.metrics} />}
            </section>
          )}
          {assessment && !hidden && (
            <>
              {/* When the judgment was made. The publication date above is the
              thread's age, which is a different question. */}
              <section>
                <h2>Provenance</h2>
                <p className="muted small">
                  judged {new Date(assessment.createdAt).toLocaleString()} by {assessment.model} ·
                  rubric/brief {assessment.promptFingerprint}
                </p>
              </section>
              <EarlierVerdicts earlier={earlier} current={assessment.promptFingerprint} />
            </>
          )}
          {/* Identity, not judgment, so it stays while judgment is hidden.
              Collapsed: the header already names the finding for reading, and
              these are for acting on it elsewhere — `obserf show`, the address. */}
          <details className="metadata">
            <summary>Metadata</summary>
            <dl className="facts">
              <div>
                <dt>Finding</dt>
                <dd>
                  <code>#{finding.id}</code>
                </dd>
              </div>
              <div>
                <dt>URL</dt>
                <dd className="url">{finding.url}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{finding.sourceId}</dd>
              </div>
              <div>
                <dt>Published</dt>
                <dd>
                  {finding.publishedAt
                    ? new Date(finding.publishedAt).toLocaleString()
                    : "not reported by the source"}
                </dd>
              </div>
              <div>
                <dt>First found</dt>
                <dd>
                  {new Date(finding.discoveredAt).toLocaleString()}
                  {finding.firstRunId !== null && (
                    <span className="sub">by scan run #{finding.firstRunId}</span>
                  )}
                </dd>
              </div>
            </dl>
          </details>
        </aside>
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
 * The arithmetic behind the score, from the server's own computation — the
 * weights live only in `pipeline/score.ts`, so the page shows them, never
 * recomputes them.
 */
function Working({ breakdown }: { breakdown: ScoreExplanation }) {
  const { zeroedBy, terms, weighted, freshness, score } = breakdown;
  return (
    <details className="working">
      <summary>Why {score}?</summary>
      {zeroedBy ? (
        <p>
          A hard zero. {ZEROED_BY[zeroedBy]} No weighting can outvote it, so the components above do
          not count.
        </p>
      ) : (
        <dl>
          {terms.map((t) => (
            <div key={t.component}>
              <dt>{t.component}</dt>
              <dd>
                {t.value}/5 of {Math.round(t.weight * 100)} = {t.points.toFixed(1)}
              </dd>
            </div>
          ))}
          <div>
            <dt>on a fresh thread</dt>
            <dd>{weighted.toFixed(1)}</dd>
          </div>
          <div>
            <dt>age factor</dt>
            {/* Three places: `weighted` is a whole number, so the product below
                then agrees with the factor shown to the digit it is read at. */}
            <dd>×{freshness.toFixed(3)}</dd>
          </div>
          <div>
            <dt>score</dt>
            <dd>
              {/* The product before rounding, or a factor shown to two places can
                  appear to round the wrong way. */}
              {weighted.toFixed(1)} × {freshness.toFixed(3)} = {(weighted * freshness).toFixed(2)},
              rounded to {score}
            </dd>
          </div>
        </dl>
      )}
    </details>
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
    return <span title="No publication date, so no decay was applied.">age unknown</span>;
  }
  const days = Math.max(0, Math.floor((Date.now() - new Date(publishedAt).getTime()) / DAY_MS));
  const evergreen = opportunity !== null && EVERGREEN.has(opportunity);
  return (
    <span
      title={
        evergreen
          ? "The thread's age now. Listings do not decay: an old curated list still merging pull requests is a live opportunity."
          : "The thread's age now. Scores decay with age — halved every 30 days, floored at 15%."
      }
    >
      age <b>{days}d</b>
      {evergreen && " · evergreen"}
    </span>
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
    <dl className="facts">
      {points !== undefined && (
        <div>
          <dt>Points</dt>
          <dd>{points}</dd>
        </div>
      )}
      {comments !== undefined && (
        <div>
          <dt>Comments</dt>
          <dd>{comments}</dd>
        </div>
      )}
    </dl>
  );
}

/**
 * The repository evidence the model was given, in the same terms — `obserf show`
 * prints the same numbers. Read as a merge rate, never an acceptance rate: a
 * pull request closed unmerged was not necessarily refused, and the counts
 * include the maintainers' own work. Open PRs is a bare count: how long they have
 * waited, or on whom, is not recorded.
 */
function Repository({ facts }: { facts: NonNullable<Finding["repository"]> }) {
  const { stars, pullRequests } = facts;
  const resolved = pullRequests ? pullRequests.merged + pullRequests.closedUnmerged : 0;

  return (
    <dl className="facts">
      <div>
        <dt>Stars</dt>
        <dd>{stars}</dd>
      </div>
      {pullRequests && (
        <>
          <div>
            <dt>Open PRs</dt>
            <dd>{pullRequests.open}</dd>
          </div>
          {/* One window for both counts, named once. */}
          <div>
            <dt>Resolved · {pullRequests.windowDays}d</dt>
            <dd>
              {pullRequests.merged} merged · {pullRequests.closedUnmerged} closed unmerged
              <span className="sub">
                {resolved > 0
                  ? `${pullRequests.merged}/${resolved} resolved PRs merged`
                  : "no PRs resolved"}
              </span>
            </dd>
          </div>
        </>
      )}
    </dl>
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
