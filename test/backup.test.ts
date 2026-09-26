import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseSnapshotName } from "../db/backup";

describe("parseSnapshotName", () => {
  const name = (tail: string) =>
    `/w/.obserf/backups/obserf.db.7e6cf116.2026-09-12T06-42-40-938Z${tail}`;

  test("reads back the instant and the reason", () => {
    const parsed = parseSnapshotName(name(".manual.db"));
    expect(parsed?.takenAt.toISOString()).toBe("2026-09-12T06:42:40.938Z");
    expect(parsed?.reason).toBe("manual");
    expect(parseSnapshotName(name(".upgrade.db"))?.reason).toBe("upgrade");
    expect(parseSnapshotName(name(".replaced.db"))?.reason).toBe("replaced");
  });

  /** Null is not "manual": a snapshot from before this existed does not say. */
  test("a snapshot taken before reasons existed says nothing rather than guessing", () => {
    const parsed = parseSnapshotName(name(".db"));
    expect(parsed?.takenAt.toISOString()).toBe("2026-09-12T06:42:40.938Z");
    expect(parsed?.reason).toBeNull();
  });

  test("a name that encodes no instant is not a snapshot", () => {
    expect(parseSnapshotName("obserf.db.7e6cf116.whenever.db")).toBeNull();
  });

  /** `new Date` rolls this into March rather than refusing it. */
  test("a day that does not exist is not a date one month later", () => {
    expect(parseSnapshotName("obserf.db.7e6cf116.2026-02-31T06-42-40-938Z.manual.db")).toBeNull();
    expect(parseSnapshotName("obserf.db.7e6cf116.2026-09-12T24-00-00-000Z.manual.db")).toBeNull();
  });

  /**
   * The name opens with the database's own filename, so a stamp anywhere in it
   * is not necessarily the snapshot's. This one is the database's.
   */
  test("dates a snapshot by the stamp it wrote, not one in the database's name", () => {
    const parsed = parseSnapshotName(
      "2026-01-01T00-00-00-000Z.db.deadbeef.2026-09-12T07-46-40-421Z.upgrade.db",
    );
    expect(parsed?.takenAt.toISOString()).toBe("2026-09-12T07:46:40.421Z");
    expect(parsed?.reason).toBe("upgrade");
  });
});

/**
 * Run as a CLI, in a workspace of its own: `backup` and `restore` read paths
 * `workspace.ts` resolved once at import, and `restore` overwrites the database
 * the rest of the suite shares.
 */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A workspace whose database holds one marker row. */
function workspace(marker: number): string {
  const root = mkdtempSync(join(tmpdir(), "obserf-backup-"));
  roots.push(root);
  writeFileSync(join(root, "obserf.config.ts"), "export default {};");
  mkdirSync(join(root, ".obserf", "backups"), { recursive: true });
  const db = new Database(join(root, ".obserf", "obserf.db"), { create: true });
  db.exec(`CREATE TABLE marker (id INTEGER); INSERT INTO marker VALUES (${marker})`);
  db.close();
  return root;
}

