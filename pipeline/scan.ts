/**
 * Orchestrates discover → gate → enrich → assess → store. See docs/architecture.md.
 */

import { eq } from "drizzle-orm";
import { config } from "../config";
import { db, knownFindings, knownFindingsReadOnly, schema } from "../db";
import { emptyUsage, pool, type Usage } from "../agent";
import type { ProjectProfile } from "../project";
import { selectSources, type Candidate } from "../sources";
import type { SourceId } from "../vocabulary";
import { assess, assessPromptFingerprint } from "./assess";
import { enrichSurvivors, type EnrichEvent } from "./enrich";
import { gate, type GateRule } from "./gate";
import { score } from "./score";

export interface ScanOptions {
  /** Overrides the project's default sources. */
  sourceIds?: string[];
  /** Discover and gate, but make no model calls and write nothing. */
  dryRun?: boolean;
  onProgress?: (event: ScanEvent) => void;
}

export type ScanEvent =
  | { type: "source:start"; sourceId: string }
  | { type: "source:done"; sourceId: string; count: number }
  | { type: "source:skip"; sourceId: string; reason: string }
  | { type: "source:error"; sourceId: string; error: string }
  | EnrichEvent
  | { type: "assessed"; done: number; total: number; score: number };

export interface ScanResult {
  /** Selected sources not attempted because they were unavailable, and why. */
  skipped: Array<{ sourceId: SourceId; reason: string }>;
  candidates: number;
  rejected: Record<GateRule, number>;
  /** What the gate let through. All a dry run produces. */
  survivors: Array<{ title: string; url: string }>;
  assessed: number;
  /** Assessed findings that scored above zero, best first. Empty in a dry run. */
  scored: Array<{ findingId: number; score: number; title: string; url: string }>;
  usage: Usage;
}

export async function scan(
  project: ProjectProfile,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const { dryRun = false, onProgress = () => {} } = options;
  // `--source` overrides the profile outright, which is how a source the project
  // has stopped running by default is still reachable for an experiment.
  const selected = selectSources(options.sourceIds ?? project.sources);
  const usage = emptyUsage();
  // Accumulated rather than thrown on the spot, so one broken source does not
  // hide the others; the scan fails once discovery has been fully attempted.
  const failed: Array<{ sourceId: SourceId; error: string }> = [];

  const run = dryRun
    ? null
    : db
        .insert(schema.runs)
        .values({
          project: project.key,
          startedAt: new Date(),
          sources: selected.map((s) => s.id),
        })
        .returning()
        .get();

  // Sources run sequentially; each adapter owns its request pacing.
  const candidates: Candidate[] = [];
  const skipped: Array<{ sourceId: SourceId; reason: string }> = [];
  for (const source of selected) {
    const reason = source.unavailable(project);
    if (reason) {
      skipped.push({ sourceId: source.id, reason });
      onProgress({ type: "source:skip", sourceId: source.id, reason });
      continue;
    }

    onProgress({ type: "source:start", sourceId: source.id });
    try {
      const found = await source.search(project, { limit: config.resultsPerQuery });
      candidates.push(...found);
      onProgress({ type: "source:done", sourceId: source.id, count: found.length });
    } catch (error) {
      // One source failing must not lose the results the others already returned.
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ sourceId: source.id, error: message });
      onProgress({ type: "source:error", sourceId: source.id, error: message });
    }
  }

  const skippedBySource = Object.fromEntries(skipped.map((s) => [s.sourceId, s.reason]));

  // Two ways discovery can end without having looked at the whole selection. The
  // second is the quieter one: every source unavailable also produces "0
  // candidates", which is what a genuinely empty search says, and a profile that
  // gave its sources nothing usable to ask must not read as a quiet week. See
  // ADR-007 on `unavailable(project)` returning a reason.
  let abort: string | null = null;
  if (failed.length) {
    const detail = failed.map((f) => `${f.sourceId}: ${f.error}`).join("; ");
    abort = `Discovery failed, so nothing was assessed — ${detail}`;
  } else if (skipped.length === selected.length) {
    const detail = skipped.map((s) => `${s.sourceId}: ${s.reason}`).join("; ");
    abort = `No source could run, so nothing was searched — ${detail}`;
  }

  if (abort) {
    // Discovery came back short, so nothing after this point would be looking at
    // the full set — not the gate, whose counts would describe a candidate list
    // obserf knows is incomplete, and certainly not assessment. `gated` stays
    // null because the gate genuinely never ran.
    if (run) {
      db.update(schema.runs)
        .set({
          finishedAt: new Date(),
          skipped: skippedBySource,
          candidates: candidates.length,
          error: abort,
        })
        .where(eq(schema.runs.id, run.id))
        .run();
    }
    throw new Error(abort);
  }

  // Record discovery completion before later pipeline work begins. If the
  // process dies before `finalize`, null would otherwise leave it unknown.
  if (run) {
    db.update(schema.runs)
      .set({ skipped: skippedBySource })
      .where(eq(schema.runs.id, run.id))
      .run();
  }

  // A dry run reads the existing database through a read-only connection so it
  // can report history-aware counts without database writes.
  const known = dryRun ? knownFindingsReadOnly(project.key) : knownFindings(project.key);
  // Computed once rather than per candidate: it is identical for every
  // assessment in a scan.
  const fingerprint = assessPromptFingerprint(project);

  const { kept, rejected } = gate(candidates, {
    known,
    blockedDomains: [...config.gate.blockedDomains, ...(project.blockedDomains ?? [])],
    maxAgeDays: config.gate.maxAgeDays,
    minTextLength: config.gate.minTextLength,
    reassessAfterDays: config.gate.reassessAfterDays,
    reassessDisqualifiedAfterDays: config.gate.reassessDisqualifiedAfterDays,
  });

  // The gate canonicalizes URLs to match `known`. Inherit stable shape before
  // assessment so its prompt and the refreshed snapshot cannot disagree.
  for (const candidate of kept) {
    candidate.isThreadComment ??= known.get(candidate.url)?.isThreadComment ?? undefined;
  }

  const survivors = kept.map((c) => ({ title: c.title, url: c.url }));

  if (dryRun) {
    return {
      skipped,
      candidates: candidates.length,
      rejected,
      survivors,
      assessed: 0,
      scored: [],
      usage,
    };
  }

  let done = 0;
  const stored: Array<{ findingId: number; score: number; title: string; url: string }> = [];

  // Finalize successful runs and failures during enrichment, assessment, or persistence.
  const finalize = (assessError?: unknown) => {
    const error =
      assessError instanceof Error ? assessError.message : assessError ? String(assessError) : null;
    db.update(schema.runs)
      .set({
        finishedAt: new Date(),
        candidates: candidates.length,
        gated: rejected,
        // What was actually stored before the failure, not what was attempted.
        assessed: stored.length,
        ...usage,
        error,
      })
      .where(eq(schema.runs.id, run!.id))
      .run();
  };

  try {
    // Keep enrichment inside the try so a failure still closes the run row.
    const enriched = await enrichSurvivors(selected, kept, onProgress);

    await pool(enriched, config.assessConcurrency, async (candidate) => {
      const verdict = await assess(project, candidate, usage);
      const value = score(verdict, candidate.publishedAt);
      const findingId = persist(project, candidate, run!.id, verdict, value, fingerprint);
      // Recorded as each one lands, so a mid-scan failure still leaves the run
      // row describing the work completed and kept.
      stored.push({ findingId, score: value, title: candidate.title, url: candidate.url });
      onProgress({ type: "assessed", done: ++done, total: enriched.length, score: value });
    });
  } catch (error) {
    finalize(error);
    throw error;
  }

  finalize();

  return {
    skipped,
    candidates: candidates.length,
    rejected,
    survivors,
    assessed: stored.length,
    scored: stored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score),
    usage,
  };
}

