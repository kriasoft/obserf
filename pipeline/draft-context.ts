/**
 * Fetches current thread context at draft time over plain HTTP, without a browser.
 * Assessment uses discovery text and optional enrichment, which may omit the
 * conversation needed for a specific reply. Fetching the page only when the
 * operator chooses to draft keeps requests proportional to actual use and
 * surfaces retrieval failures before they act. See docs/architecture.md.
 */

import { config } from "../config";
import type { Finding } from "../db/schema";
import { decodeEntities, truncate } from "../html";

/** Enough of a thread to answer it; beyond this is other people's conversation. */
const MAX_CHARS = 8000;
const TIMEOUT_MS = 15_000;

export interface FreshContext {
  text: string;
  /** How it was retrieved, for the operator to judge how much to trust it. */
  via: "hn-api" | "page";
}

export interface ContextResult {
  context: FreshContext | null;
  /** Why there is none. Surfaced rather than silently falling back. */
  reason?: string;
}

export async function fetchContext(finding: Finding): Promise<ContextResult> {
  try {
    const hnId = /news\.ycombinator\.com\/item\?id=(\d+)/.exec(finding.url)?.[1];
    return hnId ? await fetchHackerNews(hnId) : await fetchPage(finding.url);
  } catch (error) {
    return { context: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

interface AlgoliaItem {
  title: string | null;
  text: string | null;
  author: string | null;
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
    return { context: null, reason: `Hacker News item ${id} returned ${response.status}` };
  }

  const item = (await response.json()) as AlgoliaItem;
  const lines: string[] = [];

  const walk = (node: AlgoliaItem, depth: number) => {
    const body = stripHtml(node.text ?? "");
    if (node.title) lines.push(`# ${node.title}`);
    if (body) lines.push(`${"  ".repeat(depth)}${node.author ?? "?"}: ${body}`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(item, 0);

  const text = lines.join("\n\n").slice(0, MAX_CHARS);
  return text ? { context: { text, via: "hn-api" } } : { context: null, reason: "empty thread" };
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
    return { context: null, reason: `${url} returned ${response.status}` };
  }
  if (!response.headers.get("content-type")?.includes("text/html")) {
    return { context: null, reason: "not an HTML page" };
  }

  const text = truncate(stripHtml(await response.text()), MAX_CHARS);
  return text.length > 200
    ? { context: { text, via: "page" } }
    : { context: null, reason: "page had too little extractable text" };
}

/**
 * A thread as text, with its paragraphs: block-level tags become line breaks and
 * everything else is dropped. Crude on purpose — good enough to feed a model,
 * not a readability engine.
 *
 * Tags first, then references, so a decoded `&lt;b&gt;` survives as the text the
 * author quoted instead of being stripped as markup.
 */
function stripHtml(html: string): string {
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
