import type { Assessment, Draft, Finding } from "../db/schema";
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
  latestScan: LatestScanMark | null;
};

export type FindingDetail = FindingView & {
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

export const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Every request the inbox makes. A failed fetch, a non-2xx, and a body that is
 * not JSON all have to arrive as one thrown error: the previous version stored
 * an error body as though it were a finding, then crashed rendering it.
 */
export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
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

export const postJson = <T>(path: string, payload: unknown): Promise<T> =>
  requestJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
