import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assembleIssue,
  fetchContext,
  githubFailure,
  githubTarget,
  hackerNewsContext,
  hackerNewsId,
  pageContext,
  stripHtml,
} from "../pipeline/draft-context";

describe("githubTarget", () => {
  test("reads issues and pull requests as the same resource", () => {
    expect(githubTarget("https://github.com/o/n/issues/12")).toEqual({
      kind: "issue",
      repo: "o/n",
      number: "12",
    });
    expect(githubTarget("https://github.com/o/n/pull/12")).toEqual({
      kind: "issue",
      repo: "o/n",
      number: "12",
    });
  });

  test("a bare repository is its README, however the URL spells it", () => {
    for (const url of [
      "https://github.com/o/n",
      "https://github.com/o/n/",
      "https://github.com/o/n.git",
      "https://github.com/o/n?tab=readme",
    ]) {
      expect(githubTarget(url)).toEqual({ kind: "repo", repo: "o/n" });
    }
  });

  /**
   * The page fetch is the fallback for anything whose endpoint would have to be
   * guessed. Guessing wrong fetches a different resource and presents it as the
   * thread, which is worse than the stripped page it replaced.
   */
  test("leaves every other shape to the page fetch", () => {
    for (const url of [
      "https://github.com/o/n/discussions/3",
      "https://github.com/o/n/blob/main/README.md",
      "https://github.com/o/n/issues", // the list, not an issue
      "https://github.com/o/n/issues/not-a-number",
      "https://github.com/o/n/pull/12/files", // the diff, not the conversation
      "https://github.com/o/n/pull/12/commits",
      "https://github.com/o",
      "https://github.com/topics/rust", // GitHub's own page, not owner/name
      "https://github.com/collections/machine-learning",
      "https://gist.github.com/o/n",
      "https://example.com/o/n/issues/12",
      "not a url",
    ]) {
      expect(githubTarget(url)).toBeNull();
    }
  });
});

describe("assembleIssue", () => {
  const comment = (login: string, body: string) => ({ user: { login }, body });

  test("keeps the issue when its comments could not be read", () => {
    const { context, warning } = assembleIssue(
      { title: "T", body: "the body", comments: 3, user: { login: "a" } },
      [],
      "GitHub rate limit reached",
    );
    expect(context?.text).toBe("# T\n\na: the body");
    expect(warning).toBe("the comments were not read (GitHub rate limit reached)");
  });

  test("an unread comment list does not make a bodyless issue empty", () => {
    const { warning } = assembleIssue({ title: "T", body: "", comments: 3 }, [], "timed out");
    expect(warning).toBe("the comments were not read (timed out)");
  });

  test("puts the title, the author and the replies in one text", () => {
    const result = assembleIssue(
      {
        title: "Which reviewer?",
        state: "open",
        body: "What do people use?",
        user: { login: "a" },
      },
      [comment("b", "I use X."), comment("c", "X is slow.")],
    );
    expect(result.context?.via).toBe("github-api");
    expect(result.context?.text).toBe(
      "# Which reviewer? (open)\n\na: What do people use?\n\nb: I use X.\n\nc: X is slow.",
    );
    expect(result.warning).toBeUndefined();
  });

  /**
   * The budget split is the decision worth pinning: a specification-length issue
   * body must not crowd out the replies, because what people said back is
   * usually what a draft has to answer.
   */
  test("caps the body at half the budget so comments still fit", () => {
    const result = assembleIssue({ title: "t", body: "b".repeat(9000), user: { login: "a" } }, [
      comment("b", "the reply"),
    ]);
    expect(result.context?.text).toContain("b: the reply");
    expect(result.warning).toBe("the issue body was cut short");
  });

  test("a body with no comments may use the whole budget", () => {
    const result = assembleIssue({ title: "t", body: "b".repeat(5000), user: { login: "a" } }, []);
    expect(result.warning).toBeUndefined();
    expect(result.context?.text).toContain("b".repeat(5000));
  });

  /** Silently dropping replies is what makes a partial read read as a whole one. */
  test("says how many comments it could not fit", () => {
    const long = Array.from({ length: 20 }, (_, i) => comment(`u${i}`, "x".repeat(1000)));
    const result = assembleIssue({ title: "t", body: "", comments: 20 }, long);
    expect(result.warning).toMatch(/of 20 comments were not read/);
  });

  /** GitHub's own count, against what one page returned. */
  test("says when the thread runs past the page it fetched", () => {
    const result = assembleIssue({ title: "t", body: "b", comments: 250, user: { login: "a" } }, [
      comment("b", "one"),
    ]);
    expect(result.warning).toBe("only the first 1 of 250 comments were fetched");
  });

  /**
   * `/issues/{n}/comments` is the conversation tab only. A pull request's
   * substance is usually in its reviews, which live at other endpoints, so a
   * short one would otherwise read as fully retrieved.
   */
  test("says that a pull request's reviews were not read", () => {
    const result = assembleIssue(
      { title: "t", body: "b", user: { login: "a" }, pull_request: {} },
      [comment("b", "looks good")],
    );
    expect(result.warning).toBe("pull request reviews and inline comments were not read");
  });

  /** The heading and byline are spent before the body is sliced against the cap. */
  test("keeps the whole text inside the budget", () => {
    const result = assembleIssue({ title: "t", body: "x".repeat(9000), user: { login: "a" } }, []);
    expect(result.context!.text.length).toBeLessThanOrEqual(8000);
  });

  test("an issue with nothing in it is no context, not empty context", () => {
    const result = assembleIssue({ title: "", body: "" }, []);
    expect(result.context).toBeNull();
    expect(result.warning).toBe("the issue has no text");
  });

  /**
   * `dropped` also carries what was never fetched, so its being non-empty says
   * nothing about the budget: this issue has no text to fit in one.
   */
  test("does not blame the budget for an issue that held nothing", () => {
    const result = assembleIssue({ title: "t", body: null, comments: 0, pull_request: {} }, []);
    expect(result.context).toBeNull();
    expect(result.warning).toBe(
      "the issue has no text; pull request reviews and inline comments were not read",
    );
  });

  /** A thread that would not fit is not an empty thread, and must not report as one. */
  test("distinguishes nothing there from nothing that fit", () => {
    const result = assembleIssue({ title: "t", body: "", comments: 1 }, [
      comment("b", "x".repeat(9000)),
    ]);
    expect(result.context).toBeNull();
    expect(result.warning).toBe("nothing fit in the context budget: 1 of 1 comments were not read");
  });
});

