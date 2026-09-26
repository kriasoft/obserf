import type { Run } from "../db/schema";

/**
 * The latest scan of each project in view, and whether it saw everything it was
 * asked to: one that skipped sources, died halfway or failed otherwise yields an
 * inbox indistinguishable from a complete one with less in it.
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
