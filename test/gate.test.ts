import { describe, expect, test } from "bun:test";
import { gate, type KnownFinding } from "../pipeline/gate";
import type { Candidate } from "../sources";

const NOW = new Date("2026-09-09T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const NONE = new Map<string, KnownFinding>();

/** The thresholds `scan` reads from config, so the tests exercise real policy. */
const POLICY = {
  blockedDomains: [] as readonly string[],
  maxAgeDays: 365,
  minTextLength: 40,
  reassessAfterDays: 7,
  reassessDisqualifiedAfterDays: 30,
  now: NOW,
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    sourceId: "hn",
    url: "https://example.com/thread",
    title: "What do people use to tail and filter JSON logs locally?",
    excerpt: "I am starting a new project and cannot decide between the options.",
    venue: "example.com",
    publishedAt: NOW,
    ...overrides,
  };
}

function known(overrides: Partial<KnownFinding> = {}): Map<string, KnownFinding> {
  const base = candidate();
  return new Map([
    [
      "https://example.com/thread",
      {
        status: "new",
        lastAssessedAt: NOW,
        disqualified: false,
        title: base.title,
        excerpt: base.excerpt,
        metrics: null,
        ...overrides,
      } satisfies KnownFinding,
    ],
  ]);
}

describe("gate", () => {
  test("keeps a fresh, unknown, substantial candidate", () => {
    const result = gate([candidate()], { ...POLICY, known: NONE });
    expect(result.kept).toHaveLength(1);
    expect(Object.values(result.rejected).every((n) => n === 0)).toBe(true);
  });

  test("canonicalizes before comparing, so tracking parameters do not defeat dedupe", () => {
    const result = gate([candidate({ url: "http://www.example.com/thread/?utm_source=x#top" })], {
      ...POLICY,
      known: known(),
    });
    expect(result.kept).toHaveLength(0);
    expect(result.rejected.unchanged).toBe(1);
  });

  test("deduplicates within one batch — two sources return the same thread", () => {
    const result = gate([candidate(), candidate({ sourceId: "brave" })], {
      ...POLICY,
      known: NONE,
    });
    expect(result.kept).toHaveLength(1);
    expect(result.rejected.duplicate).toBe(1);
  });

  test("rejects candidates past the age cutoff", () => {
    const old = candidate({ publishedAt: new Date("2019-01-01T00:00:00Z") });
    expect(gate([old], { ...POLICY, known: NONE }).rejected.stale).toBe(1);
  });

  test("blocks per-project domains and their subdomains", () => {
    const result = gate([candidate({ url: "https://blog.competitor.com/post" })], {
      ...POLICY,
      known: NONE,
      blockedDomains: ["competitor.com"],
    });
    expect(result.rejected.blocked).toBe(1);
  });

  test("rejects candidates with too little text to judge", () => {
    const thin = candidate({ title: "hi", excerpt: "" });
    expect(gate([thin], { ...POLICY, known: NONE }).rejected.thin).toBe(1);
  });

  test("a missing published date is kept — staleness is unproven, not assumed", () => {
    const result = gate([candidate({ publishedAt: undefined })], { ...POLICY, known: NONE });
    expect(result.kept).toHaveLength(1);
  });

  test("survivors carry the canonical url forward", () => {
    const result = gate([candidate({ url: "https://Example.com/thread?utm_medium=a" })], {
      ...POLICY,
      known: NONE,
    });
    expect(result.kept[0]!.url).toBe("https://example.com/thread");
  });
});

