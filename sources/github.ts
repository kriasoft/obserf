import { config } from "../config";
import { plainText, truncate } from "../html";
import type { ProjectProfile } from "../project";
import { nonBlank, sleep } from "./shared";
import type { Candidate, PullRequestActivity, SearchOptions, Source } from "./types";

/** Completeness flag shared by both search endpoints. */
interface SearchResponse {
  /** True when GitHub timed out, so the results and counts are short. */
  incomplete_results?: boolean;
}

interface IssueSearchResponse extends SearchResponse {
  total_count?: number;
  items: Array<{
    html_url: string;
    title: string;
    body: string | null;
    user: { login: string } | null;
    repository_url?: string;
    created_at: string;
    comments: number;
    reactions?: { total_count: number };
  }>;
}

interface RepoSearchResponse extends SearchResponse {
  items: Array<{
    html_url: string;
    full_name: string;
    description: string | null;
    owner: { login: string } | null;
    pushed_at: string;
    stargazers_count: number;
    archived: boolean;
  }>;
}

/**
 * How far back `enrich` counts pull requests, merged and closed-unmerged alike.
 *
 * A year includes activity from careful lists that merge only every few months;
 * a quarter can make them look abandoned. Both resolved counts must share a
 * window for their proportion to be meaningful.
 */
const PULL_REQUEST_WINDOW_DAYS = 365;

interface Credentials {
  token?: string;
  /** How the token was obtained, for error messages. */
  origin: string;
}

let cached: Credentials | undefined;

/**
 * Resolves a GitHub token once per process.
 *
 * Precedence is `GITHUB_TOKEN`, then the `gh` CLI, then unauthenticated. An
 * explicit environment variable wins because a variable set for this command
 * should not be silently overridden by ambient CLI state — but when it is unset,
 * borrowing `gh`'s token means a machine where `gh auth login` has already run
 * needs no obserf configuration at all, and no second copy of a credential that
 * would then have to be rotated twice.
 *
 * Failure to obtain a token from `gh` falls back to unauthenticated search.
 * Once a token is selected, request failures propagate; obserf does not retry
 * a rejected token anonymously.
 */
async function credentials(): Promise<Credentials> {
  if (cached) return cached;

  if (config.githubToken) {
    cached = { token: config.githubToken, origin: "GITHUB_TOKEN" };
    return cached;
  }

  const user = config.githubUser;
  try {
    // `.nothrow()` covers "not logged in" and "no such account" (exit 1); the
    // catch covers `gh` not being installed at all.
    const result = user
      ? await Bun.$`gh auth token -u ${user}`.quiet().nothrow()
      : await Bun.$`gh auth token`.quiet().nothrow();

    const token = result.exitCode === 0 ? result.stdout.toString().trim() : "";
    cached = token
      ? { token, origin: `gh CLI${user ? ` (${user})` : ""}` }
      : { origin: "unauthenticated" };
  } catch {
    cached = { origin: "unauthenticated" };
  }

  if (!cached.token) {
    console.warn(
      "  github: no token — running at 10 requests/minute. " +
        "Run `gh auth login`, set OBSERF_GITHUB_USER, or set GITHUB_TOKEN.",
    );
  }
  return cached;
}

/** Keep each endpoint tied to its response type. */
interface Search {
  issues(query: string, sort: string, perPage: number): Promise<IssueSearchResponse>;
  repositories(query: string, sort: string, perPage: number): Promise<RepoSearchResponse>;
}

/**
 * When the last search request went out, process-wide.
 *
 * Discovery and enrichment share the search request budget, so pacing must
 * continue across both stages and across projects. A timestamp also credits
 * elapsed processing time instead of sleeping again after a sufficient gap.
 */
let lastRequestAt = 0;

