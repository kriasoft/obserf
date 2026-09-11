import { describe, expect, test } from "bun:test";
import { freshness, score } from "../pipeline/score";

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
