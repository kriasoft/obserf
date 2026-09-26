import { useId, type ReactNode } from "react";
import type { Run } from "../db/schema";

/**
 * The latest scan of each project in view, and whether it saw everything it was
 * asked to: one that skipped sources, died halfway or failed otherwise yields an
 * inbox indistinguishable from a complete one with less in it. A pill in the
 * header that says so at a glance, opening the full report; it never scrolls
 * away, and never pushes the findings down.
 */
export function ScanStatus({
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
  const reportId = useId();
  // Said rather than swallowed: the completeness warnings below are the reason
  // this exists, so their absence must not be readable as "all clear".
  if (error) {
    return (
      <Pill reportId={reportId} tone="bad" label="Scan record unreadable">
        <p className="warn">Could not read the scan record — {error}</p>
      </Pill>
    );
  }
  if (!runs || !requiredProjects) return null;
  // Only projects in view: a retired one outside the list is no more reported
  // for having a run than for lacking one.
  const shown = runs.filter((run) => requiredProjects.includes(run.project));
  const unscanned = requiredProjects.filter((key) => !shown.some((run) => run.project === key));
  if (!shown.length && !unscanned.length) return null;

  const failed = shown.filter((run) => run.error !== null).length;
  const open = shown.filter((run) => run.finishedAt === null).length;
  const skipped = shown.reduce((n, run) => n + Object.keys(run.skipped ?? {}).length, 0);
  const unrecorded = shown.filter((run) => run.skipped === null).length;
  const ages = shown
    .map((run) => new Date(run.startedAt))
    .sort((a, b) => b.getTime() - a.getTime());
  const newest = ages[0];
  const oldest = ages.at(-1);
  const problems = [
    failed && `${failed} failed`,
    unscanned.length && `${unscanned.length} never scanned`,
    open && `${open} unfinished`,
    skipped && `${skipped} source${skipped === 1 ? "" : "s"} skipped`,
    unrecorded && "sources not recorded",
  ].filter(Boolean);
  const when =
    newest && oldest
      ? ago(newest) === ago(oldest)
        ? `Scan ${ago(newest)}`
        : `Scans ${ago(newest).replace(" ago", "")}–${ago(oldest)}`
      : "No scan";
  const tone = failed || unscanned.length ? "bad" : problems.length ? "mid" : "good";

  return (
    <Pill
      reportId={reportId}
      tone={tone}
      // One problem is named; more are counted, or the pill crowds the filters
      // out of the header. The report and the title carry every one.
      label={[
        when,
        ...(problems.length > 1
          ? [`${failed + unscanned.length + open + skipped + unrecorded} problems`]
          : problems),
      ].join(" · ")}
      title={[when, ...problems].join(" · ")}
    >
      <ScanReport shown={shown} unscanned={unscanned} showProject={showProject} />
    </Pill>
  );
}

/** The pill and the popover it opens; Esc or a click outside closes it. */
function Pill({
  reportId,
  tone,
  label,
  title = label,
  children,
}: {
  reportId: string;
  tone: "good" | "mid" | "bad";
  label: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        className="scan-pill"
        popoverTarget={reportId}
        data-tone={tone}
        title={title}
      >
        {label}
      </button>
      <div id={reportId} popover="auto" className="scan-report small">
        {children}
      </div>
    </>
  );
}

function ScanReport({
  shown,
  unscanned,
  showProject,
}: {
  shown: Run[];
  unscanned: string[];
  showProject: boolean;
}) {
  return (
    <div className="scan">
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
