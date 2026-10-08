import { readdir, readFile } from "node:fs/promises";
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
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const migration = await readFile(new URL(name, directory), "utf8");
      // D1 exec separates physical lines; retain complete trigger bodies on one line.
      await binding.exec(
        migration.replace(/^--.*$/gm, "").replaceAll("\n", " "),
      );
    }
    await checkDatabase(db);
    await binding
      .prepare("ALTER TABLE sessions DROP COLUMN active_organization_id")
      .run();
    await expect(checkDatabase(db)).rejects.toThrow(/active_organization_id/);
  } finally {
    await runtime.dispose();
  }
}, 30_000);
