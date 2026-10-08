import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createApplication } from "@scaffold/core";
import { createExecutionService } from "@scaffold/core/execution";
import { createDatabase } from "@scaffold/database";
import { SQLiteBinding } from "@scaffold/database/sqlite";
import { localConfiguration } from "./config";

const config = localConfiguration();
const binding = new SQLiteBinding(config.databasePath);
const db = createDatabase(binding);
const execution = createExecutionService({
  db,
  secret: config.env.BETTER_AUTH_SECRET,
});
const app = createApplication({ env: config.env, db, execution });
await execution.drain();
let draining: Promise<void> | undefined;
const recoveryTimer = setInterval(() => {
  if (draining) return;
  draining = execution
    .drain()
    .catch(() => {
      console.error("Local execution recovery failed");
    })
    .finally(() => {
      draining = undefined;
    });
}, 1000);
const servicePath =
  /^(?:\/api(?:\/|$)|\/admin(?:\/|$)|\/mcp(?:\/|$)|\/control(?:\/|$)|\/healthz(?:\/|$)|\/db(?:\/|$)|\/openapi\.json(?:\/|$))/;
const mediaTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".map": "application/json",
};

app.notFound(async (c) => {
  if (!["GET", "HEAD"].includes(c.req.method) || servicePath.test(c.req.path))
    return c.json({ error: "not_found" }, 404);
  let path: string;
  try {
    path = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
  const assetsRoot = await realpath(config.assetsPath);
  let file = resolve(assetsRoot, `.${path}`);
  let fallback = false;
  try {
    file = await realpath(file);
    if (!file.startsWith(assetsRoot + sep) || !(await stat(file)).isFile())
      throw new Error("Not an asset");
  } catch {
    // Asset misses are not SPA navigations; never disguise missing scripts as HTML.
    if (path.startsWith("/assets/") || extname(path))
      return c.json({ error: "not_found" }, 404);
    file = resolve(assetsRoot, "index.html");
    fallback = true;
  }
  return new Response(
    c.req.method === "HEAD" ? null : new Uint8Array(await readFile(file)),
    {
      headers: {
        "Content-Type": mediaTypes[extname(file)] ?? "application/octet-stream",
        "Cache-Control":
          !fallback && path.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
      },
    },
  );
});

const server = createServer(async (incoming, outgoing) => {
  try {
    if (
      incoming.headers.host !== `localhost:${config.port}` &&
      incoming.headers.host !== `127.0.0.1:${config.port}`
    ) {
      outgoing.writeHead(400).end();
      return;
    }
    const url = new URL(incoming.url ?? "/", config.origin);
    if (url.origin !== config.origin) {
      outgoing.writeHead(400).end();
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value))
        for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    const method = incoming.method ?? "GET";
    const init: RequestInit & { duplex?: "half" } = { method, headers };
    if (method !== "GET" && method !== "HEAD") {
      init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
    const response = await app.fetch(new Request(url, init));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") outgoing.setHeader(name, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outgoing.setHeader("set-cookie", cookies);
    if (!response.body || method === "HEAD") outgoing.end();
    else
      Readable.fromWeb(response.body as NodeReadableStream)
        .on("error", () => outgoing.destroy())
        .pipe(outgoing);
  } catch {
    if (!outgoing.headersSent)
      outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end('{"error":"internal_error"}');
  }
});
server.listen(config.port, "127.0.0.1", () =>
  console.log(`McpOne local listening at ${config.origin}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    clearInterval(recoveryTimer);
    server.close(async () => {
      await draining;
      binding.close();
      process.exit(0);
    });
  });
