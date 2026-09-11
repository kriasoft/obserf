import { config } from "../config";
import { plainText } from "../html";
import type { ProjectProfile } from "../project";
import { nonBlank, sleep } from "./shared";
import type { Candidate, SearchOptions, Source } from "./types";

const ENDPOINT = "https://hn.algolia.com/api/v1/search";

/** Algolia omits fields it has no value for rather than returning null. */
interface AlgoliaHit {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  /** Algolia's own classification: `"story"`, `"comment"`, `"author_x"`, and so on. */
  _tags?: string[];
  author: string;
  points?: number | null;
  num_comments?: number | null;
  created_at: string;
}

/**
 * Normalizes one hit, including its story-or-comment classification. Always
 * links to the HN item: the opportunity is the discussion, not the article.
 */
export function toCandidate(hit: AlgoliaHit): Candidate {
  // `_tags`, not `comment_text`: stories omit that field. A hit tagged as
  // neither comment nor story remains unclassified rather than becoming a story.
  const isThreadComment = hit._tags?.includes("comment")
    ? true
    : hit._tags?.includes("story")
      ? false
      : undefined;
  // A comment has no title of its own, so this is the enclosing story's — which
  // is worth keeping for display and misleading to send unlabelled.
  const title = hit.title ?? hit.story_title ?? "(comment)";

  return {
    sourceId: "hn",
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    title: plainText(title),
    excerpt: plainText(hit.comment_text ?? hit.story_text ?? ""),
    isThreadComment,
    author: hit.author,
    venue: "news.ycombinator.com",
    publishedAt: new Date(hit.created_at),
    metrics: {
      points: hit.points ?? undefined,
      comments: hit.num_comments ?? undefined,
    },
    raw: hit,
  };
}

/**
 * Hacker News via the Algolia index — free, unauthenticated, and full-text over
 * both stories and comments. `tags=(story,comment)` means a hit can be either;
 * `toCandidate` is where that is worked out.
 */
export const hackerNewsSource: Source = {
  id: "hn",

  unavailable(project: ProjectProfile) {
    return nonBlank(project.queries.search).length ? null : "queries.search has nothing to send";
  },

  async search(project: ProjectProfile, options: SearchOptions): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    // Same horizon the gate uses, applied at the source so the cap selects from
    // results that can actually survive it.
    const cutoff = Math.floor((Date.now() - config.gate.maxAgeDays * 86_400_000) / 1000);

    for (const [i, query] of nonBlank(project.queries.search).entries()) {
      if (i > 0) await sleep(1000);

      const url = new URL(ENDPOINT);
      url.searchParams.set("query", query);
      url.searchParams.set("tags", "(story,comment)");
      url.searchParams.set("hitsPerPage", String(options.limit));
      // Relevance ranking spans all of HN history, so without this the page
      // fills with popular old threads that the stale gate then discards —
      // burning the request and hiding the live discussions below them.
      url.searchParams.set("numericFilters", `created_at_i>${cutoff}`);

      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) {
        throw new Error(`Hacker News search failed (${response.status})`);
      }

      const body = (await response.json()) as { hits?: AlgoliaHit[] };
      for (const hit of body.hits ?? []) candidates.push(toCandidate(hit));
    }

    return candidates;
  },
};
