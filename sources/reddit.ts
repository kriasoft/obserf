import { config } from "../config";
import { plainText, truncate } from "../html";
import type { ProjectProfile } from "../project";
import { nonBlank, sleep } from "./shared";
import type { Candidate, SearchOptions, Source } from "./types";

interface RedditListing {
  data?: {
    children?: Array<{
      data: {
        permalink: string;
        title: string;
        selftext?: string;
        author: string;
        subreddit: string;
        score: number;
        num_comments: number;
        created_utc: number;
        over_18: boolean;
      };
    }>;
  };
}

let token: { value: string; expiresAt: number } | undefined;

/**
 * App-only OAuth: no user authorization at runtime. The credentials belong to a
 * registered Reddit app with approved API access; see docs/product/sources.md.
 */
async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;

  const credentials = btoa(`${config.redditClientId}:${config.redditClientSecret}`);
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": config.userAgent,
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    throw new Error(
      `Reddit token request failed (${response.status}). Check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.`,
    );
  }

  const body = (await response.json()) as { access_token: string; expires_in: number };
  // Renew a minute early rather than racing the expiry mid-scan.
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return token.value;
}

/**
 * Searches each configured subreddit separately rather than site-wide: results
 * stay inside the profile's target communities. Inclusion is not evidence that
 * promotion is permitted; the assessment still has to judge that for each result.
 */
export const redditSource: Source = {
  id: "reddit",

  unavailable(project: ProjectProfile) {
    // Before the credentials: a profile with no subreddits is not fixed by
    // registering a Reddit app, and saying so would send the operator to do it.
    if (!nonBlank(project.queries.subreddits).length)
      return "queries.subreddits names no subreddit";
    if (!nonBlank(project.queries.search).length) return "queries.search has nothing to send";
    if (!config.redditClientId || !config.redditClientSecret) {
      // The README, not docs/: this reaches people running the installed
      // package, and the README is what ships with it.
      return "REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET must both be set (approved Reddit API access required; see the README)";
    }
    return null;
  },

  async search(project: ProjectProfile, options: SearchOptions): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    const query = nonBlank(project.queries.search).join(" OR ");
    const bearer = await accessToken();
    const inaccessible: string[] = [];

    const subreddits = nonBlank(project.queries.subreddits);
    for (const [i, subreddit] of subreddits.entries()) {
      if (i > 0) await sleep(700);

      const url = new URL(`https://oauth.reddit.com/r/${subreddit}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("restrict_sr", "1");
      url.searchParams.set("sort", "relevance");
      url.searchParams.set("t", "year");
      url.searchParams.set("limit", String(options.limit));

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${bearer}`, "User-Agent": config.userAgent },
      });

      // A private, quarantined, or renamed subreddit is one bad profile entry and
      // must not fail the scan — but it is collected and reported, because a 403
      // across every subreddit means broken access, not a profile that happens
      // to list only private ones.
      if (response.status === 403 || response.status === 404) {
        inaccessible.push(subreddit);
        continue;
      }
      if (!response.ok) {
        throw new Error(`Reddit search failed for r/${subreddit} (${response.status})`);
      }

      const body = (await response.json()) as RedditListing;
      for (const child of body.data?.children ?? []) {
        const post = child.data;
        if (post.over_18) continue;
        candidates.push({
          sourceId: "reddit",
          url: `https://www.reddit.com${post.permalink}`,
          title: plainText(post.title),
          excerpt: truncate(plainText(post.selftext), 1200),
          author: post.author,
          venue: `r/${post.subreddit}`,
          publishedAt: new Date(post.created_utc * 1000),
          metrics: { points: post.score, comments: post.num_comments },
          raw: post,
        });
      }
    }

    if (inaccessible.length === subreddits.length) {
      throw new Error(
        `Reddit denied access to every configured subreddit (${inaccessible.join(", ")}). ` +
          "This is an access problem, not an empty result.",
      );
    }
    if (inaccessible.length) {
      console.warn(`  reddit: skipped inaccessible subreddits: ${inaccessible.join(", ")}`);
    }

    return candidates;
  },
};
