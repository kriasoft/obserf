/**
 * Bringing a database up to the schema the running engine expects.
 *
 * The engine owns this, not the operator: a workspace created by `obserf init`
 * has to work without a source checkout, and someone who upgraded the package
 * should not have to know that `db/schema.ts` exists. Migrations are generated
 * from that schema by `bun run db:generate` (a maintainer command), committed,
 * and shipped with the package; every writable open applies whatever is pending.
 * See docs/adr/011-the-engine-owns-the-schema.md.
 *
 * Not drizzle-orm's own migrator, for two reasons this needs and it does not
 * have: it reads the applied list *outside* the transaction it then writes in,
 * so two Obserf processes starting together can both decide to apply; and it
 * ignores a database carrying migrations the engine has never heard of, which is
 * an older engine about to write through a newer schema.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { backup } from "./backup";

/** Ships with the package; `db:generate` writes into it. */
const DIRECTORY = join(import.meta.dir, "..", "drizzle");

/** Ours, not `__drizzle_migrations`: the runtime contract is this file's, not drizzle-kit's. */
const TABLE = "obserf_migrations";

/** Long enough for another Obserf's migration, short enough to not look hung. */
const LOCK_WAIT_MS = 10_000;

/**
 * Applies every migration this database has not seen, inside one exclusive
 * transaction so that a second process starting at the same moment waits and
 * then finds nothing to do.
 *
 * Snapshots first, unless the database is new — there is a way back from a
 * failed upgrade, and it is the one `obserf restore` uses.
 *
 * `directory` is a parameter so that a test can apply migrations of its own; in
 * the application it is always the one shipped with the package. Its files are
 * read once, so the hashes checked are the bytes that get applied.
 */
export function migrate(db: Database, directory: string = DIRECTORY): void {
  // Filenames carry their order in a numeric prefix, which is why they sort.
  const files = new Map(
    (existsSync(directory) ? readdirSync(directory) : [])
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  );

  // An installation missing its migrations would otherwise create a database
  // holding nothing but the record of having been migrated — and the next open
  // would find it complete, because "every migration applied" is vacuously true
  // of none. The first real query is where it would surface, as `no such table:
  // findings`, which says nothing about the cause. The package ships these files
  // by an explicit whitelist that fails closed; this is the same idea at runtime.
  if (!files.size) {
    throw new Error(
      `No migrations in ${directory}. This Obserf installation is incomplete — reinstall the package.`,
    );
  }

  // Twice at most. A pass decides outside the lock whether there is anything to
  // lose, and gives up if the lock proves that decision wrong — which happens
  // only when another Obserf initialized this database in between, turning "new,
  // nothing to snapshot" into "has data, snapshot first". The second pass starts
  // from the state that produced.
  for (let pass = 0; pass < 2; pass++) if (attempt(db, files)) return;
  throw new Error(
    `Could not settle ${db.filename}'s migration state — another Obserf may be initializing it.`,
  );
}

/**
 * One try. Returns false, having changed nothing, when the state it decided
 * against turned out to be stale by the time it held the lock.
 *
 * Nothing is written before the database is known to be one Obserf may write to.
 * `OBSERF_DB` can name any file, and creating the migration table in someone's
 * unrelated database on the way to rejecting it is a change to data this program
 * was told to leave alone. With no migration table there is also nothing to
 * lose, so that whole decision — is this ours, and what does it need — happens
 * under the lock; the pass outside exists only to avoid taking a lock and a
 * snapshot in the ordinary case of a database that is already up to date.
 */
