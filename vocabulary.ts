/**
 * Vocabulary the database, the pipeline, and the browser must agree on.
 *
 * This module exists because the review inbox needs these values at runtime, and
 * importing them from `db/schema.ts` would pull `bun:sqlite` — and through
 * `pipeline/draft.ts`, the Agent SDK and `child_process` — into the browser
 * bundle. Nothing here may import anything.
 */

/**
 * The operator's decision. `skipped` and `dismissed` both mean "not acting on
 * it" but say opposite things about Obserf: `skipped` is a good recommendation
 * the operator chose to pass on, `dismissed` is one Obserf should not have made.
 * Kept apart so a busy week does not read as bad ranking, and so every
 * dismissal is evidence about the assessment.
 */
export const TRIAGE_STATUSES = ["new", "shortlisted", "skipped", "dismissed", "acted"] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

/** Decisions that end a finding's review: a scan never reassesses one while it holds. */
export const SETTLED: ReadonlySet<TriageStatus> = new Set<TriageStatus>([
  "skipped",
  "dismissed",
  "acted",
]);

/** Decisions that say the recommendation was right, whatever the operator then did. */
export const WORTH_SURFACING: ReadonlySet<TriageStatus> = new Set<TriageStatus>([
  "shortlisted",
  "skipped",
  "acted",
]);

/**
 * Why Obserf was wrong to recommend a finding, so the evaluation record can
 * count causes instead of parsing notes. The first seven are the diagnosis rows
 * of docs/product/evaluation.md, in its order; `other` is a failure outside the
 * table and points at no fix. A good finding passed over is `skipped`, not a
 * dismissal with a category.
 *
 * Never an input to scoring: a category says which layer to fix, and a weight
 * learned from it would hide the failure instead.
 */
export const DISMISSAL_CATEGORIES = [
  "cannot-solve",
  "vocabulary-only",
  "no-participation",
  "venue-forbids",
  "paid",
  "concluded",
  "no-audience",
  "other",
] as const;
export type DismissalCategory = (typeof DISMISSAL_CATEGORIES)[number];

/** The first fix evaluation.md names for each category; null where there is none. */
export const FIRST_FIX: Readonly<Record<DismissalCategory, string | null>> = {
  "cannot-solve": "profile `pitch` and `notFor`, then the prompt",
  "vocabulary-only": "`notFor`, then queries",
  "no-participation": "the evidence, then the prompt",
  "venue-forbids": "`venueGuidance`, then the prompt",
  paid: "the evidence, then the prompt",
  concluded: "the evidence, then the prompt",
  "no-audience": "source selection",
  other: null,
};

/**
 * Where a draft's view of the thread came from. `excerpt` is what the scan
 * stored, which for a search result can be a 300-character description of a
 * forty-reply thread. Stored in `drafts.context_source`, so a rename needs a
 * migration; `draftContextNote` owns the wording.
 */
export type DraftContextSource = "hn-algolia" | "github-api" | "page" | "excerpt";

const FETCHED_VIA: Record<Exclude<DraftContextSource, "excerpt">, string> = {
  "hn-algolia": "Hacker News via Algolia",
  "github-api": "the GitHub API",
  page: "the page itself",
};

/**
 * The line both front ends print with a draft. `complete` only for a whole read
 * at draft time: a draft from before this was recorded is unknown, not fine.
 */
export function draftContextNote(
  source: DraftContextSource | null,
  warning: string | null,
): { text: string; complete: boolean } {
  if (source === null) {
    return {
      text: "context source not recorded — draft predates provenance tracking",
      complete: false,
    };
  }
  const base =
    source === "excerpt"
      ? "written from the stored excerpt only"
      : `written from content fetched at draft time (${FETCHED_VIA[source]})`;
  return {
    text: warning ? `${base} — ${warning}` : base,
    complete: source !== "excerpt" && !warning,
  };
}

/** What the project's latest scan did to a finding: first stored it, or wrote its current verdict. */
export type LatestScanMark = "new" | "reassessed";

/**
 * A thread's age in one short token for a list row — `5h`, `3d`, `5w`, `8mo`,
 * `2y` — and `?` when the source reported no date. Rounded down, so a row never
 * reads younger than its thread. Says nothing about decay: a listing's age is
 * shown like any other, since how old a curated list is still matters, and a
 * row must not reveal the opportunity type while the model's judgment is hidden.
 */
export function compactAge(publishedAt: Date | string | null, now: Date = new Date()): string {
  if (!publishedAt) return "?";
  const hours = Math.max(0, (now.getTime() - new Date(publishedAt).getTime()) / 3_600_000);
  const days = hours / 24;
  if (days < 1) return `${Math.floor(hours)}h`;
  if (days < 14) return `${Math.floor(days)}d`;
  if (days < 70) return `${Math.floor(days / 7)}w`;
  // Two years by the divisor below, so `23mo` never steps back to `1y`.
  if (days < 2 * 365.25) return `${Math.floor(days / 30.44)}mo`;
  return `${Math.floor(days / 365.25)}y`;
}

export const OPPORTUNITY_TYPES = [
  "question",
  "discussion",
  "comparison",
  "listing",
  "mention",
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const DRAFT_KINDS = ["comment", "reply", "submission"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/**
 * The registered source adapters, in no particular order — `sources/index.ts`
 * owns precedence. Naming them here is not a new commitment: profiles list them
 * in `sources` and the CLI takes them in `--source`, so they are already public.
 * It only lets the compiler catch `"githb"` where the loader would otherwise
 * have to, which is what ADR-006 says TypeScript profiles are for.
 */
export const SOURCE_IDS = ["hn", "reddit", "github", "brave"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/**
 * Opportunity types that do not go stale with age, and so are exempt from the
 * freshness decay in `pipeline/score.ts`.
 *
 * A curated list is the opposite of a thread: an eight-year-old `awesome-*`
 * repository merging pull requests this week is a live opportunity, while a
 * thirty-day-old Reddit question is usually dead. Here rather than beside the
 * decay curve because the inbox has to say which findings are exempt, and the
 * curve itself must not reach the browser.
 */
export const EVERGREEN: ReadonlySet<OpportunityType> = new Set<OpportunityType>(["listing"]);

/**
 * The draft a given opportunity naturally wants: a curated list takes a
 * submission, a direct question takes a reply, everything else a top-level
 * comment. Implements the claim in docs/product/opportunities.md that the
 * opportunity type drives the draft; callers may still override it.
 *
 * Takes a type, never `null`. A verdict naming no type is one where the model
 * found no moment to act on, and no draft follows from that — so the absence is
 * the caller's decision to make, explicitly, rather than a `comment` invented
 * here.
 *
 * A comment URL normally requires a reply regardless of its opportunity type; a
 * listing remains a submission to the list. Null and undefined mean the source
 * did not classify the URL, so the opportunity type keeps its default.
 */
export function defaultKindFor(
  opportunity: OpportunityType,
  isThreadComment?: boolean | null,
): DraftKind {
  if (opportunity === "listing") return "submission";
  if (isThreadComment) return "reply";
  switch (opportunity) {
    case "question":
    case "mention":
      return "reply";
    default:
      return "comment";
  }
}