/** Decoding itself is `decodeEntities`, tested in test/html.test.ts. */
describe("stripHtml", () => {
  /** Hacker News writes apostrophes as `&#x27;`, and Algolia returns them raw. */
  test("decodes references in the thread text", () => {
    expect(stripHtml("<p>everyday&#x27;s job &#8212; and &amp; too</p>")).toBe(
      "everyday's job — and & too",
    );
  });

  /**
   * The one whitespace this collapses that `\s` would have caught for free in a
   * one-line excerpt: `&nbsp;` decodes to the character it names, so the caller
   * keeping paragraphs has to name it too.
   */
  test("collapses a decoded non-breaking space", () => {
    expect(stripHtml("<p>one&nbsp;two &#160; three</p>")).toBe("one two three");
  });

  /** Block structure is what separates this from a one-line excerpt. */
  test("keeps paragraphs and drops the rest", () => {
    expect(stripHtml("<h1>Title</h1><p>one</p><p>two</p><script>ignored()</script>")).toBe(
      "Title\n one\n two",
    );
  });
});

describe("pageContext", () => {
  test("says the page carries site furniture, and nothing more when it fit", () => {
    const result = pageContext(`<p>${"word ".repeat(100)}</p>`);
    expect(result.context?.via).toBe("page");
    expect(result.warning).toBe(
      "read as stripped HTML, which does not separate the site's navigation and other furniture from the page's own content",
    );
  });

  test("says when the page was cut short", () => {
    const result = pageContext(`<p>${"word ".repeat(3000)}</p>`);
    expect(result.context!.text.length).toBeLessThanOrEqual(8000);
    expect(result.warning).toMatch(/; truncated; the rest of the page was not read$/);
  });

  test("too little text is no context", () => {
    expect(pageContext("<p>hi</p>")).toEqual({
      context: null,
      warning: "page had too little extractable text",
    });
  });
});

/**
 * The 403 is shared by "you are going too fast" and "you may not see this", and
 * the remedies are opposite. Each branch is pinned because the difference is
 * carried entirely by headers that are often absent.
 */
describe("githubFailure", () => {
  const reply = (status: number, headers: Record<string, string> = {}) =>
    githubFailure("repos/o/n/issues/1", new Response(null, { status, headers }));

  test("passes a good response", () => {
    expect(reply(200)).toBeNull();
  });

  test("a secondary limit says how long to wait", () => {
    expect(reply(403, { "retry-after": "60" })).toBe(
      "GitHub is throttling requests — retry in 60s",
    );
  });

  test("an exhausted quota is a wait, not a permission problem", () => {
    expect(reply(403, { "x-ratelimit-remaining": "0" })).toMatch(/rate limit reached/);
    expect(reply(429)).toMatch(/rate limit reached/);
  });

  /** `Number(null)` is 0, so an absent header must not read as an empty quota. */
  test("a bare 403 is not an exhausted quota, and does not pick between its two causes", () => {
    expect(reply(403)).toBe(
      "GitHub refused repos/o/n/issues/1 (403) — retry in a minute in case this is a secondary rate limit; if it persists, check GitHub authentication and access",
    );
    expect(reply(403, { "x-ratelimit-remaining": "37" })).toMatch(/secondary rate limit/);
  });

  test("names the remedy for a rejected token", () => {
    expect(reply(401)).toMatch(/gh auth login/);
  });

  test("404 may be private; 410 is only gone", () => {
    expect(reply(404)).toBe("repos/o/n/issues/1 is gone or private");
    expect(reply(410)).toBe("repos/o/n/issues/1 is gone");
  });
});

