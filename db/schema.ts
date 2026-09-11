/**
 * Three concerns, three tables: evidence (`findings`), judgment (`assessments`),
 * and decision (`triage`). See docs/adr/002-evidence-judgment-decision.md.
 */

import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Shared with the browser, so it lives outside this module — see vocabulary.ts.
// Not re-exported: the tables are this module's to own, the vocabulary is not,
// and a second import route would make `db/schema.ts` look like its home.
import type { DraftKind, OpportunityType, TriageStatus, SourceId } from "../vocabulary";
import type { RepositoryFacts } from "../sources/types";

/** One scan. Holds the counts and token spend that make a run answerable later. */
export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project: text("project").notNull(),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  sources: text("sources", { mode: "json" }).$type<SourceId[]>().notNull(),
  /**
   * Of `sources`, the ones not attempted because they were unavailable, and why.
   * Null until discovery finishes and the row records it; an empty object means
   * every selected source was attempted.
   */
  skipped: text("skipped", { mode: "json" }).$type<Partial<Record<SourceId, string>>>(),
  candidates: integer("candidates").notNull().default(0),
  /** Rejected by the deterministic gates, keyed by rule. */
  gated: text("gated", { mode: "json" }).$type<Record<string, number>>(),
  assessed: integer("assessed").notNull().default(0),
  // Separate categories preserve cache usage and explain the list-price estimate.
  inputTokens: integer("input_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  /**
   * List-price estimate reported by the SDK. Obserf runs on a Claude Code
   * subscription, so nothing is billed per scan — this is a relative measure of
   * how expensive a scan was, not an invoice.
   */
  estimatedCostUsd: real("estimated_cost_usd").notNull().default(0),
  error: text("error"),
});

/**
 * The latest successfully assessed snapshot of a finding.
 *
 * Mutable by design: an opportunity is not a fixed fact. A thread gains comments,
 * reaches the front page, or turns from ambiguous into exactly the question the
 * project answers. Freezing the first observation made obserf a one-shot finder
 * that could never see the moment worth acting on — see ADR-002.
 *
 * `discoveredAt` never changes; every snapshot field does. When a snapshot was
 * last refreshed is `max(assessments.createdAt)` — the refresh and the assessment
 * share a transaction, so a second timestamp here would only be able to disagree.
 */
export const findings = sqliteTable(
  "findings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    project: text("project").notNull(),
    sourceId: text("source_id").$type<SourceId>().notNull(),
    /** Canonicalized — see url.ts. Unique per project. */
    url: text("url").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt").notNull().default(""),
    author: text("author"),
    /** Where this lives, for a human: "news.ycombinator.com", "r/golang". */
    venue: text("venue").notNull(),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    /** Discussion engagement as last observed. Drives `reach` and change detection. */
    metrics: text("metrics", { mode: "json" }).$type<{ points?: number; comments?: number }>(),
    /**
     * Whether `url` points at one comment inside a discussion rather than the
     * discussion itself. Null until a source classifies it, and an unclassified
     * rediscovery preserves an established value: unknown is distinct from false
     * because storage must not claim it identified a thread.
     */
    isThreadComment: integer("is_thread_comment", { mode: "boolean" }),
    /**
     * Repository facts, for a candidate that is one. Stored rather than only
     * interpolated into the prompt because the operator triaging a curated list
     * needs the same numbers the model saw — how much of what a list
     * resolves it actually merges is most of the decision, and looking it up again
     * on github.com is what this replaces. `obserf show` prints it.
     */
    repository: text("repository", { mode: "json" }).$type<RepositoryFacts>(),
    /** When this finding was first persisted. Never updated. */
    discoveredAt: integer("discovered_at", { mode: "timestamp" }).notNull(),
    firstRunId: integer("first_run_id").references(() => runs.id),
    raw: text("raw", { mode: "json" }),
  },
  (t) => [
    uniqueIndex("findings_project_url").on(t.project, t.url),
    index("findings_project_discovered").on(t.project, t.discoveredAt),
  ],
);

/**
 * Model judgment. Append-only: a re-assessment adds a row so a prompt change
 * stays comparable against what the operator already acted on.
 */
export const assessments = sqliteTable(
  "assessments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    findingId: integer("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    /**
     * Hash of the rubric plus the project brief that produced this verdict.
     * Derived rather than hand-maintained, so it cannot drift. See
     * `assessPromptFingerprint` in pipeline/assess.ts.
     */
    promptFingerprint: text("prompt_fingerprint").notNull(),

    // Components, 0-5. The model produces these; it never produces `score`.
    relevance: integer("relevance").notNull(),
    intent: integer("intent").notNull(),
    welcome: integer("welcome").notNull(),
    reach: integer("reach").notNull(),

    opportunity: text("opportunity").$type<OpportunityType>(),
    disqualified: integer("disqualified", { mode: "boolean" }).notNull().default(false),
    reason: text("reason").notNull(),

    /** Derived by pipeline/score.ts. A cache of the arithmetic, not an input. */
    score: real("score").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("assessments_finding").on(t.findingId, t.createdAt)],
);

/** The operator's current decision. One row per finding, freely updated. */
export const triage = sqliteTable(
  "triage",
  {
    findingId: integer("finding_id")
      .primaryKey()
      .references(() => findings.id, { onDelete: "cascade" }),
    status: text("status").$type<TriageStatus>().notNull().default("new"),
    note: text("note"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("triage_status").on(t.status)],
);

/** Generated copy. Append-only so regenerating preserves earlier drafts; posted edits are not tracked. */
export const drafts = sqliteTable(
  "drafts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    findingId: integer("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DraftKind>().notNull(),
    body: text("body").notNull(),
    model: text("model").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("drafts_finding").on(t.findingId, t.createdAt)],
);

export type Finding = typeof findings.$inferSelect;
export type Assessment = typeof assessments.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
