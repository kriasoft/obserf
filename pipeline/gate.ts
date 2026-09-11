/**
 * Deterministic rejections, run before any model call.
 *
 * These encode facts ("published in 2019", "the operator already dismissed
 * this", "the model disqualified this recently enough to still trust"), never
 * judgment of their own ("not relevant") — a keyword pre-filter would reject
 * exactly the paraphrased, high-intent questions that are the most valuable
 * findings. See docs/adr/004-deterministic-gates-before-the-model.md.
 */

import type { TriageStatus } from "../vocabulary";
import type { Candidate } from "../sources";
import { canonicalizeUrl, hostOf } from "../url";

/** In the order the gate applies them: a count names the first rule that matched. */
export const GATE_RULES = [
  "duplicate",
  "settled",
  "blocked",
  "stale",
  "thin",
  "unchanged",
  "ruled-out",
] as const;
export type GateRule = (typeof GATE_RULES)[number];

/** What obserf already knows about a URL, for deciding whether to look again. */
export interface KnownFinding {
  status: TriageStatus;
  lastAssessedAt: Date | null;
  /** The latest verdict's categorical eligibility failure. */
  disqualified: boolean;
  title: string;
  excerpt: string;
  metrics: { points?: number; comments?: number } | null;
}

export interface GateResult {
  /** Survivors, with `url` replaced by its canonical form. */
  kept: Candidate[];
  /** How many candidates each rule rejected. A silent gate is a bug. */
  rejected: Record<GateRule, number>;
}

/**
 * Every threshold the gate applies, passed in rather than read from the global
 * configuration. The caller owns policy — including merging the global
 * blocklist with the project's — which keeps this a pure function of its
 * arguments and lets the tests run with no environment. Only `now` defaults,
 * and a clock is not policy.
 */
export interface GateOptions {
  /** Canonical URL → what obserf already knows, for this project. */
  known: ReadonlyMap<string, KnownFinding>;
  /** Hosts (subdomains included) and `host/path` prefixes never worth a call. */
  blockedDomains: readonly string[];
  maxAgeDays: number;
  minTextLength: number;
  /** Re-examine an unsettled finding after this long, even if nothing changed. */
  reassessAfterDays: number;
  /** The same for one the model disqualified. Longer; see the `ruled-out` rule. */
  reassessDisqualifiedAfterDays: number;
  now?: Date;
}

/**
 * Engagement that grew by half again, or by ten interactions, is a different
 * moment worth a second look — a post ignored at discovery that then reached the
 * front page is the opportunity, and the first observation is the one to distrust.
 *
 * Deliberately crude. Precise change detection is not worth building before real
 * use shows which changes actually matter.
 */
function materiallyChanged(candidate: Candidate, known: KnownFinding): boolean {
  if (candidate.title !== known.title) return true;
  if (candidate.excerpt !== known.excerpt) return true;

  const before = (known.metrics?.points ?? 0) + (known.metrics?.comments ?? 0);
  const after = (candidate.metrics?.points ?? 0) + (candidate.metrics?.comments ?? 0);
  return after - before >= 10 || (before > 0 && after / before >= 1.5);
}

export function gate(candidates: Candidate[], options: GateOptions): GateResult {
  const {
    known,
    blockedDomains,
    maxAgeDays,
    minTextLength,
    reassessAfterDays,
    reassessDisqualifiedAfterDays,
    now = new Date(),
  } = options;
  const rejected: Record<GateRule, number> = {
    duplicate: 0,
    settled: 0,
    blocked: 0,
    stale: 0,
    thin: 0,
    unchanged: 0,
    "ruled-out": 0,
  };
  const kept: Candidate[] = [];

  const batch = new Set<string>();
  const maxAgeMs = maxAgeDays * 86_400_000;

  for (const candidate of candidates) {
    const url = canonicalizeUrl(candidate.url);

    // Two sources routinely return the same thread. The first to reach the
    // history checks owns the URL for this scan, whether or not it survives them.
    if (batch.has(url)) {
      rejected.duplicate++;
      continue;
    }
    const seen = known.get(url);
    // The operator has ruled on it, and their decision outranks every other
    // rule — which is why this runs before the content checks. It is reported as
    // `settled` rather than as whichever fact also happens to be true of it.
    if (seen && (seen.status === "dismissed" || seen.status === "acted")) {
      rejected.settled++;
      continue;
    }

    if (blockedDomains.some((domain) => matchesDomain(url, domain))) {
      rejected.blocked++;
      continue;
    }
    // Claims the URL, unlike the two rules above it — not because age outranks
    // them, but because it is the only one of the three whose answer can differ
    // between two candidates for the same canonical URL. `settled` and `blocked`
    // read the URL and the stored status, which every duplicate shares. Age
    // comes from the candidate, and a search engine that omits a date has not
    // established that the thread is young: letting an undated duplicate through
    // would let a worse source erase what the better one knew.
    if (candidate.publishedAt && now.getTime() - candidate.publishedAt.getTime() > maxAgeMs) {
      batch.add(url);
      rejected.stale++;
      continue;
    }
    if (`${candidate.title} ${candidate.excerpt}`.trim().length < minTextLength) {
      rejected.thin++;
      continue;
    }

    // `thin` is the one rejection a duplicate may overturn, and it is the reason
    // the claim happens here rather than at the top: a direct adapter can return
    // a title with no body where another representation of the same URL carries
    // enough text to assess. Everything from here down compares this snapshot
    // against the stored one, and there a second source is not a second chance —
    // Brave's search description of a thread differs from Hacker News' own text
    // for the same unchanged thread, so judging it would manufacture material
    // change out of a worse representation, and storing the result would replace
    // the better snapshot with it.
    batch.add(url);

    if (seen) {
      // Categorical failures warrant a longer cooldown, but not permanent
      // suppression: a venue can reopen without its search snippet changing.
      const idleMs =
        (seen.disqualified ? reassessDisqualifiedAfterDays : reassessAfterDays) * 86_400_000;
      const due = !seen.lastAssessedAt || now.getTime() - seen.lastAssessedAt.getTime() >= idleMs;
      if (!due && !materiallyChanged(candidate, seen)) {
        rejected[seen.disqualified ? "ruled-out" : "unchanged"]++;
        continue;
      }
    }

    kept.push({ ...candidate, url });
  }

  return { kept, rejected };
}

/**
 * A bare host matches that host and its subdomains; a `host/path` pattern
 * matches that path and everything beneath it.
 *
 * Compared structurally rather than as a substring of the URL, which blocked
 * more than it claimed: `github.com/acme/widget` also caught
 * `.../widget-next`, and a pattern appearing anywhere in a query
 * string blocked a URL it had nothing to do with.
 */
function matchesDomain(url: string, pattern: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (!pattern.includes("/")) return host === pattern || host.endsWith(`.${pattern}`);

  // `hostOf` drops a leading `www.`, so patterns are written without it too.
  const path = new URL(url).pathname.replace(/\/+$/, "");
  const value = `${host}${path}`;
  return value === pattern || value.startsWith(`${pattern}/`);
}
