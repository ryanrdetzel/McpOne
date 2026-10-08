import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Feature flags — core convention: DB-backed remediation lever. */
export const featureFlags = sqliteTable("feature_flags", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  key: text("key").notNull().unique(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  rolloutPct: integer("rollout_pct").notNull().default(100),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
});

export * from "./auth";
