import { describe, expect, test } from "bun:test";
import {
  AssessmentSchema,
  assessPromptFingerprint,
  candidateBlock,
  normalizeVerdict,
} from "../pipeline/assess";
import type { ProjectProfile } from "../project";
import { score } from "../pipeline/score";
import type { Candidate } from "../sources";

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    sourceId: "github",
    url: "https://github.com/someone/awesome-devtools",
    title: "someone/awesome-devtools",
    excerpt: "A curated list of developer tools.",
    venue: "github.com/someone/awesome-devtools",
    ...over,
  };
}

// `score()` trusts these bounds rather than clamping, so this schema is the only
// thing standing between a malformed model response and an arithmetically absurd
// ranking. The `reason` is an explanation by definition; an empty one is not one.
describe("AssessmentSchema", () => {
  const verdict = {
    relevance: 5,
    intent: 4,
    welcome: 3,
    reach: 2,
    opportunity: "question",
    disqualified: false,
    reason: "Someone is asking exactly this.",
  };

  test("accepts a well-formed verdict", () => {
    expect(AssessmentSchema.parse(verdict)).toMatchObject({ relevance: 5 });
  });

  test("rejects a component outside 0-5", () => {
    expect(() => AssessmentSchema.parse({ ...verdict, relevance: 99 })).toThrow();
    expect(() => AssessmentSchema.parse({ ...verdict, reach: -3 })).toThrow();
  });

  test("rejects a fractional component", () => {
    expect(() => AssessmentSchema.parse({ ...verdict, intent: 3.5 })).toThrow();
  });

  test("rejects an unknown opportunity type", () => {
    expect(() => AssessmentSchema.parse({ ...verdict, opportunity: "listicle" })).toThrow();
  });

  test("rejects an empty reason", () => {
    expect(() => AssessmentSchema.parse({ ...verdict, reason: "   " })).toThrow();
  });
});

describe("candidateBlock", () => {
  // The defect this replaced: a repository's stars went to the model as `Points`
  // and its open issues as `Comments`, so an abandoned list would arrive looking
  // like a busy discussion.
  test("a repository reports stars, and never points or comments", () => {
    const block = candidateBlock(candidate({ repository: { stars: 1500 } }));
    expect(block).toContain("Stars: 1500");
    expect(block).not.toContain("Points:");
    expect(block).not.toContain("Comments:");
  });

  test("a discussion reports points and comments, and never stars", () => {
    const block = candidateBlock(
      candidate({
        sourceId: "hn",
        venue: "news.ycombinator.com",
        metrics: { points: 46, comments: 32 },
      }),
    );
    expect(block).toContain("Points: 46");
    expect(block).toContain("Comments: 32");
    expect(block).not.toContain("Stars:");
  });

  test("merge behaviour includes closed-unmerged counts", () => {
    const block = candidateBlock(
      candidate({
        repository: {
          stars: 161,
          pullRequests: { open: 4, windowDays: 365, merged: 12, closedUnmerged: 1 },
        },
      }),
    );
    expect(block).toContain("Open pull requests: 4");
    expect(block).toContain("Pull requests merged in the last 365 days: 12");
    expect(block).toContain("Pull requests closed unmerged in the same period: 1");
  });

  // Enrichment that did not run must read as silence. A
  // zero here would be indistinguishable from a maintainer who merges nothing,
  // which is the exact verdict the enrichment exists to get right.
  test("an unenriched repository says nothing at all about merges", () => {
    const block = candidateBlock(candidate({ repository: { stars: 85 } }));
    expect(block).not.toContain("merged");
    expect(block).not.toContain("Open pull requests");
  });

  // The shape this evidence exists to expose: topically perfect and pushed
  // often, while closing most of what it resolves without merging it.
  test("a list that merges little of what it resolves says so plainly", () => {
    const block = candidateBlock(
      candidate({
        repository: {
          stars: 1200,
          pullRequests: { open: 40, windowDays: 365, merged: 10, closedUnmerged: 90 },
        },
      }),
    );
    expect(block).toContain("Open pull requests: 40");
    expect(block).toContain("Pull requests merged in the last 365 days: 10");
    expect(block).toContain("Pull requests closed unmerged in the same period: 90");
  });
});

// `opportunity: null` means the moment is none of the five shapes, which is the
// definition of not being an opportunity. The schema types the two fields
// independently, so the model can assert both at once; the weighted score
// ignores `opportunity`, so such a verdict would otherwise outrank real findings.
describe("candidateBlock names the candidate's shape", () => {
  test("says so when the candidate is one comment inside a thread", () => {
    expect(candidateBlock(candidate({ isThreadComment: true }))).toContain(
      "Shape: one comment inside that thread, not the thread itself",
    );
  });

  test("says nothing when the source did not say", () => {
    expect(candidateBlock(candidate())).not.toContain("Shape:");
    expect(candidateBlock(candidate({ isThreadComment: false }))).not.toContain("Shape:");
  });
});

describe("a verdict that names no opportunity type", () => {
  const verdict = {
    relevance: 5,
    intent: 5,
    welcome: 3,
    reach: 4,
    opportunity: null,
    disqualified: false,
    reason: "Looks relevant.",
  };

  test("would score above almost everything if it stood", () => {
    expect(score(verdict, new Date(), new Date())).toBeGreaterThan(80);
  });

  test("is settled as disqualified, and says why", () => {
    const settled = normalizeVerdict(verdict);
    expect(settled.disqualified).toBe(true);
    expect(settled.reason).toMatch(/No opportunity type was named/);
    expect(score(settled, new Date(), new Date())).toBe(0);
  });

  test("a verdict that names one is left alone", () => {
    const named = { ...verdict, opportunity: "question" as const };
    expect(normalizeVerdict(named)).toEqual(named);
  });
});

/**
 * The assessment and the drafter read `venueGuidance` separately, and must
 * agree on what counts as a rule: `venueRuleFor` treats a blank entry as none,
 * so the assessment must too, or the model is told a venue has a verified rule
 * that says nothing. Observed through the fingerprint, which hashes the system
 * prompt and is the one thing outside the module that reads it.
 */
describe("the venue rules the assessment is handed", () => {
  const profile = (venueGuidance?: Record<string, string>): ProjectProfile => ({
    key: "k",
    name: "N",
    url: "https://e.com",
    pitch: "p",
    solves: ["s"],
    notFor: ["n"],
    voice: "v",
    queries: { search: ["a"], subreddits: [], github: [] },
    venueGuidance,
  });

  test("a blank entry is no rule, as it is to the drafter", () => {
    expect(assessPromptFingerprint(profile({ "r/x": "   " }))).toBe(
      assessPromptFingerprint(profile({})),
    );
  });

  test("a real entry is one", () => {
    expect(assessPromptFingerprint(profile({ "r/x": "link only in the weekly thread" }))).not.toBe(
      assessPromptFingerprint(profile({})),
    );
  });
});
