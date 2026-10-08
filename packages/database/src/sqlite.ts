import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  D1Database,
  D1DatabaseSession,
  D1PreparedStatement,
  D1Result,
} from "@cloudflare/workers-types";

function parameter(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "number")
    return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return value as SQLInputValue;
  throw new TypeError(
    "D1 bindings must be null, numbers, strings or binary data",
  );
}

class SQLiteStatement implements D1PreparedStatement {
  constructor(
    readonly owner: SQLiteBinding,
    readonly query: string,
    readonly values: SQLInputValue[] = [],
  ) {}
  bind(...values: unknown[]): D1PreparedStatement {
    return new SQLiteStatement(this.owner, this.query, values.map(parameter));
  }
  execute<T>(): D1Result<T> {
    const started = performance.now();
    const statement = this.owner.sqlite.prepare(this.query);
    const before = this.owner.sqlite
      .prepare("SELECT total_changes() AS changes")
      .get()!;
    let results: unknown[];
    let lastRowId = 0;
    if (statement.columns().length) results = statement.all(...this.values);
    else {
      const result = statement.run(...this.values);
      lastRowId = Number(result.lastInsertRowid);
      results = [];
    }
    const after = this.owner.sqlite
      .prepare(
        "SELECT total_changes() AS changes, last_insert_rowid() AS rowid",
      )
      .get()!;
    const changes = Number(after.changes) - Number(before.changes);
    return {
      success: true,
      results: results as T[],
      meta: {
        duration: performance.now() - started,
        changes,
        last_row_id: lastRowId || Number(after.rowid),
        changed_db: changes > 0,
        rows_read: results.length,
        rows_written: changes,
        size_after:
          Number(
            this.owner.sqlite.prepare("PRAGMA page_count").get()!.page_count,
          ) *
          Number(
            this.owner.sqlite.prepare("PRAGMA page_size").get()!.page_size,
          ),
      },
    };
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.owner.sqlite.prepare(this.query).get(...this.values);
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: ${column}`);
    return row[column] as T;
  }
  async raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: {
    columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.owner.sqlite.prepare(this.query);
    const names = statement.columns().map((column) => column.name);
    const rows = statement
      .all(...this.values)
      .map((row) => names.map((name) => row[name]) as T);
    return options?.columnNames ? [names, ...rows] : rows;
  }
}

/** Real SQLite persistence with the asynchronous D1 surface used by shared Drizzle. */
export class SQLiteBinding implements D1Database {
  readonly sqlite: DatabaseSync;
  constructor(path: string) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
    );
  }
  prepare(query: string): D1PreparedStatement {
    return new SQLiteStatement(this, query);
  }
  async batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SQLiteStatement) || statement.owner !== this)
          throw new TypeError("Batch statements must belong to this database");
        return statement.execute<T>();
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  async exec(query: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    const before = Number(
      this.sqlite.prepare("SELECT total_changes() AS changes").get()!.changes,
    );
    this.sqlite.exec(query);
    return {
      count:
        Number(
          this.sqlite.prepare("SELECT total_changes() AS changes").get()!
            .changes,
        ) - before,
      duration: performance.now() - started,
    };
  }
  withSession(): D1DatabaseSession {
    return {
      prepare: this.prepare.bind(this),
      batch: this.batch.bind(this),
      getBookmark: () => null,
    };
  }
  async dump(): Promise<ArrayBuffer> {
    throw new Error("D1 alpha dump is unsupported; use SQLite backup tooling");
  }
  close(): void {
    this.sqlite.close();
  }
}
