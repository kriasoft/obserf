/**
 * Snapshots of the database file, and the way back from one.
 *
 * Migrations are forward-only, so the way back from an upgrade that did the
 * wrong thing is the state before it. `db/migrate.ts` takes a snapshot before it
 * applies anything, which is what makes that recoverable rather than a story
 * about backups the operator was supposed to have made.
 *
 *   obserf backup            snapshot now
 *   obserf backups           list this database's snapshots
 *   obserf restore [file]    replace the database with one (newest by default)
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { backupsDir, databasePath, requireCreatableDatabase } from "../workspace";

/**
 * Snapshots are named for the database they came from, because one directory
 * holds snapshots of every database a workspace has pointed at: they stay in the
 * workspace while `OBSERF_DB` can move anywhere.
 *
 * Keyed by the database's absolute path, not its name. `/a/obserf.db` and
 * `/b/obserf.db` are different databases with the same filename, and `restore`
 * overwrites, so which one a snapshot belongs to cannot rest on the name alone.
 * The filename is kept so a human can read the directory; the hash is what makes
 * it an identity.
 *
 * Truncated to 32 bits, which for the two or three database paths one operator
 * ever has makes a mix-up negligible rather than impossible — and it is not the
 * only thing standing between a wrong path and a lost database: `restore` reads
 * the source before it writes, and snapshots what it replaces.
 */
function prefixFor(path: string): string {
  const key = new Bun.CryptoHasher("sha256").update(path).digest("hex").slice(0, 8);
  return `${basename(path)}.${key}.`;
}

/**
 * Returns the snapshot's path, or null when there is no database yet — a fresh
 * workspace has nothing to lose.
 *
 * `VACUUM INTO` rather than a file copy: it is SQLite's own online backup, so it
 * writes a consistent snapshot that includes whatever is still in the WAL.
 * Copying `obserf.db` alone would silently drop the most recent writes.
 */
export function backup(path: string = databasePath): string | null {
  if (!existsSync(path)) return null;

  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(backupsDir, `${prefixFor(path)}${stamp}.db`);

  const db = new Database(path, { readwrite: true, create: false });
  try {
    // A scan may be mid-write; wait for it rather than failing the snapshot.
    db.exec("PRAGMA busy_timeout = 10000");
    // VACUUM INTO takes a string literal, not a bound parameter.
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  return target;
}

/** This database's snapshots, newest last; ISO-8601 names sort chronologically. */
export function backups(): string[] {
  if (!existsSync(backupsDir)) return [];
  const prefix = prefixFor(databasePath);
  return readdirSync(backupsDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".db"))
    .sort()
    .map((name) => join(backupsDir, name));
}

/**
 * Replaces the database with a snapshot, after snapshotting what it replaces —
 * so restoring the wrong one is itself undoable. Returns both paths.
 *
 * The source is checked before anything is overwritten. A path is taken from the
 * command line, and this is destructive: the alternative is a database that only
 * fails on the next command, at which point the newest snapshot is the one this
 * just took of the good one.
 */
export function restore(from?: string): { restored: string; replaced: string | null } {
  const restored = from ?? backups().at(-1);
  if (!restored) throw new Error(`No snapshots of ${basename(databasePath)} in ${backupsDir}.`);
  if (!existsSync(restored)) throw new Error(`No snapshot at ${restored}.`);
  readable(restored);
  // The destination may not exist yet — restoring into a fresh workspace is how
  // one is rebuilt from a snapshot — but the same rule decides that as decides
  // whether a command may create one.
  requireCreatableDatabase();

  const replaced = backup();
  copyFileSync(restored, databasePath);
  // These describe the database that was just overwritten. Left in place, SQLite
  // would replay them over the one that replaced it.
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
  return { restored, replaced };
}

/** That the file is a SQLite database and not damaged. Not that it is Obserf's — an old snapshot predates whatever made it interesting to restore. */
function readable(path: string): void {
  let handle: Database | undefined;
  try {
    handle = new Database(path, { readonly: true });
    const result = handle.query("PRAGMA integrity_check").get() as { integrity_check: string };
    if (result.integrity_check !== "ok") {
      throw new Error(`${path} is a damaged database: ${result.integrity_check}`);
    }
  } catch (error) {
    throw new Error(
      `${path} is not a database Obserf can restore from: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    handle?.close();
  }
}
