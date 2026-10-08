import { readFile } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { checkDatabase, createDatabase } from "../src/index";

it("rejects unmigrated and missing-column D1 schemas, but accepts the committed schema", async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      modules: true,
      script:
        "export default { fetch() { return new Response(null, {status: 204}); } };",
      d1Databases: { DB: "readiness-regression" },
    }),
  );
  try {
    const binding = (await runtime.getD1Database(
      "DB",
    )) as unknown as D1Database;
    const db = createDatabase(binding);
    await expect(checkDatabase(db)).rejects.toThrow();
    const migration = await readFile(
      new URL("../migrations/0000_initial.sql", import.meta.url),
      "utf8",
    );
    await binding.batch(
      migration
        .split(";")
        .map((query) => query.trim())
        .filter(Boolean)
        .map((query) => binding.prepare(query)),
    );
    await checkDatabase(db);
    await binding
      .prepare("ALTER TABLE sessions DROP COLUMN active_organization_id")
      .run();
    await expect(checkDatabase(db)).rejects.toThrow(/active_organization_id/);
  } finally {
    await runtime.dispose();
  }
}, 30_000);
