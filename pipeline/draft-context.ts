/**
 * Fetches current source context at draft time over plain HTTP, without a browser.
 * Assessment uses discovery text and optional enrichment, which may omit the
 * conversation needed for a specific reply. Fetching the page only when the
 * operator chooses to draft keeps requests proportional to actual use and
 * surfaces retrieval failures before they act. See docs/architecture.md.
 *
 * Venues with an API are read through it and the rest as stripped HTML, chosen
 * by URL rather than `finding.sourceId`: a GitHub issue Brave found is still a
 * GitHub issue.
 */

import { config } from "../config";
import { decodeEntities, truncate } from "../html";
import { githubHeaders } from "../sources/github";
import type { Finding } from "../db/schema";

/** Upper bound on fresh source context. */
const MAX_CHARS = 8000;
const TIMEOUT_MS = 15_000;

export interface FreshContext {
  text: string;
  /** How it was retrieved, for the operator to judge how much to trust it. */
  via: "hn-api" | "github-api" | "page";
}

/**
 * `warning` says what limits the context, or why there is none — required then,
 * since a draft from the stored excerpt must say why.
 */
export type ContextResult =
  | { context: FreshContext; warning?: string }
  | { context: null; warning: string };

export async function fetchContext(finding: Finding): Promise<ContextResult> {
  try {
    const hnId = hackerNewsId(finding.url);
    if (hnId) return await fetchHackerNews(hnId);

    const target = githubTarget(finding.url);
    if (target) return await fetchGithub(target);

    return await fetchPage(finding.url);
  } catch (error) {
    return { context: null, warning: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The item id in a Hacker News thread URL, when the URL is one.
 *
 * Parsed rather than matched, for the same reason `githubTarget` is: a substring
 * search for the host finds it inside `fakenews.ycombinator.com` and inside
 * anybody's `?url=` parameter, and either one would send another site's page to
 * Algolia and get back a thread the finding is not about.
 */
export function hackerNewsId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Exact: `url.ts` has already lowercased the host and dropped any `www.`.
  if (parsed.hostname !== "news.ycombinator.com" || parsed.pathname !== "/item") return null;

  const id = parsed.searchParams.get("id");
  return id && /^\d+$/.test(id) ? id : null;
}

interface AlgoliaItem {
  title: string | null;
  text: string | null;
  author: string | null;
  /** The linked article, on a link story. */
  url?: string | null;
  /** The item's kind; `"comment"` is the only one read differently here. */
  type?: string;
  children?: AlgoliaItem[];
}

/**
 * Hacker News through Algolia's item endpoint: the full thread as structured
 * data, which beats scraping the same page as HTML.
 */
async function fetchHackerNews(id: string): Promise<ContextResult> {
  const response = await fetch(`https://hn.algolia.com/api/v1/items/${id}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    return { context: null, warning: `Hacker News item ${id} returned ${response.status}` };
  }

  return hackerNewsContext((await response.json()) as AlgoliaItem);
}

/** An Algolia item as context, separate from the request so it can be tested. */
export function hackerNewsContext(item: AlgoliaItem): ContextResult {
  // No text, but still answering for the replies under it. Those replies are
  // not what a reply to this comment would be answering.
  if (item.type === "comment" && !stripHtml(item.text ?? "")) {
    return { context: null, warning: "the target comment is no longer readable" };
  }

  const lines: string[] = [];
  // Below the target, an unreadable comment keeps a placeholder: its replies
  // stay indented under it, and without one they read as answering whatever
  // came before.
  let unavailable = 0;

  const walk = (node: AlgoliaItem, depth: number) => {
    // Algolia returns comment bodies as HTML, entities and all.
    const body = stripHtml(node.text ?? "");
    const indent = "  ".repeat(depth);
    if (node.title) lines.push(`# ${node.title}`);
    if (body) lines.push(`${indent}${node.author ?? "?"}: ${body}`);
    else if (depth > 0) {
      lines.push(`${indent}[comment unavailable]`);
      unavailable++;
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(item, 0);

  const whole = lines.join("\n\n");
  if (!whole) return { context: null, warning: "empty thread" };
  const text = truncate(whole, MAX_CHARS);

  const missing = [
    // The endpoint answers for a comment id with that comment and what hangs
    // below it. Everything above — the story's own text and the remark this one
    // was answering — is a separate fetch, and a reply written without it can
    // answer a point nobody made here.
    item.type === "comment"
      ? "this is the target comment and the replies under it; what it was replying to was not read"
      : "",
    // A link story's discussion is about a page this route never fetches.
    item.type === "story" && item.url ? "the linked article was not read" : "",
    unavailable ? `${unavailable} comment${unavailable === 1 ? " was" : "s were"} unavailable` : "",
    // Not "later replies": the cut can land inside the story or the target itself.
    text.length < whole.length ? "truncated; the rest of the thread was not read" : "",
  ].filter(Boolean);

  return {
    context: { text, via: "hn-api" },
    warning: missing.join("; ") || undefined,
  };
}

/** What a github.com URL points at, when it points at something readable. */
type GitHubTarget =
  | { kind: "issue"; repo: string; number: string }
  | { kind: "repo"; repo: string };

/**
 * First path segments that are GitHub's own pages rather than an owner — GitHub
 * reserves them as account names, so `/topics/rust` is never a repository. Only
 * the ones a web search plausibly returns; one missing here costs a failed
 * README lookup, not a wrong thread.
 */
const SITE_ROUTES = new Set([
  "about",
  "apps",
  "collections",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "marketplace",
  "orgs",
  "pricing",
  "search",
  "sponsors",
  "topics",
  "trending",
]);

/**
 * `github.com/owner/name/issues/12` and `.../pull/12` are the same resource to
 * the REST API, and a bare `github.com/owner/name` is the repository whose
 * README is what a `listing` submission is written against. Every other shape —
 * a file, a release, a discussion — falls through to the page fetch, because
 * guessing an endpoint for it would fetch the wrong thing rather than nothing.
 */
export function githubTarget(url: string): GitHubTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  const [owner, rawName, section, number] = parts;
  // A clone URL names the same repository, but the REST path does not take the suffix.
  const name = rawName?.replace(/\.git$/, "");
  if (!owner || !name || SITE_ROUTES.has(owner.toLowerCase())) return null;
  const repo = `${owner}/${name}`;

  if (parts.length === 2) return { kind: "repo", repo };
  // Exactly four segments: `/pull/12/files` is the diff, not the conversation,
  // and answering it with the conversation names a different page than the finding.
  const isThread = section === "issues" || section === "pull";
  if (parts.length === 4 && isThread && number && /^\d+$/.test(number)) {
    return { kind: "issue", repo, number };
  }
  return null;
}

interface GitHubIssue {
  title?: string;
  body?: string | null;
  state?: string;
  comments?: number;
  user?: { login?: string } | null;
  /**
   * Present when the issue is really a pull request. The payload is the
   * authority, not the URL: a pull request answers at `/issues/{n}` too, and
   * what it does *not* return there is the review discussion.
   */
  pull_request?: unknown;
}

interface GitHubComment {
  body?: string | null;
  user?: { login?: string } | null;
}

/**
 * GitHub's REST API rather than its HTML. Failures fall back to the stored
 * excerpt with a warning, as every other path here does — never to the page
 * fetch, which for these URLs is the bad context this exists to replace.
 */
async function fetchGithub(target: GitHubTarget): Promise<ContextResult> {
  if (target.kind === "repo") return fetchReadme(target.repo);

  const path = `repos/${target.repo}/issues/${target.number}`;
  const issue = await githubJson(path);
  if ("failure" in issue) return { context: null, warning: issue.failure };
  if (Array.isArray(issue.value)) return { context: null, warning: unexpectedGithubBody(path) };
  const found: GitHubIssue = issue.value;

  // The issue already says whether there are any, and a second request that
  // could only fail would throw away the issue it just read.
  if (found.comments === 0) return assembleIssue(found, []);

  // One page. A hundred comments is already more discussion than a draft can
  // use, and paging to the end of a long thread would spend requests on
  // material the budget below discards anyway.
  const commentsPath = `${path}/comments?per_page=100`;
  const comments = await githubJson(commentsPath);
  // The issue as it reads now still beats the stored excerpt; the warning says
  // what is missing from it.
  if ("failure" in comments) return assembleIssue(found, [], comments.failure);
  if (!Array.isArray(comments.value)) {
    return assembleIssue(found, [], unexpectedGithubBody(commentsPath));
  }

  return assembleIssue(found, comments.value);
}

/**
 * Title, body and comments within one budget, with the body capped at half of it
 * once there are comments: an issue whose body is a specification would
 * otherwise crowd out the replies, and what people said back is usually the part
 * a draft has to answer.
 */
export function assembleIssue(
  issue: GitHubIssue,
  comments: GitHubComment[],
  commentsFailure?: string,
): ContextResult {
  const header = `# ${issue.title || "(untitled)"}${issue.state ? ` (${issue.state})` : ""}`;
  const author = `${issue.user?.login ?? "?"}: `;
  const body = (issue.body ?? "").trim();

  const dropped: string[] = [];
  const sections = [header];
  let used = header.length;

  if (body) {
    // What is left of the budget: the heading and the byline are already spent.
    const budget =
      (comments.length ? Math.floor(MAX_CHARS / 2) : MAX_CHARS) - used - author.length - 2;
    const kept = truncate(body, Math.max(0, budget));
    if (kept) {
      sections.push(author + kept);
      used += author.length + kept.length + 2;
    }
    if (kept.length < body.length) dropped.push("the issue body was cut short");
  }

  let shown = 0;
  for (const comment of comments) {
    const text = (comment.body ?? "").trim();
    if (!text) continue;
    const section = `${comment.user?.login ?? "?"}: ${text}`;
    if (used + section.length + 2 > MAX_CHARS) break;
    sections.push(section);
    used += section.length + 2;
    shown++;
  }

  const withBody = comments.filter((c) => (c.body ?? "").trim()).length;
  if (shown < withBody) dropped.push(`${withBody - shown} of ${withBody} comments were not read`);

  // A count GitHub reports but did not return: a thread past one page.
  const total = issue.comments ?? comments.length;
  if (commentsFailure) {
    dropped.push(`the comments were not read (${commentsFailure})`);
  } else if (total > comments.length) {
    dropped.push(`only the first ${comments.length} of ${total} comments were fetched`);
  }

  // `/issues/{n}/comments` returns the conversation tab and nothing else. On a
  // pull request the substance is usually in the reviews and the inline threads,
  // which are separate endpoints — so a short, warning-free pull request would
  // otherwise read as fully retrieved while the actual feedback went unseen.
  if (issue.pull_request) dropped.push("pull request reviews and inline comments were not read");

  // The header alone is not context: the finding's title is already in the
  // prompt, so a result carrying nothing else adds a heading and no thread.
  if (sections.length > 1) {
    return {
      context: { text: sections.join("\n\n"), via: "github-api" },
      warning: dropped.join("; ") || undefined,
    };
  }
  // Nothing there, or nothing that fit (one comment longer than the budget).
  // Told apart by what the issue held, not by `dropped`, which also carries what
  // was never fetched. Comments that could not be read are unknown, not absent.
  const hadText = Boolean(body) || withBody > 0;
  if (hadText)
    return { context: null, warning: `nothing fit in the context budget: ${dropped.join("; ")}` };
  return {
    context: null,
    warning: (commentsFailure ? dropped : ["the issue has no text", ...dropped]).join("; "),
  };
}

/**
 * A repository's README. This is the whole context for a `listing`: a pull
 * request adding an entry to a curated list is written against how that list
 * already reads.
 */
async function fetchReadme(repo: string): Promise<ContextResult> {
  const path = `repos/${repo}/readme`;
  const response = await githubRequest(path, "application/vnd.github.raw+json");
  // GitHub answers a repository without a README the same as a missing one.
  if (response.status === 404) {
    return { context: null, warning: `${repo} has no README, or is gone or private` };
  }
  const failure = githubFailure(path, response);
  if (failure) return { context: null, warning: failure };

  const whole = (await response.text()).trim();
  if (!whole) return { context: null, warning: `${repo} has an empty README` };
  const text = truncate(whole, MAX_CHARS);
  return {
    context: { text, via: "github-api" },
    warning: [
      "README only; the repository's issues and pull requests were not read",
      text.length < whole.length ? "the README was cut short" : "",
    ]
      .filter(Boolean)
      .join("; "),
  };
}

/**
 * What went wrong with a GitHub response, as a sentence naming the remedy — or
 * null when nothing did. Separate from the request so the mapping can be tested
 * against a constructed `Response`, which is where its subtlety is: throttling
 * and permission failures share the 403.
 *
 * Checked in the order GitHub states the answer most directly: `Retry-After`,
 * a 429, then an exhausted primary quota. The remaining header is compared as a
 * string because `Number(null)` is 0, which would read every absent header as
 * an exhausted quota.
 */
export function githubFailure(
  path: string,
  response: Pick<Response, "status" | "ok" | "headers">,
): string | null {
  if (response.status === 401) {
    return "GitHub rejected the token — run `gh auth login` or reset GITHUB_TOKEN";
  }
  if (response.status === 403 || response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) return `GitHub is throttling requests — retry in ${retryAfter}s`;
    if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      return `GitHub rate limit reached${
        reset ? `, resets at ${new Date(reset * 1000).toTimeString().slice(0, 5)}` : ""
      }`;
    }
    // A secondary limit GitHub reports only in the body, or a token refused by
    // policy (SSO, an IP allow list). The wait is what tells them apart.
    return `GitHub refused ${path} (403) — retry in a minute in case this is a secondary rate limit; if it persists, check GitHub authentication and access`;
  }
  // GitHub answers a private resource the caller cannot see with 404, not 403.
  if (response.status === 404) return `${path} is gone or private`;
  // Deleted, and the caller could otherwise have read it.
  if (response.status === 410) return `${path} is gone`;
  if (!response.ok) return `GitHub returned ${response.status} for ${path}`;
  return null;
}

async function githubRequest(path: string, accept?: string): Promise<Response> {
  return fetch(`https://api.github.com/${path}`, {
    headers: await githubHeaders(accept),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * One GitHub JSON call, with every failure — status, timeout, non-JSON body —
 * turned into a sentence naming the lookup. Returned rather than thrown so the
 * caller can keep the issue when only its comments failed. The caller checks
 * the shape it expects: an array where an issue should be is a failed lookup,
 * not an empty thread.
 */
async function githubJson(path: string): Promise<{ value: object } | { failure: string }> {
  let value: unknown;
  try {
    const response = await githubRequest(path);
    const failure = githubFailure(path, response);
    if (failure) return { failure };
    value = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { failure: `GitHub request for ${path} failed: ${message}` };
  }
  return typeof value === "object" && value !== null
    ? { value }
    : { failure: unexpectedGithubBody(path) };
}

function unexpectedGithubBody(path: string): string {
  return `GitHub returned an unexpected body for ${path}`;
}

async function fetchPage(url: string): Promise<ContextResult> {
  const response = await fetch(url, {
    headers: { Accept: "text/html,*/*", "User-Agent": config.userAgent },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // A 404 or 403 at draft time is worth knowing: the opportunity may be gone,
  // or the venue may not want automated readers.
  if (!response.ok) {
    return { context: null, warning: `${url} returned ${response.status}` };
  }
  if (!response.headers.get("content-type")?.includes("text/html")) {
    return { context: null, warning: "not an HTML page" };
  }

  return pageContext(await response.text());
}

/** A fetched page as context, separate from the request so it can be tested. */
export function pageContext(html: string): ContextResult {
  const whole = stripHtml(html);
  const text = truncate(whole, MAX_CHARS);
  if (text.length <= 200) return { context: null, warning: "page had too little extractable text" };
  return {
    context: { text, via: "page" },
    warning: [
      // Tag stripping keeps navigation, footer and cookie banner alongside the
      // content. Said plainly, because "fetched live" reads cleaner than this is.
      "read as stripped HTML, which does not separate the site's navigation and other furniture from the page's own content",
      text.length < whole.length ? "truncated; the rest of the page was not read" : "",
    ]
      .filter(Boolean)
      .join("; "),
  };
}

/**
 * A thread as text, with its paragraphs: block-level tags become line breaks and
 * everything else is dropped. Crude on purpose — good enough to feed a model,
 * not a readability engine.
 *
 * Tags first, then references, so a decoded `&lt;b&gt;` survives as the text the
 * author quoted instead of being stripped as markup.
 */
export function stripHtml(html: string): string {
  const withoutTags = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  // U+00A0 alongside the space and the tab: `&nbsp;` and `&#160;` both decode to
  // it, and a non-breaking space reaching a prompt is a stray character here.
  return decodeEntities(withoutTags)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
