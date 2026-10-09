#!/usr/bin/env node
import { FAULT_SCHEMA, faultRequest, sqliteStore } from "./m2-fault-source.mjs";

// Direct Node wrapper uses real SQLite, not a Run engine or in-memory mock.
if (typeof process !== "undefined" && process.argv[1]) {
  const { resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.env.M2_FAULT_ALLOW_MUTATION !== "yes")
      throw new Error(
        "Set M2_FAULT_ALLOW_MUTATION=yes for a disposable synthetic fault service only",
      );
    const { DatabaseSync } = await import("node:sqlite");
    const { createServer } = await import("node:http");
    const { mkdir, lstat, realpath } = await import("node:fs/promises");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const directory = resolve(root, ".state/m2-fault-source");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0 ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Fault state directory must be private and non-symlink");
    const database = new DatabaseSync(resolve(directory, "fault.sqlite"));
    // Fault-only database lifecycle is separate from the application. User-approved
    // disposable startup provisions these two tables once; no application DB touched.
    database.exec(
      FAULT_SCHEMA.replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "),
    );
    const binding = {
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          bind(...values) {
            return {
              run() {
                statement.run(...values);
              },
              first() {
                return statement.get(...values) ?? null;
              },
            };
          },
        };
      },
      batch(statements) {
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const statement of statements) statement.run();
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    };
    const store = sqliteStore(binding);
    const port = Number(process.env.M2_FAULT_PORT ?? 4050);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("M2_FAULT_PORT must be 1024..65535");
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of incoming) {
          bytes += chunk.length;
          if (bytes > 26 * 1024 * 1024) {
            outgoing.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const body = ["GET", "HEAD"].includes(incoming.method)
          ? undefined
          : Buffer.concat(chunks);
        const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers,
          body,
        });
        const response = await faultRequest(request, store);
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        outgoing
          .writeHead(500, { "content-type": "application/json" })
          .end('{"error":"controlled_source_failure"}');
      }
    });
    server.listen(port, "127.0.0.1", () =>
      console.log(
        JSON.stringify({
          source: "controlled-external-fault-only",
          origin: `http://127.0.0.1:${port}`,
          provider_acceptance: "not_claimed",
        }),
      ),
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () =>
        server.close(() => {
          database.close();
          process.exit(0);
        }),
      );
  }
}
