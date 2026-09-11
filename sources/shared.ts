/**
 * Runtime helpers every adapter needs. Here rather than in `types.ts`, which is
 * the adapter contract, and rather than a root-level `utils.ts`: both exist to
 * serve source adapters and have no meaning outside them.
 */

/**
 * What a profile actually gave a source to send: its entries, trimmed, minus the
 * blank ones. Four adapters ask, and they must agree.
 *
 * The list rather than a yes or no, because `unavailable` and `search` have to
 * mean the same thing by "a query". A predicate let them disagree: a blank entry
 * beside a real one passed the check and was then sent anyway, spending a
 * request on a query nobody wrote — and on Algolia that broadens the search
 * rather than narrowing it, so the damage was quietest where it was worst.
 */
export function nonBlank(values: string[] | undefined): string[] {
  return values?.map((value) => value.trim()).filter(Boolean) ?? [];
}

/** Politeness delay. Every adapter is rate-limited; the limits differ per source. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