/** Search that paces itself to whichever rate limit actually applies. */
async function pacedSearch(): Promise<Search> {
  const auth = await credentials();
  // Keying this off the env var alone would throttle a gh-authenticated scan at
  // the anonymous rate.
  const delayMs = auth.token ? 2100 : 6100;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": config.userAgent,
  };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;

  const request = async (
    path: "issues" | "repositories",
    query: string,
    sort: string,
    perPage: number,
  ): Promise<SearchResponse> => {
    const remaining = lastRequestAt + delayMs - Date.now();
    if (remaining > 0) await sleep(remaining);
    lastRequestAt = Date.now();

    const url = new URL(`https://api.github.com/search/${path}`);
    url.searchParams.set("q", query);
    url.searchParams.set("sort", sort);
    url.searchParams.set("per_page", String(perPage));

    const response = await fetch(url, { headers });
    if (response.status === 403 || response.status === 429) {
      throw new Error(
        `GitHub rate limit hit (auth: ${auth.origin}).` +
          (auth.token
            ? " Retry in a minute."
            : " Run `gh auth login` or set GITHUB_TOKEN to raise it from 10 to 30 requests/minute."),
      );
    }
    if (!response.ok) {
      throw new Error(`GitHub search failed (${response.status}): ${await response.text()}`);
    }

    const body = (await response.json()) as SearchResponse;
    // GitHub saying "these results are short" and obserf treating them as the
    // whole picture is the same mistake in discovery as in enrichment: a scan
    // would record a complete run over a candidate set it knows was truncated.
    // `scan` already fails outright when a source cannot deliver its results.
    if (body.incomplete_results) {
      throw new Error(
        `GitHub reported incomplete results for \`${query}\`, so this scan would be ` +
          "working from a truncated candidate set. Retry in a minute.",
      );
    }
    return body;
  };

  /**
   * Both endpoints always send `items`, empty or not, so its absence is a
   * malformed response rather than a search that found nothing — and the
   * difference matters, because `?? []` would file the first as the second and
   * report a successful scan over no candidates. Only fields whose absence
   * obserf would misread are checked; this is not a schema validator.
   */
  const withItems = <T extends { items: unknown }>(body: SearchResponse, endpoint: string): T => {
    if (!Array.isArray((body as T).items)) {
      throw new Error(`GitHub ${endpoint} search returned no items array. Retry in a minute.`);
    }
    return body as T;
  };

  return {
    issues: async (query, sort, perPage) =>
      withItems<IssueSearchResponse>(await request("issues", query, sort, perPage), "issue"),
    repositories: async (query, sort, perPage) =>
      withItems<RepoSearchResponse>(
        await request("repositories", query, sort, perPage),
        "repository",
      ),
  };
}

/**
 * `https://github.com/owner/name` → `owner/name`; null for any other host or a
 * deeper path. The host matters because this is the point where obserf decides
 * which repository it is about to ask about: `https://example.com/acme/widget`
 * has the right shape, and accepting it would attach a real repository's
 * pull-request record to a candidate that is not that repository.
 */
function repositoryPath(url: string): string | null {
  const { hostname, pathname } = new URL(url);
  if (hostname !== "github.com") return null;

  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 2 ? `${parts[0]}/${parts[1]}` : null;
}

/**
 * GitHub search, over two endpoints because they answer two different questions
 * and share nothing but auth and rate limiting.
 *
 * `queries.github` searches issues and pull requests — "what should I use"
 * threads and comparison discussions. `queries.githubRepos` searches
 * repositories, which is how `awesome-*` lists are found; those are the
 * `listing` opportunity type, and issue search cannot surface them.
 *
 * Runs unauthenticated at 10 requests/minute; a token raises that to 30. The
 * token is optional because the free rate covers a handful of queries, and
 * requiring one would make the source unavailable by default for no gain.
 */
