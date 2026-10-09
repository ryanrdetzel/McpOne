import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./auth";

export const controlConnectionCredentials = sqliteTable(
  "control_connection_credentials",
  {
    id: text("id").primaryKey().notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    cipher: text("cipher").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
);
