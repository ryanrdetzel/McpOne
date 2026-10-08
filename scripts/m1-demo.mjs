#!/usr/bin/env node
/**
 * Disposable-target M1 demo using real BetterAuth, owner APIs and MCP HTTP.
 * M1_BASE_URL=http://localhost:3030 M1_ALLOW_MUTATION=yes node scripts/m1-demo.mjs setup
 * Then use: policy allow|ask|block; call <safe-integer>; approve <run-id>;
 * deny <run-id>; run <run-id>; revoke. No token/cookie is a CLI argument or output.
 * Optional M1_DEMO_NOTE supplies a protected note via the process environment;
 * it is never printed or retained in this client's state. Calls return controls,
 * not raw business results. M1_DEMO_STATE_FILE may select another ignored file.
 * setup retains only the owner session/Grant in mode-0600 .state/m1-demo.json.
 * Synthetic users/organizations remain: never point this at production.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATE = resolve(
  ROOT,
  process.env.M1_DEMO_STATE_FILE ?? ".state/m1-demo.json",
);
const PROTOCOL = "2025-06-18";
const TOOL = "fixture.counter.increment";
const NAMESPACE = "com.toolcontrolplane/execution";
const PREFIX = "Tool Control Plane execution: ";
const PRODUCTION_HOSTS = new Set([
  "cfl-mcpone-3e4b5c9dc0.ryandetzel3409.workers.dev",
  "cfl-lifecycle-controller-65ec5d0bab.ryandetzel3409.workers.dev",
]);
let base;
let safeError = "Demo request failed";
let rpcId = 0;
let state;
let cookies = new Map();

function requireValue(condition, message) {
  if (!condition) {
    safeError = message;
    throw new Error(message);
  }
}
async function api(
  path,
  { method = "GET", body, caller = false, initialize = false } = {},
) {
  const headers = new Headers({
    origin: base.origin,
    accept: caller ? "application/json, text/event-stream" : "application/json",
  });
  if (caller) {
    headers.set("authorization", `Bearer ${state.token}`);
    if (!initialize) headers.set("mcp-protocol-version", PROTOCOL);
  } else if (cookies.size) {
    headers.set(
      "cookie",
      [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    );
  }
  if (body !== undefined) headers.set("content-type", "application/json");
  safeError = "Demo HTTP request failed or timed out";
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!caller) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";", 1)[0];
      const split = pair.indexOf("=");
      requireValue(split > 0, "Auth response contained an invalid cookie");
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
  }
  const text = await response.text();
  requireValue(
    response.ok,
    "Demo HTTP operation was rejected; use an active owner session/Grant and inspect safe server diagnostics",
  );
  if (!text) return null;
  requireValue(
    response.headers.get("content-type")?.includes("application/json"),
    "Demo endpoint did not return JSON",
  );
  safeError = "Demo endpoint returned invalid JSON";
  const data = JSON.parse(text);
  return data;
}
async function rpc(method, params) {
  const id = ++rpcId;
  const message = await api(`/mcp/${state.profileId}`, {
    method: "POST",
    caller: true,
    initialize: method === "initialize",
    body: { jsonrpc: "2.0", id, method, params },
  });
  requireValue(
    message?.jsonrpc === "2.0" &&
      message.id === id &&
      !message.error &&
      message.result,
    "Demo MCP request did not return a correlated result",
  );
  return message.result;
}
async function initialize() {
  const result = await rpc("initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "m1-demo", version: "1.0.0" },
  });
  requireValue(
    result.protocolVersion === PROTOCOL,
    "Demo server did not negotiate the supported MCP protocol",
  );
  await api(`/mcp/${state.profileId}`, {
    method: "POST",
    caller: true,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
}
function safeRun(run, mcp = false) {
  const runId = mcp ? run.run_id : run.runId;
  requireValue(
    typeof runId === "string" && typeof run.status === "string",
    "Demo server omitted the durable Run control",
  );
  const result = { run_id: runId, tool: run.tool, status: run.status };
  const approval = run.approval_url ?? run.approvalLink;
  if (approval) {
    const link = new URL(approval, base);
    requireValue(
      link.origin === base.origin &&
        !link.username &&
        !link.password &&
        !link.search &&
        !link.hash,
      "Demo approval URL was not a safe same-origin inspection URL",
    );
    result.approval_url = link.href;
  }
  if (run.error)
    result.error = { code: run.error.code, retryable: run.error.retryable };
  return result;
}
function safeMcp(result) {
  const blocks = result.content?.filter(
    (entry) => entry.type === "text" && entry.text?.startsWith(PREFIX),
  );
  requireValue(
    blocks?.length === 1,
    "Demo Tool response omitted its readable execution control",
  );
  safeError = "Demo Tool response contained invalid control JSON";
  const run = JSON.parse(blocks[0].text.slice(PREFIX.length));
  requireValue(
    result._meta?.[NAMESPACE]?.run_id === run.run_id &&
      result._meta[NAMESPACE].tool === run.tool,
    "Demo Tool response had inconsistent Run provenance",
  );
  return safeRun(run, true);
}
async function privateDirectory() {
  requireValue(
    relative(ROOT, STATE).startsWith(`.state${sep}`),
    "Demo credentials must remain inside ignored .state",
  );
  await mkdir(dirname(STATE), { recursive: true, mode: 0o700 });
  const info = await lstat(dirname(STATE));
  requireValue(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      (await realpath(dirname(STATE))) === dirname(STATE),
    "Demo state directory must not traverse symlinks",
  );
}
async function loadState() {
  await privateDirectory();
  const file = await open(STATE, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    requireValue(
      info.isFile() && (info.mode & 0o777) === 0o600,
      "Demo credentials require a regular mode-0600 file",
    );
    safeError =
      "Demo state is invalid; run setup against a disposable target first";
    state = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  requireValue(
    state?.format === "m1-demo-v1" &&
      state.origin === base.origin &&
      state.cookie &&
      state.token &&
      state.profileId,
    "Demo state belongs to a different target or is incomplete",
  );
  cookies = new Map(
    state.cookie.split("; ").map((pair) => {
      const split = pair.indexOf("=");
      return [pair.slice(0, split), pair.slice(split + 1)];
    }),
  );
}
async function saveState() {
  const temporary = `${STATE}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let complete = false;
  try {
    state.cookie = [...cookies]
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
    await file.writeFile(`${JSON.stringify(state)}\n`);
    await file.sync();
    complete = true;
  } finally {
    await file.close();
    if (!complete) await unlink(temporary);
  }
  try {
    await rename(temporary, STATE);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
}

try {
  const [command, argument, ...extra] = process.argv.slice(2);
  requireValue(
    !extra.length &&
      ["setup", "policy", "call", "approve", "deny", "run", "revoke"].includes(
        command,
      ),
    "Use setup | policy allow/ask/block | call integer | approve/deny/run run-id | revoke",
  );
  if (command === "setup" || command === "revoke")
    requireValue(argument === undefined, "This demo command takes no argument");
  if (command === "policy")
    requireValue(
      ["allow", "ask", "block"].includes(argument),
      "Policy must be allow, ask, or block",
    );
  if (command === "call")
    requireValue(
      /^-?\d+$/.test(argument ?? "") && Number.isSafeInteger(Number(argument)),
      "Call value must be a safe integer",
    );
  if (["approve", "deny", "run"].includes(command))
    requireValue(
      /^[a-zA-Z0-9_-]{1,128}$/.test(argument ?? ""),
      "Run ID must be a plain identifier, not a URL or credential",
    );
  requireValue(
    process.env.M1_ALLOW_MUTATION === "yes",
    "Set M1_ALLOW_MUTATION=yes only for a disposable local or isolated hosted target",
  );
  requireValue(
    process.env.M1_BASE_URL,
    "Set M1_BASE_URL to the disposable target origin",
  );
  safeError = "M1_BASE_URL is not a valid disposable HTTP(S) origin";
  base = new URL(process.env.M1_BASE_URL);
  requireValue(
    ["http:", "https:"].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      base.pathname === "/" &&
      !base.search &&
      !base.hash,
    safeError,
  );
  requireValue(
    !PRODUCTION_HOSTS.has(base.hostname.toLowerCase().replace(/\.$/, "")),
    "Known production application/controller URLs are prohibited",
  );
  const readme = await open(resolve(ROOT, "README.md"), "r");
  let documentation;
  try {
    documentation = await readme.readFile("utf8");
  } finally {
    await readme.close();
  }
  for (const section of documentation.match(
    /### Verified deployment[^\n]*\n([\s\S]*?)(?=\n#{1,3} |$)/g,
  ) ?? []) {
    for (const match of section.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
      requireValue(
        base.hostname.toLowerCase().replace(/\.$/, "") !==
          match[1].toLowerCase(),
        "README production deployment URL is prohibited",
      );
    }
  }
  let output;
  if (command === "setup") {
    await privateDirectory();
    safeError =
      "Demo state already exists; choose a different ignored M1_DEMO_STATE_FILE for a new disposable demo";
    const reservation = await open(
      STATE,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let ready = false;
    try {
      const health = await api("/healthz");
      requireValue(
        health?.ok === true,
        "Disposable target did not report live healthy persistence",
      );
      const email = `m1-demo-${randomUUID()}@example.com`;
      const signup = await api("/api/auth/sign-up/email", {
        method: "POST",
        body: {
          name: "M1 Demo Owner",
          email,
          password: randomBytes(32).toString("base64url"),
        },
      });
      requireValue(
        signup?.user?.id && cookies.size,
        "BetterAuth signup did not establish a real owner session",
      );
      const slug = `m1-demo-${randomUUID()}`;
      const organization = await api("/api/auth/organization/create", {
        method: "POST",
        body: { name: "M1 disposable demo", slug },
      });
      await api("/api/auth/organization/set-active", {
        method: "POST",
        body: { organizationSlug: slug },
      });
      const session = await api("/api/auth/get-session");
      requireValue(
        organization?.id &&
          session?.session?.activeOrganizationId === organization.id,
        "BetterAuth active organization was not established",
      );
      const fixture = await api("/api/control/setup", {
        method: "POST",
        body: { label: "demo-profile" },
      });
      requireValue(
        fixture?.profileId && fixture.tool === TOOL,
        "Owner fixture/Profile setup failed",
      );
      const grant = await api(
        `/api/control/profiles/${fixture.profileId}/grants`,
        { method: "POST", body: { label: "demo-caller" } },
      );
      requireValue(
        grant?.grantId && typeof grant.token === "string",
        "Owner Grant issuance failed",
      );
      state = {
        format: "m1-demo-v1",
        origin: base.origin,
        orgId: organization.id,
        profileId: fixture.profileId,
        grantId: grant.grantId,
        token: grant.token,
        cookie: [...cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
        revoked: false,
      };
      await reservation.writeFile(`${JSON.stringify(state)}\n`);
      await reservation.sync();
      ready = true;
      output = {
        ok: true,
        target_origin: base.origin,
        profile_url: new URL(`/mcp/${fixture.profileId}`, base).href,
        grant_label: "demo-caller",
        policy: "ask",
        state_file: relative(ROOT, STATE),
      };
    } finally {
      await reservation.close();
      if (!ready) await unlink(STATE);
    }
  } else {
    await loadState();
    if (command === "policy") {
      await api(`/api/control/profiles/${state.profileId}/policies`, {
        method: "PUT",
        body: { rules: [{ pattern: TOOL, decision: argument }] },
      });
      output = { ok: true, policy: argument };
    } else if (command === "call" || command === "run") {
      await initialize();
      const params =
        command === "call"
          ? {
              name: TOOL,
              arguments: {
                value: Number(argument),
                ...(process.env.M1_DEMO_NOTE
                  ? { note: process.env.M1_DEMO_NOTE }
                  : {}),
              },
              _meta: { [NAMESPACE]: { idempotency_key: randomUUID() } },
            }
          : { name: "runs.get", arguments: { run_id: argument } };
      output = { ok: true, ...safeMcp(await rpc("tools/call", params)) };
    } else if (command === "approve" || command === "deny") {
      output = {
        ok: true,
        ...safeRun(
          await api(`/api/control/runs/${argument}/${command}`, {
            method: "POST",
            body: {},
          }),
        ),
      };
    } else {
      await api(`/api/control/grants/${state.grantId}`, { method: "DELETE" });
      state.revoked = true;
      output = { ok: true, grant_revoked: true };
    }
    await saveState();
  }
  console.log(JSON.stringify(output));
} catch {
  console.error(JSON.stringify({ ok: false, error: safeError }));
  process.exitCode = 1;
}
