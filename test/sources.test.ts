import { describe, expect, test } from "bun:test";
import { selectSources, sources } from "../sources";
import { hackerNewsSource, toCandidate } from "../sources/hackernews";
import type { ProjectProfile } from "../project";

describe("selectSources", () => {
  test("no ids runs every registered source", () => {
    expect(selectSources()).toEqual(sources);
  });

  // The distinction the whole field rests on: absent means "every source", so an
  // empty allowlist must not quietly mean the same thing and enable a metered one.
  test("an empty list is an error, not every source", () => {
    expect(() => selectSources([])).toThrow(/No sources selected/);
  });

  test("ids select those adapters, in registry order", () => {
    expect(selectSources(["github", "hn"]).map((s) => s.id)).toEqual(["hn", "github"]);
    expect(selectSources(["hn", "github"]).map((s) => s.id)).toEqual(["hn", "github"]);
  });

  // Prefer specialized adapters before falling back to web search descriptions.
  test("Brave yields precedence to every specialised adapter", () => {
    expect(sources.at(-1)!.id).toBe("brave");
  });

  test("an unknown id fails and names what is available", () => {
    expect(() => selectSources(["redit"])).toThrow(/Unknown source "redit".*reddit/);
  });
});

/**
 * "No results" and "this source was never asked anything" are the same empty
 * array, and a profile's silence must not be reported as a searched and quiet
 * web. Credentials were always the reason a source could not run; the queries it
 * was given are the other half. See ADR-007.
 */
const profileWith = (queries: Partial<ProjectProfile["queries"]>): ProjectProfile => ({
  key: "k",
  name: "N",
  url: "https://e.com",
  pitch: "p",
  solves: ["s"],
  notFor: ["n"],
  voice: "v",
  queries: { search: [], subreddits: [], github: [], ...queries },
});

describe("unavailable", () => {
  const profile = profileWith;

  const reasonFor = (id: string, queries: Partial<ProjectProfile["queries"]>) =>
    sources.find((source) => source.id === id)!.unavailable(profile(queries));

  test("every source refuses a profile that configures nothing", () => {
    const empty = profile({});
    for (const source of sources) expect(source.unavailable(empty)).toBeTruthy();
  });

  test("Hacker News wants queries.search", () => {
    expect(reasonFor("hn", {})).toMatch(/queries\.search/);
    expect(reasonFor("hn", { search: ["a"] })).toBeNull();
  });

  /**
   * Subreddits before credentials: registering a Reddit app does not give a
   * profile the communities it never named.
   */
  test("Reddit names the missing subreddits before the missing keys", () => {
    expect(reasonFor("reddit", { search: ["a"] })).toMatch(/queries\.subreddits/);
  });

  /** Most profiles search issues and never look for curated lists, or the reverse. */
  test("GitHub runs on either of its two endpoints", () => {
    expect(reasonFor("github", { github: ["a"] })).toBeNull();
    expect(reasonFor("github", { githubRepos: ["a"] })).toBeNull();
    expect(reasonFor("github", {})).toMatch(/queries\.github/);
  });

  /**
   * `brave: []` is an instruction to ask nothing, and `??` does not fall back
   * from it — so a populated `search` must not rescue the source here, because
   * it does not rescue it in `search()` either.
   */
  test("Brave follows the same fallback its search does", () => {
    // `?? ""` rather than `toBeNull`: whether BRAVE_API_KEY happens to be set
    // wherever the tests run is not what this is about. The queries are no
    // longer the reason, and that is env-independent.
    expect(reasonFor("brave", { search: ["a"], brave: ["b"] }) ?? "").not.toMatch(/queries/);
    expect(reasonFor("brave", { search: ["a"] }) ?? "").not.toMatch(/queries/);
    // Not "no queries.search": there is one, and it is not what Brave would ask.
    const reason = reasonFor("brave", { search: ["a"], brave: [] }) ?? "";
    expect(reason).toMatch(/queries\.brave/);
    // It may name `queries.search` — to say it does not top the list up — but
    // must not report it as the field to go and fill in.
    expect(reason).not.toMatch(/no queries\.search|queries\.search has nothing/);
  });

  test("Reddit wants queries.search too, once it has its subreddits", () => {
    expect(reasonFor("reddit", { subreddits: ["golang"] })).toMatch(/queries\.search/);
  });

  /** A length check passes whitespace; HN would then turn it into an unbounded search. */
  test("a query that is only whitespace is not a query", () => {
    expect(reasonFor("hn", { search: ["  "] })).toMatch(/queries\.search/);
    expect(reasonFor("github", { github: [""] })).toMatch(/queries\.github/);
  });
});

