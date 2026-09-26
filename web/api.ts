import type { Assessment, Draft, Finding } from "../db/schema";
import type { ScoreExplanation } from "../pipeline/score";
import { type DismissalCategory, type LatestScanMark, type TriageStatus } from "../vocabulary";

interface FindingView {
  finding: Finding;
  assessment: Assessment | null;
  status: TriageStatus;
  note: string | null;
  dismissalCategory: DismissalCategory | null;
}

/** `score` is computed by the server at request time, never stored. */
export type ListedFinding = FindingView & {
  drafts: number;
  score: number;
  /** The hard rule that zeroed the score; null when none did. */
  zeroedBy: ScoreExplanation["zeroedBy"];
  latestScan: LatestScanMark | null;
};

export type FindingDetail = FindingView & {
  score: number;
  /** How `score` was reached; null without an assessment. */
  breakdown: ScoreExplanation | null;
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

export const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Every request the inbox makes. A failed fetch, a non-2xx, and a body that is
 * not JSON all have to arrive as one thrown error: the previous version stored
 * an error body as though it were a finding, then crashed rendering it.
 */
export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await requestJsonWithHeaders<T>(path, init)).body;
}

/** `requestJson`, keeping the response headers for the one route that sends one. */
export async function requestJsonWithHeaders<T>(
  path: string,
  init?: RequestInit,
): Promise<{ body: T; headers: Headers }> {
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
  return { body: body as T, headers: response.headers };
}

/** The run record's position; see `runsMarker` in db/index.ts. */
export interface RunsMarker {
  lastRun: number;
  finished: number;
  lastAssessment: number;
}

/** Whether `a` has every run `b` has: none recorded that `a` lacks. */
export function covers(a: RunsMarker, b: RunsMarker): boolean {
  return a.lastRun >= b.lastRun && a.finished >= b.finished && a.lastAssessment >= b.lastAssessment;
}

/** The list's `X-Runs-Marker` header; null when absent or malformed. */
export function parseMarker(header: string | null): RunsMarker | null {
  const match = header?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match
    ? { lastRun: Number(match[1]), finished: Number(match[2]), lastAssessment: Number(match[3]) }
    : null;
}

export const postJson = <T>(path: string, payload: unknown): Promise<T> =>
  requestJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