async function spawnObserf(root: string, ...args: string[]) {
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "cli.ts"), ...args], {
    env: { ...process.env, OBSERF_HOME: root, OBSERF_DB: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

async function obserf(root: string, ...args: string[]): Promise<string> {
  const { code, stdout, stderr } = await spawnObserf(root, ...args);
  expect(code, stdout + stderr).toBe(0);
  return stdout;
}

test("backup labels a snapshot the operator asked for", async () => {
  const root = workspace(1);
  const taken = (await obserf(root, "backup")).trim().replace("Snapshot → ", "");
  expect(parseSnapshotName(taken)?.reason).toBe("manual");
});

/** Restoring the wrong snapshot is itself undoable, which is what `replaced` is. */
test("restore resolves a bare name, and records what it overwrote", async () => {
  const root = workspace(1);
  const backupsDir = join(root, ".obserf", "backups");

  // Only in the snapshot directory, so finding it there is what is being tested.
  const snapshot = "obserf.db.deadbeef.2026-09-12T06-42-40-938Z.manual.db";
  const seeded = new Database(join(backupsDir, snapshot), { create: true });
  seeded.exec("CREATE TABLE marker (id INTEGER); INSERT INTO marker VALUES (42)");
  seeded.close();

  await obserf(root, "restore", snapshot);

  const restored = new Database(join(root, ".obserf", "obserf.db"), { readonly: true });
  expect(restored.query("SELECT id FROM marker").get()).toEqual({ id: 42 });
  restored.close();
  expect(
    readdirSync(backupsDir)
      .map((name) => parseSnapshotName(name)?.reason)
      .sort(),
  ).toEqual(["manual", "replaced"]);
});

/** Each refused before anything is snapshotted or overwritten. */
describe("restore refuses a snapshot it cannot vouch for", () => {
  async function refusal(write: (snapshot: string) => void): Promise<string> {
    const root = workspace(1);
    const backupsDir = join(root, ".obserf", "backups");
    const snapshot = join(backupsDir, "obserf.db.deadbeef.2026-09-12T06-42-40-938Z.manual.db");
    write(snapshot);
    const before = readdirSync(backupsDir).sort();

    const { code, stderr } = await spawnObserf(root, "restore", snapshot);
    expect(code).not.toBe(0);
    const live = new Database(join(root, ".obserf", "obserf.db"), { readonly: true });
    expect(live.query("SELECT id FROM marker").get()).toEqual({ id: 1 });
    live.close();
    expect(readdirSync(backupsDir).sort()).toEqual(before);
    return stderr.replaceAll(snapshot, "SNAPSHOT");
  }

  /** It was caught by the handler around the check and reworded as "not a database". */
  test("a damaged one, as damaged", async () => {
    const stderr = await refusal((snapshot) => {
      const seeded = new Database(snapshot, { create: true });
      seeded.exec(
        "PRAGMA page_size = 4096; CREATE TABLE t (x INTEGER); CREATE INDEX i ON t (x); INSERT INTO t VALUES (1)",
      );
      seeded.close();
      // Zero the cell count of page 3, the index's leaf: the file still opens, so
      // the damage is left for `integrity_check` to find. Bun's SQLite refuses the
      // `writable_schema` shortcut.
      const fd = openSync(snapshot, "r+");
      writeSync(fd, Buffer.from([0, 0]), 0, 2, 2 * 4096 + 3);
      closeSync(fd);
    });
    expect(stderr).toContain("SNAPSHOT is a damaged database:");
    expect(stderr).not.toContain("could not be checked");
  });

  /** SQLite opens it as an empty database, and it passes `integrity_check`. */
  test("an empty file", async () => {
    const stderr = await refusal((snapshot) => writeFileSync(snapshot, ""));
    expect(stderr).toContain("SNAPSHOT is empty, so there is no database to restore.");
  });

  test("a file that is not SQLite", async () => {
    const stderr = await refusal((snapshot) => writeFileSync(snapshot, "not sqlite ".repeat(20)));
    expect(stderr).toContain(
      "SNAPSHOT could not be checked as a database to restore from: file is not a database",
    );
  });

  /** SQLite would read the `-wal` beside the target, which the guard would look for beside the link. */
  test("a symlink", async () => {
    const stderr = await refusal((snapshot) => {
      const targetRoot = mkdtempSync(join(tmpdir(), "obserf-target-"));
      roots.push(targetRoot);
      const target = join(targetRoot, "real.db");
      const seeded = new Database(target, { create: true });
      seeded.exec("CREATE TABLE marker (id INTEGER)");
      seeded.close();
      symlinkSync(target, snapshot);
    });
    expect(stderr).toContain("SNAPSHOT is a symlink; pass its target instead.");
  });

  /** Contents do not matter to the guard: with any non-empty `-wal`, the main file alone cannot be vouched for. */
  test("one with a non-empty -wal beside it", async () => {
    const stderr = await refusal((snapshot) => {
      const seeded = new Database(snapshot, { create: true });
      seeded.exec("CREATE TABLE marker (id INTEGER)");
      seeded.close();
      writeFileSync(`${snapshot}-wal`, "uncheckpointed");
    });
    expect(stderr).toContain("SNAPSHOT has a -wal file beside it that may hold changes");
  });
});

// An unrecognized suffix must not make a copied file the newest restore candidate.
test("listing excludes a copied snapshot with an unrecognized filename suffix", async () => {
  const root = workspace(7);
  const taken = (await obserf(root, "backup")).trim().replace("Snapshot → ", "");
  const byHand = `${taken.slice(0, taken.lastIndexOf("."))}.zzz.db`;
  copyFileSync(taken, byHand);

  const listed = await obserf(root, "backups");
  expect(listed).toContain(basename(taken));
  expect(listed).not.toContain(basename(byHand));
});