describe("hackerNewsId", () => {
  test("reads the id out of a thread URL", () => {
    expect(hackerNewsId("https://news.ycombinator.com/item?id=12345")).toBe("12345");
    expect(hackerNewsId("https://news.ycombinator.com/item?id=12345&p=2")).toBe("12345");
  });

  /** A substring match would have taken all three for Hacker News threads. */
  test("is not fooled by a host or a parameter that merely contains it", () => {
    expect(hackerNewsId("https://fakenews.ycombinator.com/item?id=1")).toBeNull();
    expect(hackerNewsId("https://example.com/r?url=news.ycombinator.com/item?id=1")).toBeNull();
    expect(hackerNewsId("https://news.ycombinator.com/user?id=pg")).toBeNull();
  });

  test("anything that is not one is not one", () => {
    expect(hackerNewsId("not a url")).toBeNull();
    expect(hackerNewsId("https://news.ycombinator.com/item")).toBeNull();
  });
});

describe("hackerNewsContext", () => {
  const comment = (text: string | null, children: { text: string }[] = []) => ({
    title: null,
    text,
    author: "a",
    type: "comment",
    children: children.map((c) => ({ ...c, title: null, author: "b" })),
  });

  test("a comment id says what it was replying to was not read", () => {
    const { context, warning } = hackerNewsContext(comment("<p>target</p>", [{ text: "reply" }]));
    expect(context?.text).toBe("a: target\n\n  b: reply");
    expect(warning).toContain("what it was replying to was not read");
  });

  test("an unreadable target is no context, even with replies under it", () => {
    expect(hackerNewsContext(comment(null, [{ text: "reply" }]))).toEqual({
      context: null,
      warning: "the target comment is no longer readable",
    });
  });

  test("an unreadable reply keeps its place, so its replies stay under it", () => {
    const item = {
      ...comment("target", [{ text: "A" }]),
      children: [
        { title: null, text: "A", author: "b" },
        {
          title: null,
          text: null,
          author: null,
          children: [{ title: null, text: "C", author: "c" }],
        },
      ],
    };
    const { context, warning } = hackerNewsContext(item);
    expect(context?.text).toBe("a: target\n\n  b: A\n\n  [comment unavailable]\n\n    c: C");
    expect(warning).toContain("1 comment was unavailable");
  });

  test("a link story says the article itself was not read", () => {
    const story = {
      title: "T",
      text: null,
      author: "a",
      type: "story",
      url: "https://example.com",
    };
    expect(hackerNewsContext(story).warning).toBe("the linked article was not read");
  });

  test("a cut inside the target is not described as missing replies", () => {
    const { warning } = hackerNewsContext(comment("x".repeat(9000)));
    expect(warning).toContain("the rest of the thread was not read");
  });
});

/**
 * Refused only on a fact the fetch established. What it cannot establish still
 * drafts, with a warning: from the excerpt when there is no thread to read,
 * beside the thread when only a check failed.
 */
