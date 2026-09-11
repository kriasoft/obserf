import type { SourceId } from "../vocabulary";
import type { ProjectProfile } from "../project";

/**
 * Pull-request counts used to assess a curated list's receptiveness (ADR-009).
 * Open is the current backlog; merged and closed-unmerged share a time window.
 * These counts do not distinguish maintainers' work from outside submissions.
 */
export interface PullRequestActivity {
  /** Currently open, regardless of when the pull request was created. */
  open: number;
  /** How far back `merged` and `closedUnmerged` count. */
  windowDays: number;
  /** Merged inside the window. */
  merged: number;
  /**
   * Closed inside the window without being merged. Read against `merged` this
   * is the receptiveness signal, but closure alone does not establish why: a
   * pull request can be withdrawn by its author, superseded, a duplicate, or
   * spam. Do not present it as a count of submissions the maintainer refused.
   */
  closedUnmerged: number;
}

/**
 * A repository, when the candidate *is* one rather than a discussion.
 *
 * Separate from `metrics` because stars are not engagement with a thread: the
 * gate sums `metrics` to detect a moment gaining momentum, and adding a star
 * count to that sum makes the total mean nothing. `pullRequests` is absent
 * until `Source.enrich` fills it.
 */
export interface RepositoryFacts {
  stars: number;
  pullRequests?: PullRequestActivity;
}

/** One normalized result from a source. See docs/adr/007-sources-are-adapters.md. */
export interface Candidate {
  sourceId: SourceId;
  /** Raw URL; canonicalized by the gate, not the adapter. */
  url: string;
  title: string;
  excerpt: string;
  author?: string;
  /** Where this lives, for a human: "news.ycombinator.com", "r/golang". */
  venue: string;
  publishedAt?: Date;
  /** Engagement on a discussion, where the source reports it. Feeds `reach`. */
  metrics?: { points?: number; comments?: number };
  /**
   * True when `url` points at one comment inside a discussion: `excerpt` is that
   * comment and `title` names its thread. Absent means unclassified, not a
   * top-level thread. Normalized because downstream behavior must not inspect an
   * adapter-specific `raw` payload to distinguish them.
   */
  isThreadComment?: boolean;
  /** Set when the candidate is a repository rather than a discussion. */
  repository?: RepositoryFacts;
  raw?: unknown;
}

export interface SearchOptions {
  /** Maximum results per query. */
  limit: number;
}

export interface Source {
  id: SourceId;
  /**
   * Why this source cannot run for this project, or `null` when it can. A reason
   * string rather than a boolean so a scan can distinguish "no results" from
   * "no API key" (ADR-007).
   *
   * Two things stop a source, and the project is here because of the second:
   * credentials it does not have, and usable queries the profile never gave it. Both
   * end with the source not running, and a source that returns an empty array
   * instead reports the profile's silence as a searched and quiet web.
   *
   * Answer the configuration before the credentials. A profile that lists no
   * subreddits is not fixed by registering a Reddit app.
   */
  unavailable(project: ProjectProfile): string | null;
  search(project: ProjectProfile, options: SearchOptions): Promise<Candidate[]>;
  /**
   * Add expensive evidence to this source's gate survivors only (ADR-009).
   * Return each candidate exactly once, preserving its URL and sourceId;
   * reordering is allowed. The pipeline enforces this contract and propagates
   * failures. Request pacing belongs in the adapter, as it does for `search`.
   */
  enrich?(candidates: readonly Candidate[]): Promise<Candidate[]>;
}
