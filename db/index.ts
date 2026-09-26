/**
 * Database connection and the queries that span tables.
 *
 * `latestFindings` lives here rather than in each caller because "the current
 * state of a finding" is a join across all three tables plus a latest-assessment
 * predicate, and three callers reconstructing that independently would drift.
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { union } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";
import type { TriageStatus } from "../vocabulary";

/**
 * What storage knows for the gate's history checks, plus stable URL shape that
 * discovery may omit. Storage declares the full return type and the gate its
 * required subset; importing the gate here would point `db` at `pipeline`.
 */
type KnownFindingState = Pick<
  schema.Finding,
  "title" | "excerpt" | "metrics" | "isThreadComment"
> & {
  status: TriageStatus;
  lastAssessedAt: Date | null;
  disqualified: boolean;
};

import {
  databasePath,
  requireCreatableDatabase,
  requireReachableDatabase,
  requireWorkspace,
} from "../workspace";
import { migrate } from "./migrate";

export { databasePath };

/** Opened on first use; importing this module touches no database. */
let connection: ReturnType<typeof drizzle> | undefined;

function connect() {
  if (connection) return connection;
  const sqlite = open();
  // First, because everything below can contend: SQLite's default is to fail a
  // contended lock immediately rather than wait, which would turn `obserf serve`
  // and a scan running together into an error. Per-connection, so it changes
  // nothing on disk.
  sqlite.exec("PRAGMA busy_timeout = 10000");
  // Before the pragmas rather than after, because `journal_mode` is a permanent
  // property of the file: `OBSERF_DB` can name any database, and switching one
  // Obserf is about to reject as foreign is exactly the change `migrate` takes
  // care not to make.
  migrate(sqlite);
  // WAL keeps `obserf serve` readable while a scan writes.
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  connection = drizzle(sqlite, { schema, casing: "snake_case" });
  return connection;
}

/**
 * The marker decides whether a command may reach this database at all, not only
 * whether one may be created: a stray `.obserf/obserf.db` under some unrelated
 * directory is state, not a workspace. Creating one is a further question, and
 * `requireCreatableDatabase` — which asks this one first — answers it.
 */
function open(): Database {
  if (existsSync(databasePath)) {
    requireWorkspace();
    return new Database(databasePath, { readwrite: true });
  }
  requireCreatableDatabase();
  return new Database(databasePath, { readwrite: true, create: true });
}

/**
 * Opens and upgrades the database now, so that a command which is about to take
 * a while — or to bind a port — fails at its start rather than in the middle.
 * Every other caller reaches it lazily through `db`.
 */
export function prepareDatabase(): void {
  connect();
}

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get: (_target, property) => Reflect.get(connect(), property),
});

export interface FindingView {
  finding: schema.Finding;
  assessment: schema.Assessment | null;
  status: TriageStatus;
  note: string | null;
}

/**
 * A row of the ranked list. `drafts` is a count rather than the drafts
 * themselves: the list needs to show which findings have already been drafted,
 * and loading every body to answer that would be most of the database.
 */
export interface ListedFinding extends FindingView {
  drafts: number;
}

export interface ListOptions {
  project?: string;
  status?: TriageStatus[];
  minScore?: number;
  limit?: number;
}

/**
 * Each finding's newest assessment id, as a joinable subquery. Assessments are
 * append-only, so max(id) is the newest. Shared so the inbox and the gate agree
 * on which verdict is current.
 */
function latestAssessmentIds(database: ReturnType<typeof drizzle>) {
  return database
    .select({
      findingId: schema.assessments.findingId,
      assessmentId: sql<number>`max(${schema.assessments.id})`.as("assessment_id"),
    })
    .from(schema.assessments)
    .groupBy(schema.assessments.findingId)
    .as("latest");
}