describe("fetchContext refusal", () => {
  const real = globalThis.fetch;
  const token = process.env.GITHUB_TOKEN;
  beforeEach(() => {
    // Keeps the header lookup off the gh CLI.
    process.env.GITHUB_TOKEN = "test";
  });
  afterEach(() => {
    globalThis.fetch = real;
    if (token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = token;
  });

  /** Answers each request by the first route whose key its URL contains. */
  const serve = (routes: Record<string, () => Response>) => {
    globalThis.fetch = (async (input: URL | string) => {
      const url = String(input);
      const route = Object.keys(routes).find((key) => url.includes(key));
      if (!route) throw new Error(`unexpected request ${url}`);
      return routes[route]!();
    }) as typeof fetch;
  };

  test("a locked GitHub issue is refused; a closed but unlocked one is not", async () => {
    serve({
      "/issues/1": () => Response.json({ title: "t", body: "b", locked: true, comments: 0 }),
    });
    expect(await fetchContext("https://github.com/o/r/issues/1")).toEqual({
      refused: "o/r#1 is locked to collaborators",
    });

    serve({
      "/issues/2": () =>
        Response.json({ title: "t", body: "b", state: "closed", locked: false, comments: 0 }),
    });
    expect(await fetchContext("https://github.com/o/r/issues/2")).toMatchObject({
      context: { via: "github-api" },
    });
  });

  test("410 is deleted; 404 is unreadable now; a README 404 asks the repository", async () => {
    serve({ "/issues/3": () => new Response("", { status: 410 }) });
    expect(await fetchContext("https://github.com/o/r/issues/3")).toEqual({
      refused: "o/r#3 was deleted",
    });

    serve({ "/issues/4": () => new Response("", { status: 404 }) });
    expect(await fetchContext("https://github.com/o/r/issues/4")).toEqual({
      refused: expect.stringContaining("GitHub returns 404 for o/r#4"),
    });

    // A curated list without a README is still a list to submit to.
    serve({
      "/readme": () => new Response("", { status: 404 }),
      "/repos/o/r": () => Response.json({ full_name: "o/r" }),
    });
    expect(await fetchContext("https://github.com/o/r")).toEqual({
      context: null,
      warning: "o/r has no README",
    });

    // The same README 404 from a repository Obserf can no longer read.
    serve({
      "/readme": () => new Response("", { status: 404 }),
      "/repos/o/r": () => new Response("", { status: 404 }),
    });
    expect(await fetchContext("https://github.com/o/r")).toEqual({
      refused: expect.stringContaining("GitHub returns 404 for o/r:"),
    });

    // A check that fails proves nothing either way.
    serve({
      "/readme": () => new Response("", { status: 404 }),
      "/repos/o/r": () => new Response("", { status: 502 }),
    });
    expect(await fetchContext("https://github.com/o/r")).toMatchObject({
      context: null,
      warning: expect.stringContaining("has no README, or could not be read"),
    });
  });

  test("a dead Hacker News item is refused, and a failed check is a warning", async () => {
    const thread = () => Response.json({ title: "t", text: "hello", author: "a", children: [] });
    serve({ "firebaseio.com": () => Response.json({ id: 5, dead: true }), "algolia.com": thread });
    expect(await fetchContext("https://news.ycombinator.com/item?id=5")).toEqual({
      refused: "the Hacker News item is dead",
    });

    // The thread fetch failing does not discard what the other request established.
    serve({
      "firebaseio.com": () => Response.json({ id: 5, deleted: true }),
      "algolia.com": () => {
        throw new Error("timed out");
      },
    });
    expect(await fetchContext("https://news.ycombinator.com/item?id=5")).toEqual({
      refused: "the Hacker News item was deleted",
    });

    // Drafted, since a failed check proves nothing, but not presented as checked.
    serve({ "firebaseio.com": () => new Response("", { status: 500 }), "algolia.com": thread });
    expect(await fetchContext("https://news.ycombinator.com/item?id=5")).toMatchObject({
      context: { via: "hn-algolia" },
      warning: expect.stringContaining("could not check"),
    });
  });

  test("a live comment is refused under a dead story, and only a dead one", async () => {
    const comment = (story: object) => ({
      "item/6.json": () => Response.json({ id: 6, type: "comment" }),
      "item/9.json": () => Response.json({ id: 9, ...story }),
      "algolia.com": () =>
        Response.json({ type: "comment", story_id: 9, text: "hi", author: "a", children: [] }),
    });
    serve(comment({ dead: true }));
    expect(await fetchContext("https://news.ycombinator.com/item?id=6")).toEqual({
      refused: "the Hacker News story it belongs to is dead",
    });

    // Drafted, and as checked: the story answered, it just was not dead.
    serve(comment({ deleted: true }));
    const underDeleted = await fetchContext("https://news.ycombinator.com/item?id=6");
    expect(underDeleted).toMatchObject({ context: { via: "hn-algolia" } });
    expect((underDeleted as { warning?: string }).warning).not.toContain("could not check");
  });

  test("an answer that is not about the item, or a story never named, is unchecked", async () => {
    serve({
      "item/7.json": () => Response.json({}),
      "algolia.com": () => Response.json({ title: "t", text: "hi", author: "a", children: [] }),
    });
    expect(await fetchContext("https://news.ycombinator.com/item?id=7")).toMatchObject({
      warning: expect.stringContaining("could not check"),
    });

    serve({
      "item/8.json": () => Response.json({ id: 8, type: "comment" }),
      "algolia.com": () =>
        Response.json({ type: "comment", text: "hi", author: "a", children: [] }),
    });
    expect(await fetchContext("https://news.ycombinator.com/item?id=8")).toMatchObject({
      warning: expect.stringContaining("could not check"),
    });
  });
});
