import { describe, expect, test } from "bun:test";
import { enrichSurvivors } from "../pipeline/enrich";
import type { Candidate, Source } from "../sources";
import type { SourceId } from "../vocabulary";

function candidate(sourceId: SourceId, url: string): Candidate {
  return { sourceId, url, title: url, excerpt: "text", venue: sourceId };
}

function source(id: SourceId, enrich?: Source["enrich"]): Source {
  return { id, unavailable: () => null, search: async () => [], enrich };
}

const marking: Source["enrich"] = async (candidates) =>
  candidates.map((c) => ({ ...c, repository: { stars: 1 } }));

describe("enrichSurvivors", () => {
  test("an adapter is handed only its own candidates", async () => {
    let seen: readonly Candidate[] = [];
    const github = source("github", async (candidates) => {
      seen = candidates;
      return [...candidates];
    });
    const kept = [candidate("github", "a"), candidate("hn", "b"), candidate("github", "c")];

    await enrichSurvivors([github, source("hn")], kept);
    expect(seen.map((c) => c.url)).toEqual(["a", "c"]);
  });

  test("the enriched candidate replaces the original, and others pass through", async () => {
    const kept = [candidate("github", "a"), candidate("hn", "b")];
    const result = await enrichSurvivors([source("github", marking), source("hn")], kept);

    expect(result.find((c) => c.url === "a")?.repository).toEqual({ stars: 1 });
    expect(result.find((c) => c.url === "b")?.repository).toBeUndefined();
  });

  test("order is the adapter's business", async () => {
    const reversing: Source["enrich"] = async (candidates) => [...candidates].reverse();
    const kept = [candidate("github", "a"), candidate("github", "b")];

    const result = await enrichSurvivors([source("github", reversing)], kept);
    expect(result.map((c) => c.url)).toEqual(["a", "b"]);
  });

  test("a source with no enrich is skipped, not an error", async () => {
    const kept = [candidate("hn", "a")];
    expect(await enrichSurvivors([source("hn")], kept)).toEqual(kept);
  });

  test("dropping a candidate fails enrichment", async () => {
    const dropping: Source["enrich"] = async (candidates) => candidates.slice(1);
    const kept = [candidate("github", "a"), candidate("github", "b")];

    await expect(enrichSurvivors([source("github", dropping)], kept)).rejects.toThrow(
      /must return the 2 candidate\(s\).*returned 1 and lost a/s,
    );
  });

  // Same distinct URLs and nothing lost, so checking the map alone would miss it.
  test("returning an extra copy of a valid candidate fails enrichment", async () => {
    const echoing: Source["enrich"] = async (candidates) => [...candidates, candidates[1]!];
    const kept = [candidate("github", "a"), candidate("github", "b")];

    await expect(enrichSurvivors([source("github", echoing)], kept)).rejects.toThrow(
      /must return the 2 candidate\(s\).*returned 3/s,
    );
  });

  test("changing a candidate's source fails enrichment", async () => {
    const stealing: Source["enrich"] = async (candidates) =>
      candidates.map((c) => ({ ...c, sourceId: "hn" }));

    await expect(
      enrichSurvivors([source("github", stealing)], [candidate("github", "a")]),
    ).rejects.toThrow(/changed the source of a to "hn"/);
  });

  test("inventing a candidate fails enrichment", async () => {
    const inventing: Source["enrich"] = async (candidates) => [
      ...candidates,
      candidate("github", "invented"),
    ];
    await expect(
      enrichSurvivors([source("github", inventing)], [candidate("github", "a")]),
    ).rejects.toThrow(/must return the 1 candidate\(s\)/);
  });

  // Two copies of one URL and none of another is the same count, so counting
  // alone would miss it.
  test("duplicating one candidate over another fails enrichment", async () => {
    const duplicating: Source["enrich"] = async (candidates) => [candidates[0]!, candidates[0]!];
    const kept = [candidate("github", "a"), candidate("github", "b")];

    await expect(enrichSurvivors([source("github", duplicating)], kept)).rejects.toThrow(/lost b/);
  });

  test("rewriting a candidate's URL fails enrichment", async () => {
    const rewriting: Source["enrich"] = async (candidates) =>
      candidates.map((c) => ({ ...c, url: `${c.url}?utm=1` }));

    await expect(
      enrichSurvivors([source("github", rewriting)], [candidate("github", "a")]),
    ).rejects.toThrow(/lost a/);
  });

  /*
   * A different mechanism from the checks above: these adapters return exactly
   * what they were given, so counting and URL identity both agree — because the
   * adapter moved the goalposts along with the ball. The expected identity has
   * to be captured before the adapter runs.
   *
   * Both need a cast, which is the compile-time half of the guard doing its job:
   * `enrich` receives `readonly Candidate[]`.
   */
  test("rewriting a candidate's URL in place fails enrichment", async () => {
    const mutating: Source["enrich"] = async (candidates) => {
      (candidates as Candidate[])[0]!.url = "rewritten";
      return candidates as Candidate[];
    };

    await expect(
      enrichSurvivors([source("github", mutating)], [candidate("github", "a")]),
    ).rejects.toThrow(/lost a/);
  });

  test("splicing the array it was given fails enrichment", async () => {
    const splicing: Source["enrich"] = async (candidates) => {
      const given = candidates as Candidate[];
      given.splice(0, 1);
      return given;
    };
    const kept = [candidate("github", "a"), candidate("github", "b")];

    await expect(enrichSurvivors([source("github", splicing)], kept)).rejects.toThrow(
      /must return the 2 candidate\(s\).*returned 1 and lost a/s,
    );
  });

  test("an adapter failure is propagated", async () => {
    const failing: Source["enrich"] = async () => {
      throw new Error("GitHub rate limit hit");
    };
    await expect(
      enrichSurvivors([source("github", failing)], [candidate("github", "a")]),
    ).rejects.toThrow(/rate limit/);
  });
});
