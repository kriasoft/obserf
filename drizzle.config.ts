import { defineConfig } from "drizzle-kit";
// `db:generate` needs only the schema; this path is what points `db:studio` at
// the operator's own database rather than one beside the schema. The import must
// stay free of the source adapters — drizzle-kit bundles this file to read it.
import { databasePath } from "./workspace";

export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema.ts",
  dbCredentials: { url: databasePath },
  out: "./drizzle",
  casing: "snake_case",
});
