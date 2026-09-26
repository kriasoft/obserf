import { EVERGREEN, type OpportunityType } from "../vocabulary";

/**
 * Components → rank. The only place the weights appear.
 *
 * The model produces the components; this produces the number. See
 * docs/adr/003-model-scores-components-code-ranks.md and docs/product/scoring.md.
 */

export interface ScoreComponents {
  /** Is this actually about the problem the project solves? 0-5 */
  relevance: number;
  /** Is someone looking for a solution now? 0-5 */
  intent: number;
  /** Would a mention be welcome under this venue's norms? 0-5 */
  welcome: number;
  /** Will anyone read it? 0-5 */
  reach: number;
  disqualified: boolean;
  /** Shape of the moment. Null when the model rejected it outright. */
  opportunity: OpportunityType | null;
}

const WEIGHTS = { relevance: 0.35, intent: 0.3, welcome: 0.2, reach: 0.15 } as const;

const HALF_LIFE_DAYS = 30;
const FRESHNESS_FLOOR = 0.15;

const DAY_MS = 86_400_000;

/**
 * Decays the whole score rather than subtracting a term: a dead thread is worth
 * less on every dimension at once, because nobody is reading it any more.
 */
export function freshness(
  publishedAt: Date | null | undefined,
  opportunity: OpportunityType | null = null,
  now = new Date(),
): number {
  if (opportunity && EVERGREEN.has(opportunity)) return 1;
  if (!publishedAt) return 1; // Unknown date: do not penalize what the source did not report.
  const ageDays = Math.max(0, (now.getTime() - publishedAt.getTime()) / DAY_MS);
  return Math.max(FRESHNESS_FLOOR, 0.5 ** (ageDays / HALF_LIFE_DAYS));
}

/**
 * 0-100, with three independent hard zeros. Each corresponds to one of the
 * product's three eligibility conditions — useful, permitted, free — which are
 * prerequisites rather than preferences, so no weighted term can outvote them.
 *
 *   relevance 0  the project does not address this at all
 *   welcome 0    a mention here would be spam or against the rules
 *   disqualified a categorical failure: a `notFor` match, a paid placement,
 *                or no way to participate
 *
 * Without the relevance gate, a candidate the model called completely unrelated
 * could still reach 65 on the strength of the other three components.
 */
export function score(
  components: ScoreComponents,
  publishedAt: Date | null | undefined,
  now = new Date(),
): number {
  return explain(components, publishedAt, now).score;
}

/** How `score` reached its number, for an operator who disagrees with it. */
export interface ScoreExplanation {
  /** The hard zero that applied, the first in the order `score` checks them. */
  zeroedBy: "disqualified" | "relevance" | "welcome" | null;
  /** Each component's share of `weighted`: its weight times its value, on 0-100. */
  terms: Array<{ component: keyof typeof WEIGHTS; value: number; weight: number; points: number }>;
  /** 0-100 before the age factor; what the score would be on a fresh thread. */
  weighted: number;
  /** The age factor applied, from `FRESHNESS_FLOOR` to 1. */
  freshness: number;
  score: number;
}

/**
 * The hard zero that applies, the first in the order `score` checks them; null
 * when none does. Independent of the clock, so a list can say which rows are
 * zero by rule without computing the rest.
 */
export function hardZero(components: ScoreComponents): ScoreExplanation["zeroedBy"] {
  if (components.disqualified) return "disqualified";
  if (components.relevance === 0) return "relevance";
  if (components.welcome === 0) return "welcome";
  return null;
}

/** `score`, with its working: the one computation both the rank and the inbox read. */
export function explain(
  components: ScoreComponents,
  publishedAt: Date | null | undefined,
  now = new Date(),
): ScoreExplanation {
  const zeroedBy = hardZero(components);

  // Unclamped. `AssessmentSchema` accepts only integers 0-5, and every stored
  // row came through it, so a value outside that range is a bug in this program
  // — and silently repairing it to 5 would hide the bug behind a plausible
  // score. It is arithmetic either way; out of range it produces an obviously
  // wrong number rather than a quietly wrong one.
  const weighted =
    (WEIGHTS.relevance * components.relevance +
      WEIGHTS.intent * components.intent +
      WEIGHTS.welcome * components.welcome +
      WEIGHTS.reach * components.reach) /
    5;
  const factor = freshness(publishedAt, components.opportunity, now);

  return {
    zeroedBy,
    terms: (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).map((component) => ({
      component,
      value: components[component],
      weight: WEIGHTS[component],
      points: (100 * WEIGHTS[component] * components[component]) / 5,
    })),
    weighted: 100 * weighted,
    freshness: factor,
    // The same expression as before `explain` existed, so no score rounds differently.
    score: zeroedBy ? 0 : Math.round(100 * weighted * factor),
  };
}

/**
 * The fields `rank` reads. Structural, so storage can hand its rows over without
 * `db/` importing this module.
 */
interface Rankable {
  finding: { publishedAt: Date | null };
  assessment: (ScoreComponents & { id: number; createdAt: Date }) | null;
}

/**
 * Orders findings by their score now. No score is stored: one fixed at
 * assessment would leave a thread assessed a month ago carrying its day-one
 * freshness against one assessed this morning, so the order would say more about
 * when each was scanned than about what is worth reading — and a weight change
 * would need a maintenance command to reach the inbox. Scoring every row on each
 * read is cheap at the size of one operator's database: hundreds of rows.
 *
 * `minScore` and `limit` apply after scoring, which is why they are here and not
 * in the query. A finding without an assessment scores zero and sorts last.
 */
export function rank<T extends Rankable>(
  rows: T[],
  options: { minScore?: number; limit?: number; now?: Date } = {},
): Array<T & { score: number }> {
  const { minScore = 0, limit = Infinity, now = new Date() } = options;
  return (
    rows
      .map((row) => ({ ...row, score: scoreNow(row, now) }))
      .filter((row) => row.score >= minScore)
      // Newest verdict first among equals, then `id`: two assessments can share a
      // stored timestamp, and without a monotonic tie-break their order is unspecified.
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.assessment?.createdAt.getTime() ?? 0) - (a.assessment?.createdAt.getTime() ?? 0) ||
          (b.assessment?.id ?? 0) - (a.assessment?.id ?? 0),
      )
      .slice(0, limit)
  );
}

/** One finding's score at `now`: zero without an assessment. */
export function scoreNow(row: Rankable, now = new Date()): number {
  return row.assessment ? score(row.assessment, row.finding.publishedAt, now) : 0;
}
