/**
 * Environment and tunables. Bun loads .env automatically.
 *
 * Secrets are read lazily via getters: importing this module must not fail on a
 * machine that has no keys, because `obserf list` and `obserf serve` never need them.
 *
 * Numeric tunables are the opposite — read and validated at import, so a typo
 * fails before a scan spends any requests rather than after.
 */

/**
 * `Number("oops")` is NaN, and every comparison against NaN is false. A mistyped
 * OBSERF_MAX_AGE_DAYS would therefore switch the stale gate off silently, and a
 * mistyped OBSERF_RESULTS_PER_QUERY would send "NaN" to a source API.
 */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export const config = {
  /**
   * Assessment and drafting both run here, through the Claude Agent SDK on the
   * operator's Claude Code subscription — obserf holds no API key.
   * See docs/adr/008-claude-code-subscription.md.
   */
  model: process.env.OBSERF_MODEL ?? "claude-opus-5",

  get braveApiKey() {
    return process.env.BRAVE_API_KEY;
  },
  get githubToken() {
    return process.env.GITHUB_TOKEN;
  },
  /**
   * Which `gh` account to borrow a token from, when `GITHUB_TOKEN` is unset.
   * Unset means whichever account `gh` has active — fine on a single-account
   * machine, ambiguous on one with several. Named `OBSERF_`-prefixed because a
   * bare `GITHUB_USER` is commonly set to something else by CI images.
   */
  get githubUser() {
    return process.env.OBSERF_GITHUB_USER;
  },
  /** App-only OAuth: approved app credentials, no user authorization at runtime. */
  get redditClientId() {
    return process.env.REDDIT_CLIENT_ID;
  },
  get redditClientSecret() {
    return process.env.REDDIT_CLIENT_SECRET;
  },

  /** Reddit and GitHub both reject or throttle requests without a real User-Agent. */
  userAgent: process.env.OBSERF_USER_AGENT ?? "obserf/0.1 (+https://obserf.com)",

  /** Gate thresholds — see docs/adr/004-deterministic-gates-before-the-model.md */
  gate: {
    maxAgeDays: positiveInt("OBSERF_MAX_AGE_DAYS", 365),
    minTextLength: 40,
    /**
     * Revisit an unsettled finding after this long even if nothing visibly
     * changed: a thread's context can shift without its title or engagement
     * moving.
     */
    reassessAfterDays: positiveInt("OBSERF_REASSESS_AFTER_DAYS", 7),
    /**
     * The same for a finding the model disqualified. Longer because a
     * categorical rejection rarely stops being true, finite because "nothing
     * free to participate in" describes the evidence available at the time.
     */
    reassessDisqualifiedAfterDays: positiveInt("OBSERF_REASSESS_DISQUALIFIED_AFTER_DAYS", 30),
    /** Never an opportunity: aggregators, mirrors, and content farms. */
    blockedDomains: [
      "pinterest.com",
      "quora.com",
      "slideshare.net",
      "scribd.com",
      "coursehero.com",
      "issuu.com",
      "medium.com/m",
      "translate.google.com",
      "webcache.googleusercontent.com",
    ],
  },

  /** Per-source result cap per query, to keep a scan bounded. */
  resultsPerQuery: positiveInt("OBSERF_RESULTS_PER_QUERY", 10),

  /** Concurrent assessment calls. Higher is faster until rate limits bite. */
  assessConcurrency: positiveInt("OBSERF_ASSESS_CONCURRENCY", 4),
} as const;
