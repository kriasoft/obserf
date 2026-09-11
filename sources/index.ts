import { braveSource } from "./brave";
import { githubSource } from "./github";
import { hackerNewsSource } from "./hackernews";
import { redditSource } from "./reddit";
import type { Source } from "./types";

/**
 * Registry order is discovery precedence: the first snapshot of a URL to reach
 * the gate's history checks owns it for that scan, so specialized adapters
 * precede Brave, which can only supply the search description of a thread the
 * others carry in full.
 */
export const sources: Source[] = [hackerNewsSource, redditSource, githubSource, braveSource];

/**
 * Selects adapters in registry order, regardless of requested order.
 * Undefined selects all; empty lists and unknown ids fail before discovery.
 */
export function selectSources(ids?: readonly string[]): Source[] {
  if (ids === undefined) return sources;
  if (ids.length === 0) {
    throw new Error("No sources selected. Omit the list to run every source.");
  }
  for (const id of ids) {
    if (!sources.some((source) => source.id === id)) {
      throw new Error(`Unknown source "${id}". Available: ${sources.map((s) => s.id).join(", ")}`);
    }
  }
  return sources.filter((source) => ids.includes(source.id));
}

export * from "./types";