function attempt(db: Database, files: Map<string, string>): boolean {
  let snapshotted = false;
  if (recorded(db)) {
    const seen = applied(db);
    assertCompatible(seen, files);
    if ([...files.keys()].every((name) => seen.has(name))) return true;

    // Only when there is history to lose. `VACUUM INTO` needs its own read of
    // the file, so it happens before the lock; a snapshot that cannot be written
    // stops the upgrade rather than letting it proceed without a way back.
    if (seen.size) {
      const snapshot = backup(db.filename, "upgrade");
      if (snapshot) console.error(`Upgrading the database. Snapshot → ${snapshot}`);
      snapshotted = true;
    }
  }

  // Both pragmas have to be set before the transaction opens. `foreign_keys` is
  // a no-op inside one, and drizzle-kit renders many schema changes as a table
  // rebuild — create, copy, `DROP TABLE` the original — which with enforcement
  // on cascades into every row that referenced it. `foreign_key_check` below is
  // what replaces the enforcement for the duration.
  const enforcing = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number })
    .foreign_keys;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    // Without a timeout SQLite fails a contended lock immediately instead of
    // waiting for it, which would make a second Obserf starting at the same
    // moment an error rather than a pause.
    db.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}`);
    db.exec("BEGIN EXCLUSIVE");
    try {
      // Everything above was read outside the lock, and another Obserf may have
      // committed since — including the initialization this is about to do.
      const existing = recorded(db);
      const done = existing ? applied(db) : new Map<string, string>();

      // What makes a database Obserf's is its migration history, not a table
      // with a familiar name: no applied migrations means no other tables. That
      // covers the absent table and the present-but-empty one, which a
      // successful initialization cannot produce — the table and `0000` commit
      // together — but which an earlier version of this migrator left behind in
      // foreign databases before rejecting them.
      if (!done.size && occupied(db)) {
        throw new Error(
          `${db.filename} already holds something, and no Obserf migration has been applied to it, so it is not a database Obserf can upgrade.`,
        );
      }
      if (!existing) {
        db.exec(
          `CREATE TABLE ${TABLE} (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
        );
      }

      assertCompatible(done, files);
      const pending = [...files].filter(([name]) => !done.has(name));

      // This pass skipped the snapshot because the database had no history to
      // lose. It has one now, so the migrations left are an upgrade of someone's
      // data, and an upgrade takes a snapshot first. Start over from what is
      // actually there rather than proceed without one.
      if (!snapshotted && done.size && pending.length) {
        db.exec("ROLLBACK");
        return false;
      }

      for (const [name, sql] of pending) {
        // `--> statement-breakpoint` is how drizzle-kit separates statements. It
        // is a comment to SQLite, so splitting on it is the only parsing needed.
        for (const statement of sql.split("--> statement-breakpoint")) {
          if (statement.trim()) db.exec(statement);
        }
        db.query(`INSERT INTO ${TABLE} (name, hash, applied_at) VALUES (?, ?, ?)`).run(
          name,
          digest(sql),
          Date.now(),
        );
      }
      const dangling = db.query("PRAGMA foreign_key_check").all();
      if (dangling.length) {
        throw new Error(
          `Migration left ${dangling.length} row(s) referencing something that no longer exists.`,
        );
      }
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    if (enforcing) db.exec("PRAGMA foreign_keys = ON");
  }
}

/** Whether this database has ever been through this migrator. */
function recorded(db: Database): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE) !== null
  );
}

/**
 * Whether this engine may write to a database that has applied `seen`. Pure, and
 * run twice: once to decide whether the work is worth a lock and a snapshot,
 * once under the lock, where the answer is authoritative.
 */
function assertCompatible(seen: Map<string, string>, files: Map<string, string>): void {
  // A database that has been through migrations this engine does not ship came
  // from a newer Obserf. Its schema is ahead of the code about to write to it,
  // and applying the gap backwards is not a thing that exists.
  const unknown = [...seen.keys()].filter((name) => !files.has(name));
  if (unknown.length) {
    throw new Error(
      `This database was written by a newer Obserf (${unknown.join(", ")}). Upgrade the package.`,
    );
  }

  // A migration is a piece of SQL, not a filename. Two databases both recording
  // `0001_change.sql` can hold different schemas if that file was ever edited or
  // regenerated, and nothing downstream would notice — the names line up, so the
  // migrator declares the work done and the queries then fail somewhere else, or
  // do not fail at all. The documentation tells maintainers not to do this; the
  // hash is what makes the instruction enforceable.
  for (const [name, hash] of seen) {
    const sql = files.get(name);
    if (sql !== undefined && digest(sql) !== hash) {
      throw new Error(
        `${name} has changed since this database applied it, so their schemas may differ. ` +
          `A published migration is immutable — add a new one instead of editing it.`,
      );
    }
  }

  // The invariant is not "everything applied is one of ours" but "what was
  // applied is exactly the first N of ours, in order". A gap in the middle would
  // otherwise be filled by running the missing migration *after* the ones that
  // follow it, and a new file whose name sorts before a published one would be
  // applied to databases that are already past it. Normal operation cannot
  // reach either state, which is why this is a guard rather than a code path.
  const expected = [...files.keys()].slice(0, seen.size);
  if (expected.length !== seen.size || expected.some((name) => !seen.has(name))) {
    throw new Error(
      `This database's migration history is not a prefix of this Obserf's: it applied ` +
        `${[...seen.keys()].join(", ")} where ${expected.join(", ") || "nothing"} was expected.`,
    );
  }
}

const digest = (sql: string) => new Bun.CryptoHasher("sha256").update(sql).digest("hex");

/** What this database has already applied, and the SQL it applied for each. */
function applied(db: Database): Map<string, string> {
  const rows = db.query(`SELECT name, hash FROM ${TABLE}`).all() as {
    name: string;
    hash: string;
  }[];
  return new Map(rows.map((row) => [row.name, row.hash]));
}

/**
 * Any schema object of someone else's — a view or a trigger makes a database
 * just as much not-ours as a table does, and Obserf's promise is to leave a
 * foreign file alone, not to leave foreign *tables* alone. SQLite's own objects
 * are excluded, which covers the index it creates for the migration table's key.
 */
function occupied(db: Database): boolean {
  return (
    db
      .query(
        // The underscore is escaped: unescaped it is a single-character
        // wildcard, so `sqlite_%` also matches a user table named `sqliteCache`
        // — and a database holding only such tables would look unoccupied.
        `SELECT 1 FROM sqlite_master
          WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name != ? LIMIT 1`,
      )
      .get(TABLE) !== null
  );
}
