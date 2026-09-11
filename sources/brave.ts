import { config } from "../config";
import { plainText } from "../html";
import type { ProjectProfile } from "../project";
import { hostOf } from "../url";
import { nonBlank, sleep } from "./shared";
import type { Candidate, SearchOptions, Source } from "./types";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

interface BraveResponse {
  web?: {
    results?: Array<{
      url: string;
      title: string;
      description?: string;
      age?: string;
      page_age?: string;
    }>;
  };
}

/**
 * Brave Web Search. The free tier allows one query per second, so queries run
 * sequentially with a delay rather than in parallel — the cap is hard, and
 * exceeding it fails the whole scan rather than degrading it.
 *
 * Prefers `queries.brave` over the shared `queries.search`, which is where a
 * profile puts `site:` operators that would match nothing on Algolia or Reddit.
 */
export const braveSource: Source = {
  id: "brave",

  unavailable(project: ProjectProfile) {
    // The same expression `search` resolves, not "both are empty": `brave: []`
    // is an explicit instruction to ask nothing, and `??` does not fall back
    // from it — so a populated `queries.search` would not rescue this source,
    // and saying it was missing would send the operator to fill in a field that
    // is already filled in.
    if (!nonBlank(project.queries.brave ?? project.queries.search).length) {
      return project.queries.brave
        ? "queries.brave has nothing to send, and an explicit list is not topped up from queries.search"
        : "the profile sets no queries.brave, and queries.search has nothing to send either";
    }
    return config.braveApiKey ? null : "BRAVE_API_KEY is not set";
  },

  async search(project: ProjectProfile, options: SearchOptions): Promise<Candidate[]> {
    const candidates: Candidate[] = [];

    const queries = nonBlank(project.queries.brave ?? project.queries.search);

    for (const [i, query] of queries.entries()) {
      if (i > 0) await sleep(1100);

      const url = new URL(ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(options.limit, 20)));
      url.searchParams.set("result_filter", "web");

      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": config.braveApiKey!,
          "User-Agent": config.userAgent,
        },
      });

      if (!response.ok) {
        throw new Error(`Brave search failed (${response.status}): ${await response.text()}`);
      }

      const body = (await response.json()) as BraveResponse;
      for (const result of body.web?.results ?? []) {
        const age = result.page_age ?? result.age;
        const publishedAt = age ? new Date(age) : undefined;
        candidates.push({
          sourceId: "brave",
          url: result.url,
          title: plainText(result.title),
          excerpt: plainText(result.description),
          venue: hostOf(result.url),
          publishedAt:
            publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : undefined,
          raw: result,
        });
      }
    }

    return candidates;
  },
};
