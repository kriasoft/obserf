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
  if (components.disqualified || components.relevance === 0 || components.welcome === 0) {
    return 0;
  }

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

  return Math.round(100 * weighted * freshness(publishedAt, components.opportunity, now));
}
