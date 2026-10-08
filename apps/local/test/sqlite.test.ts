import { checkDatabase, createDatabase } from "@scaffold/database";
import { SQLiteBinding } from "@scaffold/database/sqlite";
import { describe, expect, it } from "vitest";

function withDatabase(run: (binding: SQLiteBinding) => Promise<void>) {
  const binding = new SQLiteBinding(":memory:");
  return run(binding).finally(() => binding.close());
}

describe("direct SQLite D1 adapter", () => {
  it("binds values, returns writes and positional rows through the real SQLite engine", () =>
    withDatabase(async (binding) => {
      await binding.exec(
        "CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL)",
      );
      const inserted = await binding
        .prepare("INSERT INTO proof (value) VALUES (?) RETURNING id, value")
        .bind("one")
        .all<{ id: number; value: string }>();
      expect(inserted.results).toEqual([{ id: 1, value: "one" }]);
      expect(inserted.meta.changes).toBe(1);
      expect(
        await binding.prepare("SELECT value FROM proof").first("value"),
      ).toBe("one");
      expect(
        await binding
          .prepare("SELECT id, value FROM proof")
          .raw({ columnNames: true }),
      ).toEqual([
        ["id", "value"],
        [1, "one"],
      ]);
      expect(
        await binding
          .prepare("SELECT value FROM proof WHERE id = ?")
          .bind(2)
          .first(),
      ).toBeNull();
    }));

  it("rolls back the entire atomic batch when any statement fails", () =>
    withDatabase(async (binding) => {
      await binding.exec("CREATE TABLE proof (value TEXT UNIQUE NOT NULL)");
      await expect(
        binding.batch([
          binding.prepare("INSERT INTO proof VALUES (?)").bind("same"),
          binding.prepare("INSERT INTO proof VALUES (?)").bind("same"),
        ]),
      ).rejects.toThrow();
      expect(
        (await binding.prepare("SELECT * FROM proof").all()).results,
      ).toEqual([]);
      const results = await binding.batch([
        binding
          .prepare("INSERT INTO proof VALUES (?) RETURNING value")
          .bind("one"),
        binding
          .prepare("INSERT INTO proof VALUES (?) RETURNING value")
          .bind("two"),
      ]);
      expect(results.map((result) => result.results)).toEqual([
        [{ value: "one" }],
        [{ value: "two" }],
      ]);
    }));

  it("uses existing Drizzle readiness instead of a local schema substitute", () =>
    withDatabase(async (binding) => {
      await expect(checkDatabase(createDatabase(binding))).rejects.toThrow();
    }));
});
