import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { getTableName, is } from "drizzle-orm";
import { SQLiteColumn, SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../db/schema";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function database(): Database {
  const dir = mkdtempSync(join(tmpdir(), "obserf-db-"));
  dirs.push(dir);
  return new Database(join(dir, "obserf.db"), { readwrite: true, create: true });
}

const tables = (db: Database) =>
  (
    db
      .query(
        // Escaped: `_` is a wildcard, and a test that hid `sqliteCache` from
        // itself could not tell whether the code under test hid it too.
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      )
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .sort();

// Application tables are covered by the schema parity test below; the migrator
// creates this bookkeeping table independently.
test("an empty file gets the migrator's own bookkeeping", () => {
  const db = database();
  migrate(db);
  expect(tables(db)).toContain("obserf_migrations");
});

// Every command opens the database, so this runs far more often than it does work.
test("applying again does nothing", () => {
  const db = database();
  migrate(db);
  const before = db.query("SELECT name, applied_at FROM obserf_migrations").all();
  migrate(db);
  expect(db.query("SELECT name, applied_at FROM obserf_migrations").all()).toEqual(before);
});

// The operator's decisions and notes are the part of this database that cannot
// be re-derived by scanning again.
test("data written before a migration survives one", () => {
  const db = database();
  migrate(db);
  db.exec(
    `INSERT INTO findings (project, source_id, url, title, venue, discovered_at)
     VALUES ('p', 's', 'https://e.com/1', 't', 'v', 0)`,
  );
  db.exec("INSERT INTO triage (finding_id, status) VALUES (1, 'shortlisted')");
  migrate(db);
  expect(db.query("SELECT status FROM triage WHERE finding_id = 1").get()).toEqual({
    status: "shortlisted",
  });
});

// An older engine writing through a newer schema corrupts quietly rather than
// failing, so this is the one case that must not be a warning.
test("a database from a newer Obserf is refused", () => {
  const db = database();
  migrate(db);
  db.exec(
    "INSERT INTO obserf_migrations (name, hash, applied_at) VALUES ('9999_future.sql', 'x', 0)",
  );
  expect(() => migrate(db)).toThrow(/written by a newer Obserf \(9999_future\.sql\)/);
});

// `OBSERF_DB` can name any file. Rejecting it is only half the requirement: the
// database Obserf was told to leave alone has to come back unchanged, which
// means not even the migration table may be created on the way to the error.
test("a database that is not Obserf's is refused without being written to", () => {
  const db = database();
  db.exec("CREATE TABLE something_else (id INTEGER PRIMARY KEY)");
  expect(() => migrate(db)).toThrow(/already holds something, and no Obserf migration/);
  expect(tables(db)).toEqual(["something_else"]);
});

// The state an earlier version of this migrator left behind in foreign databases
// before rejecting them: its marker, with nothing recorded in it. Ownership is
// the history, not the table's name.
test("an empty migration table is not proof the database is Obserf's", () => {
  const db = database();
  db.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY)");
  db.exec(
    "CREATE TABLE obserf_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  expect(() => migrate(db)).toThrow(/already holds something, and no Obserf migration/);
  expect(tables(db)).toEqual(["customers", "obserf_migrations"]);
});

// A view makes a database someone else's just as a table does. The promise is to
// leave a foreign file alone, not to leave foreign tables alone.
test("a database holding only a view is still not Obserf's to write to", () => {
  const db = database();
  db.exec("CREATE VIEW customers AS SELECT 1 AS id");
  expect(() => migrate(db)).toThrow(/already holds something, and no Obserf migration/);
  expect(tables(db)).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_master").all()).toEqual([{ name: "customers" }]);
});

// `_` is a single-character wildcard in LIKE, so a naive `sqlite_%` exclusion
// also skips user tables like this one, and the database would look empty.
test("a table whose name only resembles SQLite's reserved prefix still counts", () => {
  const db = database();
  db.exec("CREATE TABLE sqliteCache (id INTEGER PRIMARY KEY)");
  expect(() => migrate(db)).toThrow(/already holds something, and no Obserf migration/);
  expect(tables(db)).toEqual(["sqliteCache"]);
});

// Normal operation cannot produce a gap, so this guards against a hand-edited
// database and against a new migration whose name sorts before a published one.
test("a migration history with a gap is refused rather than applied out of order", () => {
  const db = database();
  const dir = mkdtempSync(join(tmpdir(), "obserf-mig-"));
  dirs.push(dir);
  for (const name of ["0000_a.sql", "0001_b.sql", "0002_c.sql"]) {
    writeFileSync(join(dir, name), `CREATE TABLE t_${name.slice(0, 4)} (id INTEGER PRIMARY KEY);`);
  }
  migrate(db, dir);
  db.exec("DELETE FROM obserf_migrations WHERE name = '0001_b.sql'");

  expect(() => migrate(db, dir)).toThrow(/migration history is not a prefix/);
});

// "Every migration applied" is vacuously true of none, so without this a broken
// installation would create a database recording that it had been migrated,
// hold nothing, and look complete on every open afterwards.
test("an installation with no migrations fails instead of creating an empty database", () => {
  const db = database();
  const dir = mkdtempSync(join(tmpdir(), "obserf-none-"));
  dirs.push(dir);
  expect(() => migrate(db, dir)).toThrow(/installation is incomplete/);
  expect(db.query("SELECT name FROM sqlite_master").all()).toEqual([]);
});

// The documentation tells maintainers a published migration is immutable. This
// is what makes that enforceable rather than a hope.
test("a migration whose SQL changed after it was applied is refused", () => {
  const db = database();
  const dir = mkdtempSync(join(tmpdir(), "obserf-mig-"));
  dirs.push(dir);
  writeFileSync(join(dir, "0000_initial.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");
  migrate(db, dir);

  writeFileSync(join(dir, "0000_initial.sql"), "CREATE TABLE b (id INTEGER PRIMARY KEY);");
  expect(() => migrate(db, dir)).toThrow(/0000_initial\.sql has changed since this database/);
});

// drizzle-kit renders most schema changes as a table rebuild: create a copy,
// move the rows, drop the original. With foreign keys enforced, dropping
// `findings` cascades into every assessment, draft and triage row that pointed
// at it — and `PRAGMA foreign_keys = OFF` inside a transaction is silently
// ignored, so the migration's own guard does not save it.
test("a table rebuild does not cascade away the rows that referenced it", () => {
  const db = database();
  db.exec("PRAGMA foreign_keys = ON");

  // The engine's real 0000, so this exercises the schema that actually ships,
  // plus a rebuild of `findings` in the shape drizzle-kit generates one.
  const dir = mkdtempSync(join(tmpdir(), "obserf-mig-"));
  dirs.push(dir);
  copyFileSync(
    join(import.meta.dir, "..", "drizzle", "0000_initial.sql"),
    join(dir, "0000_initial.sql"),
  );
  migrate(db, dir);

  db.exec(
    `INSERT INTO findings (project, source_id, url, title, venue, discovered_at)
     VALUES ('p', 's', 'https://e.com/1', 't', 'v', 0)`,
  );
  db.exec("INSERT INTO triage (finding_id, status, note) VALUES (1, 'shortlisted', 'keep me')");

  writeFileSync(
    join(dir, "0001_rebuild.sql"),
    `PRAGMA foreign_keys=OFF;--> statement-breakpoint
     CREATE TABLE __new_findings (
       id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
       project text NOT NULL, source_id text NOT NULL, url text NOT NULL,
       title text NOT NULL, excerpt text DEFAULT '' NOT NULL, author text,
       venue text NOT NULL, published_at integer, metrics text,
       is_thread_comment integer, repository text,
       discovered_at integer NOT NULL, first_run_id integer, raw text
     );--> statement-breakpoint
     INSERT INTO __new_findings SELECT id, project, source_id, url, title, excerpt,
       author, venue, published_at, metrics, is_thread_comment, repository,
       discovered_at, first_run_id, raw
       FROM findings;--> statement-breakpoint
     DROP TABLE findings;--> statement-breakpoint
     ALTER TABLE __new_findings RENAME TO findings;--> statement-breakpoint
     PRAGMA foreign_keys=ON;`,
  );
  migrate(db, dir);

  expect(db.query("SELECT note FROM triage WHERE finding_id = 1").get()).toEqual({
    note: "keep me",
  });
  expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
});

// Migration generation is manual, so compare a freshly migrated database with
// the declared schema. Discovering tables from the module also covers additions
// without maintaining a second table list here.
test("the shipped migrations build the tables, columns, keys and indexes the engine declares", () => {
  const db = database();
  migrate(db);

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  // Two keys may leave the same column, so ties fall through the rest of the
  // constraint rather than to whichever order each side happened to produce.
  type ForeignKey = { column: string; references: string; onDelete: string; onUpdate: string };
  const byForeignKey = (a: ForeignKey, b: ForeignKey) =>
    a.column.localeCompare(b.column) ||
    a.references.localeCompare(b.references) ||
    a.onDelete.localeCompare(b.onDelete) ||
    a.onUpdate.localeCompare(b.onUpdate);
  // Predicates and expressions need exact comparisons; reject them until this
  // test knows how, rather than reporting a false match.
  const unsupported = (name: string, what: string): never => {
    throw new Error(`${name} ${what} — extend this comparison before using one`);
  };
  const declared: string[] = [];

  for (const [exported, table] of Object.entries(schema)) {
    if (!is(table, SQLiteTable)) continue;
    const config = getTableConfig(table);
    declared.push(config.name);

    // Every PRAGMA is also a table-valued function, so the table name binds as
    // data — no identifier quoting to get right, now or for a future name.
    // `table_xinfo` over `table_info` because the latter omits generated and
    // hidden columns, which would read as a migration that forgot one.
    const columns = db.query("SELECT * FROM pragma_table_xinfo(?)").all(config.name) as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    // `origin` is `c` for a CREATE INDEX, `u` or `pk` for the index SQLite
    // builds behind a constraint — the same fact as the constraint, counted
    // twice, and named after an internal convention this need not know.
    const indexes = db
      .query("SELECT name, \"unique\", partial FROM pragma_index_list(?) WHERE origin = 'c'")
      .all(config.name) as Array<{ name: string; unique: number; partial: number }>;
    for (const row of indexes) {
      if (row.partial) unsupported(row.name, "is a partial index");
    }
    for (const index of config.indexes) {
      if (index.config.where) unsupported(index.config.name, "is a partial index");
    }
    // `seq` numbers the columns within one key, so anything past the first says
    // the key is composite — which flattening to a column apiece would compare
    // as separate constraints, and SQLite does not enforce them that way.
    const keys = db.query("SELECT * FROM pragma_foreign_key_list(?)").all(config.name) as Array<{
      table: string;
      from: string;
      to: string;
      seq: number;
      on_update: string;
      on_delete: string;
    }>;
    for (const key of keys) {
      if (key.seq > 0) unsupported(key.from, "is part of a composite foreign key");
    }
    for (const key of config.foreignKeys) {
      if (key.reference().columns.length > 1) {
        unsupported(key.getName(), "is a composite foreign key");
      }
    }

    const built = {
      columns: columns
        .map((c) => ({ name: c.name, type: c.type.toLowerCase(), notNull: c.notnull === 1 }))
        .sort(byName),
      // `pk` is the 1-based position within the key, so this reads a composite
      // one in its declared order rather than alphabetically.
      primaryKey: columns
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
      indexes: indexes
        .map((row) => ({
          name: row.name,
          unique: row.unique === 1,
          // Index identity includes its columns in declared order, not just its
          // name and UNIQUE bit.
          columns: (
            db
              .query("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
              .all(row.name) as Array<{
              name: string | null;
            }>
          ).map((c) => c.name ?? unsupported(row.name, "indexes an expression")),
        }))
        .sort(byName),
      // `PRAGMA foreign_key_check` cannot see a constraint that is missing —
      // there is nothing left to violate — so the rebuild that drops one is
      // caught here or not at all.
      foreignKeys: keys
        .map((k) => ({
          column: k.from,
          references: `${k.table}.${k.to}`,
          onDelete: k.on_delete.toLowerCase(),
          onUpdate: k.on_update.toLowerCase(),
        }))
        .sort(byForeignKey),
    };

    expect({ [exported]: built }).toEqual({
      [exported]: {
        columns: config.columns
          .map((c) => ({ name: c.name, type: c.getSQLType().toLowerCase(), notNull: c.notNull }))
          .sort(byName),
        primaryKey: (config.primaryKeys[0]?.columns ?? config.columns.filter((c) => c.primary)).map(
          (c) => c.name,
        ),
        indexes: config.indexes
          .map((index) => ({
            name: index.config.name,
            unique: index.config.unique,
            columns: index.config.columns.map((c) =>
              is(c, SQLiteColumn)
                ? c.name
                : unsupported(index.config.name, "indexes an expression"),
            ),
          }))
          .sort(byName),
        foreignKeys: config.foreignKeys
          .map((key) => {
            const ref = key.reference();
            return {
              column: ref.columns[0]!.name,
              references: `${getTableName(ref.foreignTable)}.${ref.foreignColumns[0]!.name}`,
              onDelete: key.onDelete ?? "no action",
              onUpdate: key.onUpdate ?? "no action",
            };
          })
          .sort(byForeignKey),
      },
    });
  }

  // The loop visits what `db/schema.ts` declares, so a table dropped from it
  // would simply not be looked at; the physical list is what notices. The
  // migrator's own bookkeeping is not part of the schema it applies.
  expect(tables(db).filter((name) => name !== "obserf_migrations")).toEqual(declared.sort());
});