/** Findings with their latest assessment and current triage status, best first. */
export function latestFindings(options: ListOptions = {}): ListedFinding[] {
  const { project, status, minScore, limit = 50 } = options;

  const latest = latestAssessmentIds(db);

  const filters = [
    project ? eq(schema.findings.project, project) : undefined,
    status?.length ? inArray(schema.triage.status, status) : undefined,
    minScore !== undefined ? gte(schema.assessments.score, minScore) : undefined,
  ].filter((f) => f !== undefined);

  const rows = db
    .select({
      finding: schema.findings,
      assessment: schema.assessments,
      status: schema.triage.status,
      note: schema.triage.note,
      drafts: sql<number>`(select count(*) from ${schema.drafts} where ${schema.drafts.findingId} = ${schema.findings.id})`,
    })
    .from(schema.findings)
    .leftJoin(latest, eq(latest.findingId, schema.findings.id))
    .leftJoin(schema.assessments, eq(schema.assessments.id, latest.assessmentId))
    .leftJoin(schema.triage, eq(schema.triage.findingId, schema.findings.id))
    .where(filters.length ? and(...filters) : undefined)
    // `id` last: two assessments can share a stored timestamp, and without a
    // monotonic tie-break their order is unspecified.
    .orderBy(
      desc(schema.assessments.score),
      desc(schema.assessments.createdAt),
      desc(schema.assessments.id),
    )
    .limit(limit)
    .all();

  return rows.map((row) => ({
    finding: row.finding,
    assessment: row.assessment,
    // A finding always gets a triage row on insert; the fallback covers a row
    // written before that invariant existed rather than a normal path.
    status: row.status ?? "new",
    note: row.note ?? null,
    drafts: row.drafts,
  }));
}

export function findingById(id: number): FindingView | undefined {
  const finding = db.select().from(schema.findings).where(eq(schema.findings.id, id)).get();
  if (!finding) return undefined;

  const assessment = db
    .select()
    .from(schema.assessments)
    .where(eq(schema.assessments.findingId, id))
    .orderBy(desc(schema.assessments.id))
    .get();

  const row = db.select().from(schema.triage).where(eq(schema.triage.findingId, id)).get();

  return {
    finding,
    assessment: assessment ?? null,
    status: row?.status ?? "new",
    note: row?.note ?? null,
  };
}

/**
 * The operator's decision. `note` has three states, and the difference matters:
 * a string replaces the stored note, `null` clears it, and `undefined` leaves it
 * alone — Drizzle omits an undefined column from the update, which is what lets
 * `obserf triage <id> shortlisted` change a status without erasing the reasoning
 * already written against it.
 *
 * Returns the status this replaced, so a caller can report or undo the change.
 * `returning()` would give the new status. This separate read is not atomic
 * with the write; another process can change the status between them.
 */
export function setTriage(
  findingId: number,
  status: TriageStatus,
  note?: string | null,
): TriageStatus | undefined {
  const previous = db
    .select({ status: schema.triage.status })
    .from(schema.triage)
    .where(eq(schema.triage.findingId, findingId))
    .get()?.status;

  db.insert(schema.triage)
    .values({ findingId, status, note, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.triage.findingId,
      set: { status, note, updatedAt: new Date() },
    })
    .run();

  return previous;
}

/**
 * What obserf already knows about each URL in a project — the current snapshot,
 * the operator's decision, and when the latest assessment ran and whether it
 * disqualified the finding. Feeds the gate's decision about whether a known URL
 * is worth looking at again.
 */
export function knownFindings(project: string): Map<string, KnownFindingState> {
  return knownFindingsIn(db, project);
}

/**
 * `knownFindings` through a private connection, for `scan --dry-run`: opening the
 * shared one migrates the database and switches it to WAL, and a dry run must
 * change nothing. `query_only` refuses SQL writes.
 *
 * Read-write anyway: Bun's read-only open (measured on 1.4.2) fails with "unable
 * to open database file" on a WAL database whose `-wal` and `-shm` are gone —
 * the usual state after a clean close on Linux and Windows, or of a copied file.
 * So SQLite may still create sidecars and checkpoint on close; what holds is no
 * SQL write and no migration.
 *
 * Failures propagate: operators record a dry run's survivor count
 * (`docs/product/evaluation.md`), and one computed from unreadable history is
 * wrong, not conservative.
 *
 * `path` is for tests, which need a WAL database with no live connection.
 */
