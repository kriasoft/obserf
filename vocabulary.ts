/**
 * Vocabulary the database, the pipeline, and the browser must agree on.
 *
 * This module exists because the review inbox needs these values at runtime, and
 * importing them from `db/schema.ts` would pull `bun:sqlite` — and through
 * `pipeline/draft.ts`, the Agent SDK and `child_process` — into the browser
 * bundle. Nothing here may import anything.
 */

export const TRIAGE_STATUSES = ["new", "shortlisted", "dismissed", "acted"] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

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
