/**
 * The stage between the gate and the model: adapters add facts too expensive to
 * gather for every search result. See docs/adr/009-expensive-evidence-after-the-gate.md.
 */

import type { Candidate, Source } from "../sources";

/** Told which source is working, and on how many candidates. */
export type EnrichEvent =
  | { type: "enrich:start"; sourceId: string; count: number }
  | { type: "enrich:done"; sourceId: string };

/**
 * Enrich each source's survivors, preserving their original order.
 * Reject contract violations instead of assessing silently unenriched candidates;
 * missing evidence must not be mistaken for a successful lookup (ADR-009).
 */
export async function enrichSurvivors(
  selected: readonly Source[],
  kept: Candidate[],
  onProgress: (event: EnrichEvent) => void = () => {},
): Promise<Candidate[]> {
  let candidates = kept;

  for (const source of selected) {
    if (!source.enrich) continue;
    const mine = candidates.filter((candidate) => candidate.sourceId === source.id);
    if (!mine.length) continue;

    // Read before the adapter runs, because `mine` and the candidates in it are
    // the adapter's own arguments: one that splices the array or rewrites a URL
    // in place would move this expectation along with the violation, and every
    // check below would agree with itself. `readonly Candidate[]` on `enrich`
    // discourages the first case; only a snapshot detects either.
    const expected = mine.map((candidate) => candidate.url);

    onProgress({ type: "enrich:start", sourceId: source.id, count: expected.length });
    const returned = await source.enrich(mine);
    const byUrl = new Map(returned.map((candidate) => [candidate.url, candidate]));

    // Three facts, because two are not enough: the same count returned, no two
    // sharing a URL, and every input still among them. Dropping the first would
    // admit `[a, b] → [a, b, b]`, which keeps the map's size and loses nothing
    // yet is still an adapter inventing a candidate.
    const lost = expected.find((url) => !byUrl.has(url));
    if (returned.length !== expected.length || byUrl.size !== expected.length || lost) {
      throw new Error(
        `${source.id} enrichment must return the ${expected.length} candidate(s) it was given, ` +
          `but returned ${returned.length}${lost ? ` and lost ${lost}` : ""}. ` +
          "Enriching adds facts to candidates; it is not a place to filter them.",
      );
    }

    // `sourceId` is not decoration: the next iteration selects candidates by it,
    // so an adapter rewriting one would hand its own work to another adapter.
    const stolen = returned.find((candidate) => candidate.sourceId !== source.id);
    if (stolen) {
      throw new Error(
        `${source.id} enrichment changed the source of ${stolen.url} to ` +
          `"${stolen.sourceId}", which would reroute it to another adapter.`,
      );
    }

    // The fallback is reachable only for other sources' candidates — the check
    // above makes a miss impossible for this source's own.
    candidates = candidates.map((candidate) => byUrl.get(candidate.url) ?? candidate);
    onProgress({ type: "enrich:done", sourceId: source.id });
  }

  return candidates;
}