export function knownFindingsForDryRun(
  project: string,
  path: string = databasePath,
): Map<string, KnownFindingState> {
  // The opener's rule minus creation: a mistyped `OBSERF_DB` fails instead of
  // reading as empty history. Test paths skip it.
  if (path === databasePath) requireReachableDatabase();
  // Only a missing file is empty history; `existsSync` would also answer false
  // for one it could not stat.
  if (!statSync(path, { throwIfNoEntry: false })) return new Map();

  let handle: Database | undefined;
  try {
    handle = new Database(path, { readwrite: true, create: false });
    // Wait out a concurrent scan's lock rather than fail on it.
    handle.exec("PRAGMA busy_timeout = 10000");
    handle.exec("PRAGMA query_only = ON");
    return knownFindingsIn(drizzle(handle, { schema, casing: "snake_case" }), project);
  } catch (error) {
    // Dry runs never migrate, so an older schema is the likeliest cause.
    throw new Error(
      `Could not read what is already known from ${path}: ${
        error instanceof Error ? error.message : String(error)
      }. If this database predates the installed obserf, run \`obserf list\` once to upgrade it.`,
      { cause: error },
    );
  } finally {
    // `true` finalizes Drizzle's prepared statements; without it the connection
    // outlives `close()` until they are collected.
    handle?.close(true);
  }
}

/** One query for both connections, so a dry run's gate counts cannot drift from a scan's. */
function knownFindingsIn(
  database: ReturnType<typeof drizzle>,
  project: string,
): Map<string, KnownFindingState> {
  const latest = latestAssessmentIds(database);

  const rows = database
    .select({
      url: schema.findings.url,
      title: schema.findings.title,
      excerpt: schema.findings.excerpt,
      metrics: schema.findings.metrics,
      isThreadComment: schema.findings.isThreadComment,
      status: schema.triage.status,
      lastAssessedAt: schema.assessments.createdAt,
      disqualified: schema.assessments.disqualified,
    })
    .from(schema.findings)
    .leftJoin(latest, eq(latest.findingId, schema.findings.id))
    .leftJoin(schema.assessments, eq(schema.assessments.id, latest.assessmentId))
    .leftJoin(schema.triage, eq(schema.triage.findingId, schema.findings.id))
    .where(eq(schema.findings.project, project))
    .all();

  return new Map(
    rows.map((row) => [
      row.url,
      {
        status: row.status ?? "new",
        lastAssessedAt: row.lastAssessedAt,
        disqualified: row.disqualified ?? false,
        title: row.title,
        excerpt: row.excerpt,
        metrics: row.metrics ?? null,
        isThreadComment: row.isThreadComment,
      },
    ]),
  );
}

/** Stored scans, newest first by id, which only increases, rather than by a clock that can move. */
export function recentRuns(options: { project?: string; limit?: number } = {}): schema.Run[] {
  const { project, limit = 10 } = options;
  return db
    .select()
    .from(schema.runs)
    .where(project ? eq(schema.runs.project, project) : undefined)
    .orderBy(desc(schema.runs.id))
    .limit(limit)
    .all();
}

/**
 * Project keys the database holds rows for, sorted.
 *
 * Retiring a profile keeps its findings, runs and triage (ADR-002), so a command
 * reading stored rows answers to this list as well as to the profiles. Runs
 * count too: a scan that found nothing still happened.
 */
export function storedProjects(): string[] {
  const rows = union(
    db.select({ project: schema.findings.project }).from(schema.findings),
    db.select({ project: schema.runs.project }).from(schema.runs),
  ).all();
  return rows.map((row) => row.project).sort();
}

export function draftsFor(findingId: number): schema.Draft[] {
  return db
    .select()
    .from(schema.drafts)
    .where(eq(schema.drafts.findingId, findingId))
    .orderBy(desc(schema.drafts.id))
    .all();
}

export { schema };
