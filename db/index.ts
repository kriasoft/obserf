/**
 * Database connection and the queries that span tables.
 *
 * `latestFindings` lives here rather than in each caller because "the current
 * state of a finding" is a join across all three tables plus a latest-assessment
 * predicate, and three callers reconstructing that independently would drift.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
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

import { databasePath, requireCreatableDatabase, requireWorkspace } from "../workspace";
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

/** Findings with their latest assessment and current triage status, best first. */
export function latestFindings(options: ListOptions = {}): ListedFinding[] {
  const { project, status, minScore, limit = 50 } = options;

  // Append-only assessments mean max(id) is the newest without a tie-break on time.
  const latest = db
    .select({
      findingId: schema.assessments.findingId,
      assessmentId: sql<number>`max(${schema.assessments.id})`.as("assessment_id"),
    })
    .from(schema.assessments)
    .groupBy(schema.assessments.findingId)
    .as("latest");

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
  // Append-only assessments mean max(id) is the newest, as in `latestFindings`.
  const latest = db
    .select({
      findingId: schema.assessments.findingId,
      assessmentId: sql<number>`max(${schema.assessments.id})`.as("assessment_id"),
    })
    .from(schema.assessments)
    .groupBy(schema.assessments.findingId)
    .as("latest");

  const rows = db
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

/**
 * Same as `knownFindings`, through a separate read-only connection: no WAL
 * switch or schema changes. This is what `scan --dry-run` uses so it can report
 * history-aware counts without database writes.
 *
 * Returns an empty map when there is no database, or when the file predates the
 * schema: for a dry run, an unreadable history means "nothing known", which
 * over-reports new candidates rather than hiding them.
 */
export function knownFindingsReadOnly(project: string): Map<string, KnownFindingState> {
  if (!existsSync(databasePath)) return new Map();
  let handle: Database | undefined;
  try {
    handle = new Database(databasePath, { readonly: true });
    const rows = handle
      .query(
        `SELECT f.url, f.title, f.excerpt, f.metrics, f.is_thread_comment,
                COALESCE(t.status, 'new') AS status,
                a.created_at AS last_assessed_at,
                a.disqualified AS disqualified
           FROM findings f
           LEFT JOIN triage t ON t.finding_id = f.id
           LEFT JOIN assessments a
                  ON a.id = (SELECT max(id) FROM assessments WHERE finding_id = f.id)
          WHERE f.project = ?`,
      )
      .all(project) as Array<{
      url: string;
      title: string;
      excerpt: string;
      metrics: string | null;
      is_thread_comment: number | null;
      status: TriageStatus;
      last_assessed_at: number | null;
      disqualified: number | null;
    }>;
    return new Map(
      rows.map((row) => [
        row.url,
        {
          status: row.status,
          // Raw SQLite, so timestamps and booleans arrive unhydrated.
          lastAssessedAt: row.last_assessed_at ? new Date(row.last_assessed_at * 1000) : null,
          disqualified: row.disqualified === 1,
          title: row.title,
          excerpt: row.excerpt,
          metrics: row.metrics ? (JSON.parse(row.metrics) as schema.Finding["metrics"]) : null,
          isThreadComment: row.is_thread_comment === null ? null : row.is_thread_comment === 1,
        },
      ]),
    );
  } catch {
    return new Map();
  } finally {
    handle?.close();
  }
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