/** `_tags` is authoritative; `comment_text` cannot classify stories because they omit it. */
describe("the Hacker News adapter's story-or-comment call", () => {
  const hit = (over: Record<string, unknown> = {}) => ({
    objectID: "1",
    author: "a",
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  });

  test("a story is a story, even with body text and no comment_text key", () => {
    expect(
      toCandidate(hit({ _tags: ["story"], title: "T", story_text: "body" })).isThreadComment,
    ).toBe(false);
  });

  test("a comment is a comment, and wears the enclosing story's title", () => {
    const candidate = toCandidate(
      hit({ _tags: ["comment"], story_title: "The thread", comment_text: "what I think" }),
    );
    expect(candidate.isThreadComment).toBe(true);
    expect(candidate.title).toBe("The thread");
    expect(candidate.excerpt).toBe("what I think");
  });

  test("leaves the shape unknown when the response does not classify the hit", () => {
    expect(toCandidate(hit({ title: "T" })).isThreadComment).toBeUndefined();
    expect(toCandidate(hit({ _tags: ["author_x"], title: "T" })).isThreadComment).toBeUndefined();
  });

  test("always links to the HN item, never the submitted URL", () => {
    expect(toCandidate(hit({ _tags: ["story"], url: "https://elsewhere.example/post" })).url).toBe(
      "https://news.ycombinator.com/item?id=1",
    );
  });
});

/**
 * A comment under a killed submission can have enough text to pass the thin
 * gate. Filter the enclosing story's marker while retaining live comment hits.
 */
test("drops stories and comments whose story title is exactly [dead]", async () => {
  const real = globalThis.fetch;
  const hit = (objectID: string, over: Record<string, unknown>) => ({
    objectID,
    author: "a",
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  });
  globalThis.fetch = (async (_input: URL) =>
    new Response(
      JSON.stringify({
        hits: [
          hit("1", {
            _tags: ["comment"],
            story_title: "[dead]",
            comment_text: "This reply has enough substance to survive the thin gate unchanged.",
          }),
          hit("2", { _tags: ["story"], title: "[dead]" }),
          hit("3", { _tags: ["story"], title: "A live story" }),
          hit("4", {
            _tags: ["comment"],
            story_title: "A live thread",
            comment_text: "Still here",
          }),
        ],
      }),
      { headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    const found = await hackerNewsSource.search(profileWith({ search: ["q"] }), { limit: 10 });
    expect(found.map((c) => c.title)).toEqual(["A live story", "A live thread"]);
  } finally {
    globalThis.fetch = real;
  }
});

/**
 * Regression: a blank entry beside a real one passed availability and was still
 * sent. Hacker News is the dangerous case, because Algolia reads an empty query
 * as every story it has rather than rejecting it.
 */
test("sends the queries a profile actually wrote, and only those", async () => {
  const requested: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: URL) => {
    requested.push(new URL(input).searchParams.get("query") ?? "");
    return new Response(JSON.stringify({ hits: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await hackerNewsSource.search(profileWith({ search: ["   ", " real query "] }), { limit: 10 });
  } finally {
    globalThis.fetch = real;
  }

  expect(requested).toEqual(["real query"]);
});
