/**
 * Recomputes stored scores from stored components without calling the model —
 * the point of storing components rather than a number, see
 * docs/adr/003-model-scores-components-code-ranks.md.
 *
 * Separate from `scan.ts` because it performs no discovery, gating, or
 * assessment: it is maintenance over judgments already stored, not a scan stage.
 */

import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { score } from "./score";

export function rescore(project?: string): number {
  const rows = db
    .select({
      id: schema.assessments.id,
      relevance: schema.assessments.relevance,
      intent: schema.assessments.intent,
      welcome: schema.assessments.welcome,
      reach: schema.assessments.reach,
      disqualified: schema.assessments.disqualified,
      opportunity: schema.assessments.opportunity,
      publishedAt: schema.findings.publishedAt,
    })
    .from(schema.assessments)
    .innerJoin(schema.findings, eq(schema.findings.id, schema.assessments.findingId))
    .where(project ? eq(schema.findings.project, project) : undefined)
    .all();

  db.transaction((tx) => {
    for (const row of rows) {
      tx.update(schema.assessments)
        .set({ score: score(row, row.publishedAt) })
        .where(eq(schema.assessments.id, row.id))
        .run();
    }
  });

  return rows.length;
}
