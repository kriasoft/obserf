import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

async function obserf(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "cli.ts"), ...args], {
    env: { ...process.env, OBSERF_HOME: root, OBSERF_DB: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(await child.exited, stdout + stderr).toBe(0);
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
