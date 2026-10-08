import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SQLiteBinding } from "@scaffold/database/sqlite";
import { localConfiguration, root } from "./config";

const { databasePath } = localConfiguration();
const binding = new SQLiteBinding(databasePath);
try {
  const db = binding.sqlite;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY NOT NULL, hash TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const directory = resolve(root, "packages/database/migrations");
    const migrations = readdirSync(directory)
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    const applied = db
      .prepare("SELECT name, hash FROM local_migrations ORDER BY name")
      .all();
    for (let index = 0; index < applied.length; index++) {
      if (applied[index]!.name !== migrations[index])
        throw new Error(
          "Migration history differs from the ordered migration directory",
        );
    }
    for (const [index, name] of migrations.entries()) {
      const sql = readFileSync(resolve(directory, name), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      if (index < applied.length) {
        if (applied[index]!.hash !== hash)
          throw new Error(`Applied migration was modified: ${name}`);
        continue;
      }
      db.exec(sql);
      db.prepare(
        "INSERT INTO local_migrations (name, hash, applied_at) VALUES (?, ?, ?)",
      ).run(name, hash, Date.now());
      console.log(`Applied ${name}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} finally {
  binding.close();
}
