import { describe, expect, test } from "bun:test";
import { explain, freshness, rank, score } from "../pipeline/score";

const NOW = new Date("2026-09-09T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const perfect = {
  relevance: 5,
  intent: 5,
  welcome: 5,
  reach: 5,
  disqualified: false,
  opportunity: "discussion" as const,
};

describe("score", () => {
  test("a perfect, fresh finding scores 100", () => {
    expect(score(perfect, NOW, NOW)).toBe(100);
  });

  test("welcome: 0 is a hard gate, whatever else is true", () => {
    expect(score({ ...perfect, welcome: 0 }, NOW, NOW)).toBe(0);
  });

  test("the model's veto overrides every component", () => {
    expect(score({ ...perfect, disqualified: true }, NOW, NOW)).toBe(0);
  });

  test("fit outweighs audience size", () => {
    const goodFit = { ...perfect, welcome: 3, reach: 1 };
    const bigAudience = { ...perfect, relevance: 2, intent: 1, welcome: 3 };
    expect(score(goodFit, NOW, NOW)).toBeGreaterThan(score(bigAudience, NOW, NOW));
  });

  test("zero relevance is a hard gate — the other three cannot outvote 'not about this'", () => {
    // Weighted, this would otherwise reach 65: the exact bug the gate closes.
    expect(score({ ...perfect, relevance: 0 }, NOW, NOW)).toBe(0);
  });

  test("all three eligibility gates are independent", () => {
    expect(score({ ...perfect, relevance: 0 }, NOW, NOW)).toBe(0);
    expect(score({ ...perfect, welcome: 0 }, NOW, NOW)).toBe(0);
    expect(score({ ...perfect, disqualified: true }, NOW, NOW)).toBe(0);
  });

  // No test that out-of-range components are repaired: they are not. Every
  // component reaching here came through `AssessmentSchema`, which is where that
  // invariant is enforced and tested. Clamping here would have turned a bug in
  // this program into a plausible-looking score.
});

describe("explain", () => {
  // The inbox prints these as the working behind the score, so they must add up
  // to it rather than approximate it.
  test("its terms add up to the score it reports", () => {
    const e = explain(
      { ...perfect, relevance: 4, intent: 2, welcome: 3, reach: 1 },
      daysAgo(45),
      NOW,
    );
    const sum = e.terms.reduce((total, t) => total + t.points, 0);
    expect(sum).toBeCloseTo(e.weighted, 9);
    expect(e.score).toBe(Math.round(e.weighted * e.freshness));
    expect(e.score).toBe(
      score({ ...perfect, relevance: 4, intent: 2, welcome: 3, reach: 1 }, daysAgo(45), NOW),
    );
  });

  test("names the first hard zero in the order score checks them", () => {
    expect(
      explain({ ...perfect, relevance: 0, welcome: 0, disqualified: true }, NOW, NOW).zeroedBy,
    ).toBe("disqualified");
    expect(explain({ ...perfect, relevance: 0, welcome: 0 }, NOW, NOW).zeroedBy).toBe("relevance");
    expect(explain({ ...perfect, welcome: 0 }, NOW, NOW).zeroedBy).toBe("welcome");
    expect(explain(perfect, NOW, NOW).zeroedBy).toBeNull();
  });
});

describe("freshness", () => {
  test("halves every 30 days", () => {
    expect(freshness(daysAgo(30), "discussion", NOW)).toBeCloseTo(0.5, 5);
    expect(freshness(daysAgo(60), "discussion", NOW)).toBeCloseTo(0.25, 5);
  });

  test("floors at 0.15 rather than reaching zero", () => {
    expect(freshness(daysAgo(3650), "discussion", NOW)).toBe(0.15);
  });

  test("an unknown date is not penalized — the source failed to report it, not the thread", () => {
    expect(freshness(null, "discussion", NOW)).toBe(1);
  });

  test("listings do not decay — an old awesome-list still merges pull requests", () => {
    expect(freshness(daysAgo(3650), "listing", NOW)).toBe(1);
    expect(score({ ...perfect, opportunity: "listing" }, daysAgo(3650), NOW)).toBe(100);
  });

  test("but a thread of the same age is nearly worthless", () => {
    expect(score({ ...perfect, opportunity: "discussion" }, daysAgo(3650), NOW)).toBe(15);
  });

  test("a stale thread ranks below a fresh one with weaker components", () => {
    const staleStrong = score(perfect, daysAgo(365), NOW);
    const freshWeak = score(
      { ...perfect, relevance: 3, intent: 3, welcome: 3, reach: 2 },
      NOW,
      NOW,
    );
    expect(staleStrong).toBeLessThan(freshWeak);
  });
});

describe("rank", () => {
  let nextId = 1;
  const row = (
    components: Partial<typeof perfect>,
    publishedAt: Date,
    assessedAt = publishedAt,
  ) => ({
    finding: { publishedAt },
    assessment: { ...perfect, ...components, id: nextId++, createdAt: assessedAt },
  });

  /**
   * The reason nothing is stored: at assessment the old thread outscored the
   * fresh one, and a stored score would still rank it first today.
   */
  test("orders by the score at `now`, not at assessment", () => {
    const old = row({}, daysAgo(90));
    const fresh = row({ intent: 2, reach: 2 }, daysAgo(1));
    expect(score(old.assessment, old.finding.publishedAt, old.finding.publishedAt)).toBeGreaterThan(
      score(fresh.assessment, fresh.finding.publishedAt, fresh.finding.publishedAt),
    );
    expect(rank([old, fresh], { now: NOW }).map((r) => r.assessment.id)).toEqual([
      fresh.assessment.id,
      old.assessment.id,
    ]);
  });

  test("filters and bounds after scoring, so `limit` keeps the best", () => {
    const rows = [row({ reach: 1 }, NOW), row({ relevance: 0 }, NOW), row({}, NOW)];
    const ranked = rank(rows, { minScore: 1, limit: 1, now: NOW });
    expect(ranked).toEqual([{ ...rows[2]!, score: 100 }]);
  });

  test("breaks a tie by the newer verdict", () => {
    const earlier = row({}, NOW, daysAgo(2));
    const later = row({}, NOW, daysAgo(1));
    expect(rank([earlier, later], { now: NOW })[0]?.assessment.id).toBe(later.assessment.id);
  });

  test("a finding without an assessment scores zero and sorts last", () => {
    const unassessed = { finding: { publishedAt: NOW }, assessment: null };
    const ranked = rank([unassessed, row({ reach: 1 }, NOW)], { now: NOW });
    expect(ranked.map((r) => r.score)).toEqual([score({ ...perfect, reach: 1 }, NOW, NOW), 0]);
    expect(rank([unassessed], { minScore: 1, now: NOW })).toEqual([]);
  });
});
