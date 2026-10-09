#!/usr/bin/env node
/**
 * Controlled external HTTP fault service. NEVER a real Provider/MCP acceptance cell.
 * Worker: bind a separate disposable D1 as M2_FAULT_DB and provision schema with
 * FAULT_SCHEMA below through the owned lifecycle; no request/startup migrations.
 * Node: M2_FAULT_ALLOW_MUTATION=yes M2_FAULT_PORT=4050 node scripts/m2-fault-local.mjs.
 * Place behind an owned trusted HTTPS origin for gateway egress (not a private-address
 * or insecure-TLS exception). This service touches synthetic counters only, no secrets.
 * Keep it running across APPLICATION restart proof; Worker state is actual isolated D1.
 * Per-proof namespace UUIDs isolate counters. Public access grants no other authority.
 */
export const FAULT_SCHEMA = `CREATE TABLE m2_fault_counters (namespace TEXT PRIMARY KEY, writes INTEGER NOT NULL DEFAULT 0, reads INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0);
CREATE TABLE m2_fault_keys (namespace TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(namespace,key));`;
const INLINE_LIMIT = 1024 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export function sqliteStore(db) {
  return {
    async count(namespace) {
      await db
        .prepare(
          "INSERT INTO m2_fault_counters(namespace) VALUES(?) ON CONFLICT DO NOTHING",
        )
        .bind(namespace)
        .run();
      return db
        .prepare(
          "SELECT writes,reads,requests FROM m2_fault_counters WHERE namespace=?",
        )
        .bind(namespace)
        .first();
    },
    async increment(namespace, column) {
      await db
        .prepare(
          "INSERT INTO m2_fault_counters(namespace) VALUES(?) ON CONFLICT DO NOTHING",
        )
        .bind(namespace)
        .run();
      const row = await db
        .prepare(
          `UPDATE m2_fault_counters SET ${column}=${column}+1 WHERE namespace=? RETURNING writes,reads,requests`,
        )
        .bind(namespace)
        .first();
      return row;
    },
    async idempotent(namespace, key) {
      await db
        .prepare(
          "INSERT INTO m2_fault_counters(namespace) VALUES(?) ON CONFLICT DO NOTHING",
        )
        .bind(namespace)
        .run();
      // D1 batch executes atomically. The key is upstream-owned, not gateway Run truth.
      await db.batch([
        db
          .prepare(
            "INSERT INTO m2_fault_keys(namespace,key,value) SELECT ?,?,writes+1 FROM m2_fault_counters WHERE namespace=? ON CONFLICT DO NOTHING",
          )
          .bind(namespace, key, namespace),
        db
          .prepare(
            "UPDATE m2_fault_counters SET writes=max(writes,(SELECT value FROM m2_fault_keys WHERE namespace=? AND key=?)) WHERE namespace=?",
          )
          .bind(namespace, key, namespace),
      ]);
      return db
        .prepare("SELECT value FROM m2_fault_keys WHERE namespace=? AND key=?")
        .bind(namespace, key)
        .first();
    },
  };
}
export async function faultRequest(request, store) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || !UUID.test(parts[0]))
    return json({ error: "not_found" }, 404);
  const [namespace, action] = parts;
  if (request.method === "GET" && action === "stats")
    return json(await store.count(namespace));
  if (request.method === "GET" && action === "retryable_read") {
    const state = await store.increment(namespace, "reads");
    if (state.reads === 1)
      return json({ error: "controlled_transient_read_failure" }, 503);
    return json({ public_value: "controlled-read", writes: state.writes });
  }
  if (request.method === "GET" && action === "redirect_private")
    return new Response(null, {
      status: 302,
      headers: { location: "https://127.0.0.1/forbidden" },
    });
  if (request.method === "GET" && action === "redirect_unreviewed")
    return new Response(null, {
      status: 302,
      headers: { location: "https://unreviewed.example.com/forbidden" },
    });
  if (request.method === "POST" && action === "echo") {
    await store.increment(namespace, "requests");
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("multipart/form-data")) {
      const form = await request.formData();
      const files = [];
      for (const [name, value] of form)
        if (typeof value !== "string")
          files.push({
            field: name,
            filename: value.name,
            size_bytes: value.size,
            media_type: value.type,
          });
      return json({ files, count: files.length });
    }
    return json({
      method: request.method,
      media_type: type,
      body: await request.text(),
    });
  }
  if (request.method === "POST" && action === "idempotent_write") {
    const key = request.headers.get("idempotency-key");
    if (!key || key.length > 128)
      return json({ error: "missing_public_idempotency_key" }, 400);
    return json({
      incremented: 1,
      provider_key: key,
      ...(await store.idempotent(namespace, key)),
    });
  }
  if (
    request.method === "POST" &&
    ["write", "oversized_after_write", "timeout_after_write"].includes(action)
  ) {
    const state = await store.increment(namespace, "writes");
    if (action === "oversized_after_write")
      return json({
        padding: "x".repeat(INLINE_LIMIT + 1),
        writes: state.writes,
      });
    if (action === "timeout_after_write") await sleep(65_000);
    return json({ incremented: 1, writes: state.writes });
  }
  if (request.method === "GET" && action === "binary")
    return new Response(new Uint8Array([0, 1, 2, 127, 128, 255]), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment; filename=public-fixture.bin",
      },
    });
  return json({ error: "unsupported_controlled_operation" }, 405);
}
export default {
  async fetch(request, env) {
    if (!env.M2_FAULT_DB)
      return json({ error: "isolated_fault_database_unavailable" }, 503);
    return faultRequest(request, sqliteStore(env.M2_FAULT_DB));
  },
};
