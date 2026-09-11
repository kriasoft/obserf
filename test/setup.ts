/**
 * Runs before any test module, which is what makes it work: `workspace.ts`
 * resolves its paths at import time, so `OBSERF_HOME` has to be set before
 * anything imports it.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "obserf-test-home-"));
writeFileSync(join(root, "obserf.config.ts"), "export default {};");
process.env.OBSERF_HOME = root;
delete process.env.OBSERF_DB;
