import type { D1Database } from "@cloudflare/workers-types";
import { tables } from "@scaffold/schema";
import { getTableColumns, getTableName } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";

export type Database = DrizzleD1Database<typeof tables> & {
  readonly $client: D1Database;
};

export function createDatabase(binding: D1Database): Database {
  return drizzle(binding, { schema: tables });
}

// Qualify every column: SQLite can interpret an unknown unqualified "column"
// as a string literal, which would incorrectly make stale schemas look ready.
const readinessSql = Object.values(tables).map((table) => {
  const name = `"${getTableName(table).replaceAll('"', '""')}"`;
  const columns = Object.values(getTableColumns(table))
    .map((column) => `${name}."${column.name.replaceAll('"', '""')}"`)
    .join(", ");
  return `SELECT ${columns} FROM ${name} LIMIT 0`;
});

/**
 * Validate every current table and column without reading application data.
 * A reachable but unmigrated/stale D1 database is not ready to serve traffic.
 */
export async function checkDatabase(db: Database): Promise<void> {
  await db.$client.batch(
    readinessSql.map((query) => db.$client.prepare(query)),
  );
}
