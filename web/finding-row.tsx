import { compactAge } from "../vocabulary";
import type { ListedFinding } from "./api";

export function scoreClass(score: number): string {
  return score >= 70 ? "high" : score >= 40 ? "mid" : "low";
}

/**
 * One finding in the list, read in a glance: the score in a box of its own, the
 * title, then where and how old, and the operator's note marked as theirs.
 */
export function FindingRow({
  row: { finding, assessment, note, drafts, score, latestScan },
  selected,
  hidden,
  showProject,
  onSelect,
}: {
  row: ListedFinding;
  selected: boolean;
  /** The toggle hides this one's judgment: no score, no type. */
  hidden: boolean;
  /** Only when unfiltered: which project a finding belongs to decides the voice a draft is written in. */
  showProject: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      id={`finding-${finding.id}`}
      className="item"
      aria-current={selected}
      onClick={onSelect}
    >
      {hidden ? (
        <span className="score hidden" title="Hidden until triaged or revealed (r)">
          ·
        </span>
      ) : assessment ? (
        <span className={`score ${scoreClass(score)}`}>{score}</span>
      ) : (
        <span className="score" title="Not assessed">
          –
        </span>
      )}
      <span className="body">
        <span className="title">{finding.title}</span>
        <span className="meta">
          <span className="venue">{finding.venue}</span>
          <span title="The thread's age">· {compactAge(finding.publishedAt)}</span>
          {/* "No shape" is a verdict, the model naming no opportunity; only a
              finding with no assessment is unassessed. Both hide with the score:
              even whether a verdict exists is judgment the toggle covers. */}
          {!hidden && (
            <span>· {assessment ? (assessment.opportunity ?? "no shape") : "unassessed"}</span>
          )}
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
          {showProject && <span className="project">{finding.project}</span>}
          {/* Never "ready to post": a draft is unread text until the operator
              has read it. */}
          {drafts > 0 && (
            <span title={`${drafts} draft${drafts === 1 ? "" : "s"}`}>
              <span aria-hidden="true">✎{drafts}</span>
              <span className="sr-only">
                , {drafts} draft{drafts === 1 ? "" : "s"}
              </span>
            </span>
          )}
        </span>
        {/* The operator's words, marked as theirs and kept apart from the model's. */}
        {note && (
          <span className="rownote" title={note}>
            <span className="chip you">YOU</span>
            <span>{note}</span>
          </span>
        )}
      </span>
    </button>
  );
}