export const githubSource: Source = {
  id: "github",

  unavailable(project: ProjectProfile) {
    // Either endpoint is enough: most profiles set `github` and never look for
    // curated lists, and requiring both would skip a source that can search.
    const { github, githubRepos } = project.queries;
    return nonBlank(github).length || nonBlank(githubRepos).length
      ? null
      : "neither queries.github nor queries.githubRepos has anything to send";
  },

  async search(project: ProjectProfile, options: SearchOptions): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    const search = await pacedSearch();

    for (const query of nonBlank(project.queries.github)) {
      const body = await search.issues(query, "updated", options.limit);
      for (const item of body.items) {
        const repo = item.repository_url?.replace("https://api.github.com/repos/", "");
        candidates.push({
          sourceId: "github",
          url: item.html_url,
          title: plainText(item.title),
          excerpt: truncate(plainText(item.body), 1200),
          author: item.user?.login,
          venue: repo ? `github.com/${repo}` : "github.com",
          publishedAt: new Date(item.created_at),
          metrics: { points: item.reactions?.total_count, comments: item.comments },
          raw: item,
        });
      }
    }

    for (const query of nonBlank(project.queries.githubRepos)) {
      const body = await search.repositories(query, "stars", options.limit);
      for (const repo of body.items) {
        // An archived list accepts no submissions, so it is never an opportunity.
        if (repo.archived) continue;
        candidates.push({
          sourceId: "github",
          url: repo.html_url,
          title: repo.full_name,
          excerpt: plainText(repo.description),
          author: repo.owner?.login,
          venue: `github.com/${repo.full_name}`,
          // Use the last push for the age gate; creation age would discard
          // long-lived lists. Enrichment supplies separate evidence of receptiveness.
          publishedAt: new Date(repo.pushed_at),
          // Keep stars separate from discussion metrics and their change
          // detection. Open issues are omitted: they do not measure discussion
          // engagement or establish whether a list accepts submissions.
          repository: { stars: repo.stargazers_count },
          raw: repo,
        });
      }
    }

    return candidates;
  },

  /**
   * Adds pull-request behaviour to surviving repository candidates: how much of
   * what arrives is merged, how much is closed without being merged, and how much is
   * waiting. Three search requests each, so it runs on gate survivors only.
   *
   * Failures throw rather than degrading. A repository that reports no merges
   * because the request failed is indistinguishable, in the prompt, from one
   * that merges nothing — and that mistake is precisely what this exists to
   * prevent, so a scan that cannot gather the evidence should fail loudly.
   */
  async enrich(candidates: readonly Candidate[]): Promise<Candidate[]> {
    const targets = candidates.filter((candidate) => candidate.repository);
    if (!targets.length) return [...candidates];

    const search = await pacedSearch();
    const since = new Date(Date.now() - PULL_REQUEST_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const activities = new Map<string, PullRequestActivity>();

    // Only `total_count` is wanted from any of these, hence `per_page=1`.
    const total = async (query: string): Promise<number> => {
      const body = await search.issues(query, "updated", 1);
      // Never default a missing count to zero: that invents evidence of no
      // activity, and the resulting verdict could persist through the cooldown.
      if (body.total_count === undefined) {
        throw new Error(`GitHub returned no count for \`${query}\`. Retry in a minute.`);
      }
      return body.total_count;
    };

    for (const candidate of targets) {
      const path = repositoryPath(candidate.url);
      // Skipping it would hand the model a repository with stars and no
      // pull-request record, which the rubric reads as ordinary uncertainty
      // rather than as obserf having failed to ask.
      if (!path) {
        throw new Error(
          `Cannot read an owner and name from the repository URL ${candidate.url}, ` +
            "so its pull-request record cannot be gathered.",
        );
      }
      activities.set(candidate.url, {
        open: await total(`repo:${path} is:pr is:open`),
        windowDays: PULL_REQUEST_WINDOW_DAYS,
        merged: await total(`repo:${path} is:pr is:merged merged:>=${since}`),
        closedUnmerged: await total(`repo:${path} is:pr is:closed is:unmerged closed:>=${since}`),
      });
    }

    return candidates.map((candidate) => {
      const pullRequests = activities.get(candidate.url);
      if (!pullRequests || !candidate.repository) return candidate;
      return { ...candidate, repository: { ...candidate.repository, pullRequests } };
    });
  },
};