/**
 * Writes the finding, its assessment, and a `new` triage row in one transaction,
 * so a crash mid-scan never leaves a finding without the verdict that justified it.
 */
function persist(
  project: ProjectProfile,
  candidate: Candidate,
  runId: number,
  verdict: Awaited<ReturnType<typeof assess>>,
  value: number,
  promptFingerprint: string,
): number {
  return db.transaction((tx) => {
    const now = new Date();
    // `sourceId` is part of the snapshot, not first-observation provenance: when
    // Brave discovers an HN thread and the HN adapter later refreshes it, the
    // excerpt, metrics, and raw payload all become Algolia's, and a stale
    // "brave" would describe none of them. `firstRunId` records discovery.
    const snapshot = {
      sourceId: candidate.sourceId,
      title: candidate.title,
      excerpt: candidate.excerpt,
      author: candidate.author ?? null,
      venue: candidate.venue,
      publishedAt: candidate.publishedAt ?? null,
      // Unknown is not false: the source has not established a top-level thread.
      isThreadComment: candidate.isThreadComment ?? null,
      // `?? null` rather than the bare value throughout: Drizzle omits undefined
      // from an update's SET clause, so a field a source has stopped reporting
      // would keep its previous value forever. That is not hypothetical — GitHub
      // repositories no longer carry `metrics`, and without this every one of
      // them would have kept the mislabelled figures this release removes.
      metrics: candidate.metrics ?? null,
      repository: candidate.repository ?? null,
      raw: candidate.raw ?? null,
    };

    // A known URL is refreshed rather than skipped: the whole point of
    // reassessment is that the thread is not what it was. `discoveredAt` and
    // `firstRunId` are omitted from the update so first observation stays fixed.
    const finding = tx
      .insert(schema.findings)
      .values({
        project: project.key,
        url: candidate.url,
        discoveredAt: now,
        firstRunId: runId,
        ...snapshot,
      })
      .onConflictDoUpdate({
        target: [schema.findings.project, schema.findings.url],
        set: snapshot,
      })
      .returning()
      .get();

    const id = finding.id;

    tx.insert(schema.assessments)
      .values({
        findingId: id,
        model: config.model,
        promptFingerprint,
        relevance: verdict.relevance,
        intent: verdict.intent,
        welcome: verdict.welcome,
        reach: verdict.reach,
        opportunity: verdict.opportunity,
        disqualified: verdict.disqualified,
        reason: verdict.reason,
        score: value,
        createdAt: new Date(),
      })
      .run();

    tx.insert(schema.triage)
      .values({ findingId: id, status: "new", updatedAt: new Date() })
      .onConflictDoNothing()
      .run();

    return id;
  });
}