describe("gate: revisiting what it already knows", () => {
  test("an unchanged, recently assessed finding is not re-sent to the model", () => {
    const result = gate([candidate()], { ...POLICY, known: known() });
    expect(result.rejected.unchanged).toBe(1);
  });

  test("the operator's decision outranks any new activity", () => {
    for (const status of ["dismissed", "acted"] as const) {
      const result = gate([candidate({ metrics: { points: 500, comments: 300 } })], {
        ...POLICY,
        known: known({ status }),
      });
      expect(result.rejected.settled).toBe(1);
    }
  });

  test("a host/path pattern stops at a path boundary", () => {
    const blocked = ["github.com/acme/widget"];
    const of = (url: string) =>
      gate([candidate({ url })], { ...POLICY, known: NONE, blockedDomains: blocked });

    expect(of("https://github.com/acme/widget").rejected.blocked).toBe(1);
    expect(of("https://github.com/acme/widget/issues/3").rejected.blocked).toBe(1);
    // A different repository whose name merely starts the same way.
    expect(of("https://github.com/acme/widget-next").kept).toHaveLength(1);
    // The pattern appearing in someone else's query string is not a match.
    expect(of("https://example.com/go?to=github.com/acme/widget").kept).toHaveLength(1);
  });

  test("a thread that reached the front page is reassessed", () => {
    // A thread can be worth acting on hours after it was worth ignoring.
    const result = gate([candidate({ metrics: { points: 150, comments: 60 } })], {
      ...POLICY,
      known: known({ metrics: { points: 5, comments: 0 } }),
    });
    expect(result.kept).toHaveLength(1);
  });

  test("trivial engagement drift is not a new moment", () => {
    const result = gate([candidate({ metrics: { points: 12, comments: 4 } })], {
      ...POLICY,
      known: known({ metrics: { points: 11, comments: 4 } }),
    });
    expect(result.rejected.unchanged).toBe(1);
  });

  test("an edited title or a filled-in body is a new moment", () => {
    expect(
      gate([candidate({ title: "Now asking specifically about filtering by field" })], {
        ...POLICY,
        known: known(),
      }).kept,
    ).toHaveLength(1);
  });

  test("an undecided finding is revisited once the reassessment interval passes", () => {
    const result = gate([candidate()], {
      ...POLICY,
      known: known({ lastAssessedAt: daysAgo(8) }),
      reassessAfterDays: 7,
    });
    expect(result.kept).toHaveLength(1);
  });

  test("a categorical rejection outlasts the ordinary interval", () => {
    const result = gate([candidate()], {
      ...POLICY,
      known: known({ disqualified: true, lastAssessedAt: daysAgo(8) }),
    });
    expect(result.kept).toHaveLength(0);
    expect(result.rejected["ruled-out"]).toBe(1);
  });

  test("but it expires — a list can reopen submissions without looking any different", () => {
    const result = gate([candidate()], {
      ...POLICY,
      known: known({ disqualified: true, lastAssessedAt: daysAgo(31) }),
    });
    expect(result.kept).toHaveLength(1);
  });

  test("a disqualified thread that materially changed is looked at again", () => {
    const result = gate([candidate({ metrics: { points: 150, comments: 60 } })], {
      ...POLICY,
      known: known({ disqualified: true, metrics: { points: 3, comments: 0 } }),
    });
    expect(result.kept).toHaveLength(1);
  });

  test("the operator's decision outranks the facts that are also true of it", () => {
    // Reported as settled, not stale: the count is a diagnostic, and "you
    // dismissed this" is the reason that matters.
    const result = gate([candidate({ publishedAt: daysAgo(900) })], {
      ...POLICY,
      known: known({ status: "dismissed" }),
    });
    expect(result.rejected.settled).toBe(1);
    expect(result.rejected.stale).toBe(0);
  });

  test("a shortlisted finding still gets refreshed — it is the one the operator cares about", () => {
    const result = gate([candidate({ metrics: { points: 200 } })], {
      ...POLICY,
      known: known({ status: "shortlisted", metrics: { points: 2 } }),
    });
    expect(result.kept).toHaveLength(1);
  });
});

/**
 * Registry order is precedence: specialized adapters run before Brave so their
 * thread text wins. That only means something if a higher-precedence snapshot
 * claims the URL even when the history checks reject it — otherwise a worse
 * representation of the same unchanged thread manufactures material change out
 * of its own search description, and storing the result replaces the better
 * snapshot with it.
 */
describe("registry precedence across sources", () => {
  const url = "https://example.com/thread";
  const hn = candidate({ sourceId: "hn" });
  const brave = candidate({
    sourceId: "brave",
    excerpt: "A search engine's one-line description of the very same thread.",
  });

  test("a worse source does not reassess a thread the better one found unchanged", () => {
    const result = gate([hn, brave], { ...POLICY, known: known() });
    expect(result.kept).toHaveLength(0);
    expect(result.rejected.unchanged).toBe(1);
    expect(result.rejected.duplicate).toBe(1);
  });

  test("nor does it when the better source's snapshot was ruled out", () => {
    const result = gate([hn, brave], {
      ...POLICY,
      known: known({ disqualified: true, lastAssessedAt: daysAgo(1) }),
    });
    expect(result.kept).toHaveLength(0);
    expect(result.rejected["ruled-out"]).toBe(1);
    expect(result.rejected.duplicate).toBe(1);
  });

  // The rules above the claim reject a candidate for what it is, not for how it
  // compares to history, so a better-described duplicate still gets its turn.
  test("but a second source may still rescue a URL the first described too thinly", () => {
    const thin = candidate({ sourceId: "hn", title: "Logs", excerpt: "?" });
    const result = gate([thin, brave], { ...POLICY, known: NONE });
    expect(result.rejected.thin).toBe(1);
    expect(result.kept.map((c) => c.sourceId)).toEqual(["brave"]);
  });

  test("the better source is the one kept when both are new", () => {
    const result = gate([hn, brave], { ...POLICY, known: NONE });
    expect(result.kept.map((c) => c.sourceId)).toEqual(["hn"]);
    expect(result.rejected.duplicate).toBe(1);
    expect(result.kept[0]!.url).toBe(url);
  });

  // Age is a fact about the thread, not about how well a source describes it.
  // Brave routinely omits a date; Hacker News never does.
  test("an undated duplicate cannot overturn a date the better source supplied", () => {
    const old = candidate({ sourceId: "hn", publishedAt: daysAgo(400) });
    const undated = candidate({ sourceId: "brave", publishedAt: undefined });
    const result = gate([old, undated], { ...POLICY, known: NONE });
    expect(result.kept).toHaveLength(0);
    expect(result.rejected.stale).toBe(1);
    expect(result.rejected.duplicate).toBe(1);
  });

  // The mirror of the case above: an undated candidate seen first does not make
  // the URL stale for a later one, because nothing established that it is old.
  test("an undated candidate on its own is still assessed", () => {
    const undated = candidate({ sourceId: "brave", publishedAt: undefined });
    expect(gate([undated], { ...POLICY, known: NONE }).kept).toHaveLength(1);
  });
});
