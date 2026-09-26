/**
 * Database connection and the queries that span tables.
 *
 * `latestFindings` lives here rather than in each caller because "the current
 * state of a finding" is a join across all three tables plus a latest-assessment
 * predicate, and three callers reconstructing that independently would drift.
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { union } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";
import type { DismissalCategory, LatestScanMark, TriageStatus } from "../vocabulary";

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
  dismissalCategory: DismissalCategory | null;
  firstDecidedHidden: boolean | null;
}

interface FindingDetail extends FindingView {
  /** When the triage row was last written, for any reason. Null only without a row. */
  triageUpdatedAt: Date | null;
}

/**
 * A row of the ranked list. `drafts` is a count rather than the drafts
 * themselves: the list needs to show which findings have already been drafted,
 * and loading every body to answer that would be most of the database.
 */
export interface ListedFinding extends FindingView {
  drafts: number;
  /**
   * What the project's latest scan did to it, so a review can start with what
   * changed: `new` if that scan first stored it, `reassessed` if it wrote the
   * current verdict. Null for everything older, or with no scan recorded.
   */
  latestScan: LatestScanMark | null;
}

export interface ListOptions {
  project?: string;
  status?: TriageStatus[];
  /** Only these findings, e.g. a run's frozen inbox. */
  ids?: number[];
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

/**
 * Findings with their latest assessment and current triage status, unordered and
 * unbounded: the order is the score now, which is arithmetic over the clock, so
 * `rank` in pipeline/score.ts orders, filters and bounds them after the read.
 */
export function latestFindings(options: ListOptions = {}): ListedFinding[] {
  const { project, status, ids } = options;

  const latest = latestAssessmentIds(db);

  const filters = [
    project ? eq(schema.findings.project, project) : undefined,
    // The same fallback the rows below report, or a finding shown as `new` would
    // be excluded by `--status new`.
    status?.length
      ? inArray(sql<TriageStatus>`coalesce(${schema.triage.status}, 'new')`, status)
      : undefined,
    ids ? inArray(schema.findings.id, ids) : undefined,
  ].filter((f) => f !== undefined);

  const rows = db
    .select({
      finding: schema.findings,
      assessment: schema.assessments,
      status: schema.triage.status,
      note: schema.triage.note,
      dismissalCategory: schema.triage.dismissalCategory,
      firstDecidedHidden: schema.triage.firstDecidedHidden,
      drafts: sql<number>`(select count(*) from ${schema.drafts} where ${schema.drafts.findingId} = ${schema.findings.id})`,
    })
    .from(schema.findings)
    .leftJoin(latest, eq(latest.findingId, schema.findings.id))
    .leftJoin(schema.assessments, eq(schema.assessments.id, latest.assessmentId))
    .leftJoin(schema.triage, eq(schema.triage.findingId, schema.findings.id))
    .where(filters.length ? and(...filters) : undefined)
    .all();

  const latestRuns = new Map(latestRunPerProject().map((run) => [run.project, run]));
  return rows.map((row) => ({
    finding: row.finding,
    assessment: row.assessment,
    latestScan: latestScanMark(row.finding, row.assessment, latestRuns.get(row.finding.project)),
    // A finding always gets a triage row on insert; the fallback covers a row
    // written before that invariant existed rather than a normal path.
    status: row.status ?? "new",
    note: row.note ?? null,
    dismissalCategory: row.dismissalCategory ?? null,
    firstDecidedHidden: row.firstDecidedHidden ?? null,
    drafts: row.drafts,
  }));
}

/**
 * By run id on both sides, never by time: timestamps share a second, and scans
 * of one project can overlap. A verdict recorded before assessments named their
 * run is never marked, which undercounts rather than guesses.
 */
export function latestScanMark(
  finding: Pick<schema.Finding, "firstRunId">,
  assessment: Pick<schema.Assessment, "runId"> | null,
  run: Pick<schema.Run, "id"> | undefined,
): LatestScanMark | null {
  if (!run) return null;
  if (finding.firstRunId === run.id) return "new";
  if (assessment?.runId === run.id) return "reassessed";
  return null;
}

/**
 * One statement, so the snapshot and the verdict are read from one database
 * snapshot: a scan writes both in one transaction, and separate reads could pair
 * the old snapshot with the new verdict.
 */
export function findingById(id: number): FindingDetail | undefined {
  const latest = latestAssessmentIds(db);
  const row = db
    .select({
      finding: schema.findings,
      assessment: schema.assessments,
      status: schema.triage.status,
      triageUpdatedAt: schema.triage.updatedAt,
      note: schema.triage.note,
      dismissalCategory: schema.triage.dismissalCategory,
      firstDecidedHidden: schema.triage.firstDecidedHidden,
    })
    .from(schema.findings)
    .leftJoin(latest, eq(latest.findingId, schema.findings.id))
    .leftJoin(schema.assessments, eq(schema.assessments.id, latest.assessmentId))
    .leftJoin(schema.triage, eq(schema.triage.findingId, schema.findings.id))
    .where(eq(schema.findings.id, id))
    .get();
  if (!row) return undefined;

  return {
    finding: row.finding,
    assessment: row.assessment,
    status: row.status ?? "new",
    triageUpdatedAt: row.triageUpdatedAt ?? null,
    note: row.note ?? null,
    dismissalCategory: row.dismissalCategory ?? null,
    firstDecidedHidden: row.firstDecidedHidden ?? null,
  };
}

/**
 * A finding's assessments older than `beforeAssessmentId`, newest first. Bounded by the
 * current verdict's id so one a scan writes after it was read is never filed as
 * earlier.
 */
export function earlierAssessments(
  findingId: number,
  beforeAssessmentId: number,
): schema.Assessment[] {
  return db
    .select()
    .from(schema.assessments)
    .where(
      and(
        eq(schema.assessments.findingId, findingId),
        lt(schema.assessments.id, beforeAssessmentId),
      ),
    )
    .orderBy(desc(schema.assessments.id))
    .all();
}

export interface TriageChange {
  status: TriageStatus;
  /** A string replaces the stored note, `null` clears it, omitted leaves it alone. */
  note?: string | null;
  /**
   * A line added to the end of the stored note, in the same statement that reads
   * it, so an edit saved since the caller last saw the note is kept. Exclusive
   * with `note`.
   */
  appendNote?: string;
  /**
   * The same three states, while the status is `dismissed`. Any other status
   * clears it: a category describes a dismissal, and one surviving a reopening
   * would be counted as a cause for a finding nobody dismissed. Given with
   * another status it is refused, so no front end can store it.
   */
  category?: DismissalCategory | null;
  /**
   * Whether the model's judgment was hidden while this was decided. Recorded
   * only on a finding's first decision out of `new`; omitted means it was shown,
   * which is true of the CLI, whose `list` and `show` print the reason.
   */
  hidden?: boolean;
  /**
   * An amendment to the decision already stored — a dismissal's category, a line
   * after `acted` — rather than a new one: written only while the stored status
   * is still `status`, since another front end may have changed it meanwhile.
   * Throws `DecisionChanged` otherwise, having written nothing.
   */
  amend?: boolean;
}

/** An amendment found its decision already changed by someone else. */
export class DecisionChanged extends Error {
  constructor(findingId: number, expected: TriageStatus, found: TriageStatus | undefined) {
    super(`#${findingId} is ${found ?? "new"} now, not ${expected}; nothing was changed.`);
    this.name = "DecisionChanged";
  }
}

/**
 * The operator's decision. Omitted fields are left as stored — Drizzle drops an
 * undefined column from the update — which is what lets `obserf triage <id>
 * shortlisted` change a status without erasing the reasoning written against it.
 *
 * Returns the decision this replaced — status and dismissal category — so a
 * caller can report the change or undo it whole; undoing a keystroke that moved
 * a `paid` dismissal must not come back as a dismissal with no cause. Undefined
 * when there was no triage row. The read and the write are separate statements,
 * so another process can change the row between them.
 */
export function setTriage(
  findingId: number,
  change: TriageChange,
): { status: TriageStatus; category: DismissalCategory | null } | undefined {
  const { status, note, appendNote, category, hidden = false, amend = false } = change;
  if (note !== undefined && appendNote !== undefined) {
    throw new Error("Pass a note or a line to append to it, not both.");
  }
  if (category && status !== "dismissed") {
    throw new Error(`A dismissal category needs status "dismissed", not "${status}".`);
  }

  const previous = db
    .select({
      status: schema.triage.status,
      dismissalCategory: schema.triage.dismissalCategory,
    })
    .from(schema.triage)
    .where(eq(schema.triage.findingId, findingId))
    .get();

  const values = {
    status,
    note,
    dismissalCategory: status === "dismissed" ? category : null,
    updatedAt: new Date(),
  };
  // Whether this is the first decision out of `new` is judged against the row
  // as the update finds it, not as it was read above: two writers deciding at
  // once (the CLI and the inbox) would otherwise both see `new` and the second
  // would overwrite what the first recorded. SQLite evaluates every SET
  // expression against the pre-update row.
  const firstDecidedHidden =
    status === "new"
      ? {}
      : {
          firstDecidedHidden: sql`case when ${schema.triage.status} = 'new'
                    and ${schema.triage.firstDecidedHidden} is null
                    then ${hidden ? 1 : 0} else ${schema.triage.firstDecidedHidden} end`,
        };
  const appended =
    appendNote === undefined
      ? {}
      : {
          note: sql`case when coalesce(${schema.triage.note}, '') = '' then ${appendNote}
                    else ${schema.triage.note} || char(10) || ${appendNote} end`,
        };
  if (amend) {
    // Conditional in the statement, not on the read above, which another
    // writer can have made stale.
    const amended = db
      .update(schema.triage)
      .set({ ...values, ...appended })
      .where(and(eq(schema.triage.findingId, findingId), eq(schema.triage.status, status)))
      .returning({ findingId: schema.triage.findingId })
      .get();
    if (!amended) throw new DecisionChanged(findingId, status, previous?.status);
    return previous && { status: previous.status, category: previous.dismissalCategory };
  }

  db.insert(schema.triage)
    .values({
      findingId,
      ...values,
      ...(appendNote === undefined ? {} : { note: appendNote }),
      // No row yet means no decision yet, so this one is the first.
      ...(status === "new" ? {} : { firstDecidedHidden: hidden }),
    })
    .onConflictDoUpdate({
      target: schema.triage.findingId,
      set: { ...values, ...appended, ...firstDecidedHidden },
    })
    .run();

  return previous && { status: previous.status, category: previous.dismissalCategory };
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

export function assessmentsByIds(ids: number[]): schema.Assessment[] {
  if (!ids.length) return [];
  return db.select().from(schema.assessments).where(inArray(schema.assessments.id, ids)).all();
}

export function runById(id: number): schema.Run | undefined {
  return db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
}

/**
 * Where the run record stands, in two numbers that only grow until a backup is
 * restored: the newest run's id, raised when a scan starts, and how many runs
 * have finished. One marker covering another in both means nothing was recorded
 * that it lacks. The inbox reads it with its list, to tell whether a scan has
 * landed since.
 */
export function runsMarker(project?: string): { lastRun: number; finished: number } {
  const [row] = db
    .select({
      lastRun: sql<number>`coalesce(max(${schema.runs.id}), 0)`,
      finished: sql<number>`count(${schema.runs.finishedAt})`,
    })
    .from(schema.runs)
    .where(project ? eq(schema.runs.project, project) : undefined)
    .all();
  return row ?? { lastRun: 0, finished: 0 };
}

/**
 * The most recent scan of each project, newest first. By id, as in `recentRuns`:
 * timestamps can tie at a stored second, or go back.
 */
export function latestRunPerProject(): schema.Run[] {
  const newest = db
    .select({ id: sql<number>`max(${schema.runs.id})` })
    .from(schema.runs)
    .groupBy(schema.runs.project);

  return db
    .select()
    .from(schema.runs)
    .where(inArray(schema.runs.id, newest))
    .orderBy(desc(schema.runs.id))
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

/**
 * What the database holds for a project, or for all of them — for an empty list:
 * no run rows, run rows but no findings, or findings excluded by filters.
 */
export function storedCounts(project?: string): { findings: number; runs: number } {
  const findings = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.findings)
    .where(project ? eq(schema.findings.project, project) : undefined)
    .get();
  const runs = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.runs)
    .where(project ? eq(schema.runs.project, project) : undefined)
    .get();
  return { findings: findings?.n ?? 0, runs: runs?.n ?? 0 };
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
