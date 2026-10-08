#!/usr/bin/env node
/**
 * Black-box M1 HTTP behavior, identical for direct Node/SQLite and an isolated Worker.
 * No SDK certification, source inspection, direct DB access, or fake clocks.
 *
 * M1_BASE_URL=http://localhost:3030 M1_ALLOW_MUTATION=yes \
 *   node scripts/m1-conformance.mjs --phase=prepare
 * Stop/restart the real server (same DB/secret), or redeploy the isolated Worker.
 * M1_BASE_URL=http://localhost:3030 M1_ALLOW_MUTATION=yes M1_EXPIRY_WAIT=yes \
 *   M1_RESTART_CONFIRMED=yes node scripts/m1-conformance.mjs --phase=resume
 *
 * --phase=suite (default) runs without retaining credentials. It reports restart
 * as pending; expiry is pending unless M1_EXPIRY_WAIT=yes or already elapsed.
 * --phase=prepare runs the suite, then leaves approved work durably paused and
 * saves the minimum resume credentials ONLY in ignored .state/, mode 0600.
 * --phase=resume consumes that file after an externally evidenced real restart.
 * M1_STATE_FILE selects separate ignored .state/<private-directory>/<file> handoffs.
 * M1_AUTONOMOUS_WAIT_MS defaults to 70000; hosted use must cover its native alarm interval.
 * No passwords, session cookies, bearer tokens, or protected notes are printed.
 * Exit 0: every gate passed; 1: failed; 2: incomplete/pending external proof.
 * The target must be disposable: synthetic auth/org/control records remain.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL = "2025-06-18";
const NAMESPACE = "com.toolcontrolplane/execution";
const PREFIX = "Tool Control Plane execution: ";
const FIXTURE = "fixture.counter.increment";
const MIN_APPROVAL_MS = 15 * 60 * 1000;
const CRASH_LEASE_MS = 60_000;
const PRODUCTION_HOSTS = new Set([
  "cfl-mcpone-3e4b5c9dc0.ryandetzel3409.workers.dev",
  "cfl-lifecycle-controller-65ec5d0bab.ryandetzel3409.workers.dev",
]);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATE = resolve(
  ROOT,
  process.env.M1_STATE_FILE ?? ".state/m1-conformance/restart.json",
);
const STATE_DIR = dirname(STATE);
const TERMINAL = new Set([
  "succeeded",
  "denied",
  "blocked",
  "expired",
  "canceled",
  "failed",
  "outcome_unknown",
]);
const VALID_STATUS = new Set([
  "pending_approval",
  "queued",
  "running",
  ...TERMINAL,
]);
const gates = {};
const notes = new Set();
let base;
let phase = "suite";
let rpcSequence = 0;
let currentGate = "target_safety";
let failureReason = "Conformance assertion failed";
const startedAt = Date.now();
const pollTimeout = Number(process.env.M1_POLL_TIMEOUT_MS ?? 120_000);
const autonomousWait = Number(process.env.M1_AUTONOMOUS_WAIT_MS ?? 70_000);

function verify(condition, message) {
  failureReason = message;
  assert.ok(condition, message);
}
function equal(actual, expected, message) {
  failureReason = message;
  assert.equal(actual, expected, message);
}
function deepEqual(actual, expected, message) {
  failureReason = message;
  assert.deepEqual(actual, expected, message);
}
const sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
function protectedNote() {
  const note = `protected-m1-${randomUUID()}-never-display`;
  notes.add(note);
  return note;
}
function scanProtected(text) {
  for (const note of notes) {
    verify(!text.includes(note), "Protected note appeared in an HTTP response");
  }
}
async function gate(name, action) {
  currentGate = name;
  const began = Date.now();
  await action();
  gates[name] = { status: "pass", elapsed_ms: Date.now() - began };
}
function pending(name, reason, extra = {}) {
  gates[name] = { status: "pending", reason, ...extra };
}
function report() {
  const statuses = Object.values(gates).map((entry) => entry.status);
  const status = statuses.includes("fail")
    ? "fail"
    : statuses.includes("pending")
      ? "pending"
      : "pass";
  console.log(
    JSON.stringify(
      {
        proof: "M1 black-box HTTP behavior",
        protocol: PROTOCOL,
        protocol_client_certification: "not_claimed",
        phase,
        target_origin: base?.origin ?? null,
        status,
        elapsed_ms: Date.now() - startedAt,
        gates,
      },
      null,
      2,
    ),
  );
  process.exitCode = status === "fail" ? 1 : status === "pending" ? 2 : 0;
}

async function request(
  client,
  path,
  { method = "GET", body, headers = {}, status, rawBody } = {},
) {
  const requestHeaders = new Headers({
    accept: "application/json",
    origin: base.origin,
    ...headers,
  });
  if (client?.cookie) requestHeaders.set("cookie", client.cookie);
  if (
    (body !== undefined || rawBody !== undefined) &&
    !requestHeaders.has("content-type")
  )
    requestHeaders.set("content-type", "application/json");
  failureReason = "HTTP request failed or timed out";
  const response = await fetch(new URL(path, base), {
    method,
    headers: requestHeaders,
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (client) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const split = pair.indexOf("=");
      verify(split > 0, "Auth response contained a malformed cookie");
      client.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    client.cookie = [...client.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
  const text = await response.text();
  if (path.startsWith("/mcp/"))
    verify(
      Buffer.byteLength(text, "utf8") <= 1024 * 1024,
      "Serialized MCP response exceeded the one-MiB transport bound",
    );
  scanProtected(text);
  if (status !== undefined)
    equal(
      response.status,
      status,
      `HTTP ${method} ${new URL(path, base).pathname} returned ${response.status}; expected ${status}`,
    );
  let json = null;
  if (text) {
    verify(
      response.headers.get("content-type")?.includes("application/json"),
      "HTTP endpoint did not return JSON",
    );
    failureReason = "HTTP endpoint returned invalid JSON";
    json = JSON.parse(text);
  }
  return {
    status: response.status,
    ok: response.ok,
    json,
    text,
    headers: response.headers,
  };
}
async function owner(client, path, options = {}) {
  const response = await request(client, path, options);
  verify(
    response.ok && response.json,
    "Owner endpoint rejected an authorized operation",
  );
  return response.json;
}
async function rejectOwner(client, path, options = {}) {
  const response = await request(client, path, options);
  verify(
    [401, 403, 404].includes(response.status),
    "Protected owner endpoint allowed a non-owner or foreign organization",
  );
  verify(
    response.json?.error,
    "Owner authorization denial lacked a structured error",
  );
}
async function signup(label) {
  const client = { cookies: new Map(), cookie: "", orgId: null };
  const email = `m1-${randomUUID()}@example.com`;
  // Random password exists only in memory for this one synthetic signup.
  const password = randomBytes(32).toString("base64url");
  const response = await request(client, "/api/auth/sign-up/email", {
    method: "POST",
    body: { name: `M1 ${label}`, email, password },
    status: 200,
  });
  verify(
    typeof response.json?.user?.id === "string" && client.cookie.length > 0,
    "BetterAuth signup did not establish a real session",
  );
  const slug = `m1-${randomUUID()}`;
  const org = await request(client, "/api/auth/organization/create", {
    method: "POST",
    body: { name: `M1 disposable ${label}`, slug },
    status: 200,
  });
  verify(
    typeof org.json?.id === "string",
    "BetterAuth organization creation did not return an organization",
  );
  client.orgId = org.json.id;
  await request(client, "/api/auth/organization/set-active", {
    method: "POST",
    body: { organizationSlug: slug },
    status: 200,
  });
  const session = await request(client, "/api/auth/get-session", {
    status: 200,
  });
  equal(
    session.json?.session?.activeOrganizationId,
    client.orgId,
    "BetterAuth active organization was not persisted in the session",
  );
  equal(
    session.json?.user?.email,
    email,
    "BetterAuth session did not belong to the synthetic user",
  );
  return client;
}
async function setup(client, label) {
  const data = await owner(client, "/api/control/setup", {
    method: "POST",
    body: { label },
  });
  verify(
    typeof data.profileId === "string",
    "Fixture setup did not return a Profile ID",
  );
  equal(data.tool, FIXTURE, "Fixture setup returned the wrong canonical tool");
  return data.profileId;
}
function apiDate(value) {
  verify(
    typeof value === "string",
    "Owner API timestamps must be ISO 8601 strings",
  );
  const time = Date.parse(value);
  verify(
    Number.isFinite(time) && new Date(time).toISOString() === value,
    "Owner API returned an invalid or noncanonical UTC timestamp",
  );
  return time;
}
async function grant(client, profileId, label, options = {}) {
  const data = await owner(
    client,
    `/api/control/profiles/${profileId}/grants`,
    {
      method: "POST",
      body: {
        label,
        ...options,
        ...(typeof options.expiresAt === "number"
          ? { expiresAt: new Date(options.expiresAt).toISOString() }
          : {}),
      },
    },
  );
  verify(
    typeof data.grantId === "string" &&
      typeof data.token === "string" &&
      data.token.length >= 24,
    "Grant issuance did not return an opaque token and separate ID",
  );
  return {
    ...data,
    expiresAt: data.expiresAt === null ? null : apiDate(data.expiresAt),
    profileId,
    url: `/mcp/${profileId}`,
  };
}
async function profile(client, profileId, body) {
  return owner(client, `/api/control/profiles/${profileId}`, {
    method: "PATCH",
    body,
  });
}
async function rules(client, profileId, entries) {
  return owner(
    client,
    profileId === null
      ? "/api/control/policies"
      : `/api/control/profiles/${profileId}/policies`,
    {
      method: "PUT",
      body: { rules: entries },
    },
  );
}
const rule = (decision, pattern = FIXTURE) => ({ pattern, decision });
const stats = (client) => owner(client, "/api/control/fixture");
async function unchanged(client, before) {
  deepEqual(
    await stats(client),
    before,
    "A non-dispatching operation changed fixture effects",
  );
}
async function effects(client, before, writes, total) {
  const after = await stats(client);
  equal(
    after.writes - before.writes,
    writes,
    "Fixture write count did not match the expected effect count",
  );
  equal(
    after.total - before.total,
    total,
    "Fixture total did not match the original frozen numeric value",
  );
}
async function rpcRaw(identity, method, params, options = {}) {
  const { id = ++rpcSequence, headers = {}, ...requestOptions } = options;
  const response = await request(null, identity.url, {
    ...requestOptions,
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${identity.token}`,
      ...(method === "initialize" ? {} : { "mcp-protocol-version": PROTOCOL }),
      ...headers,
    },
    body: {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    },
  });
  return { ...response, requestId: id };
}
async function rpc(identity, method, params) {
  const response = await rpcRaw(identity, method, params);
  equal(response.status, 200, "MCP request returned an unexpected HTTP status");
  equal(response.json?.jsonrpc, "2.0", "MCP response was not JSON-RPC 2.0");
  equal(
    response.json?.id,
    response.requestId,
    "MCP response did not echo the request ID",
  );
  verify(
    !response.json.error && response.json.result,
    "MCP request unexpectedly returned a JSON-RPC error",
  );
  return response.json.result;
}
function control(result) {
  verify(Array.isArray(result.content), "MCP tool result omitted text content");
  const blocks = result.content.filter(
    (block) =>
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.startsWith(PREFIX),
  );
  equal(
    blocks.length,
    1,
    "MCP tool result omitted or duplicated its readable execution control block",
  );
  failureReason = "Execution control text contained invalid JSON";
  const run = JSON.parse(blocks[0].text.slice(PREFIX.length));
  const meta = result._meta?.[NAMESPACE];
  verify(
    meta && typeof meta.run_id === "string" && typeof meta.tool === "string",
    "MCP execution metadata omitted run_id or tool",
  );
  verify(
    Object.keys(meta).every((key) =>
      ["run_id", "tool", "accounts"].includes(key),
    ),
    "MCP execution metadata leaked control fields or arguments",
  );
  equal(
    run.run_id,
    meta.run_id,
    "Text control and execution metadata disagreed about Run identity",
  );
  equal(
    run.tool,
    meta.tool,
    "Text control and execution metadata disagreed about Tool identity",
  );
  verify(
    VALID_STATUS.has(run.status),
    "Execution control contained an unknown Run status",
  );
  verify(
    typeof result.isError === "boolean",
    "MCP tool result omitted isError",
  );
  verify(
    !("accounts" in meta) && !("accounts" in run),
    "Fixture result emitted empty Account provenance without selecting an Account",
  );
  equal(
    result.content.at(-1),
    blocks[0],
    "Execution fallback was not the final content block",
  );
  equal(
    result.isError,
    Boolean(run.error) ||
      (TERMINAL.has(run.status) && run.status !== "succeeded"),
    "MCP isError disagreed with durable control status",
  );
  return run;
}
async function invoke(identity, args, key = randomUUID(), name = FIXTURE) {
  return control(
    await rpc(identity, "tools/call", {
      name,
      arguments: args,
      _meta: {
        [NAMESPACE]: {
          idempotency_key: key,
          trace_id: `trace-${randomUUID()}`,
        },
      },
    }),
  );
}
async function invokeNumericSyntax(identity, note, key) {
  const id = ++rpcSequence;
  const response = await request(null, identity.url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${identity.token}`,
      "mcp-protocol-version": PROTOCOL,
    },
    rawBody: `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":${JSON.stringify(FIXTURE)},"arguments":{"value":2.9e1,"note":${JSON.stringify(note)}},"_meta":{${JSON.stringify(NAMESPACE)}:{"idempotency_key":${JSON.stringify(key)}}}}}`,
    status: 200,
  });
  equal(
    response.json?.id,
    id,
    "Numeric-equivalent JSON request did not retain its request ID",
  );
  verify(
    response.json?.result && !response.json.error,
    "Canonical numeric-equivalent JSON request was rejected",
  );
  return control(response.json.result);
}
async function getRun(identity, runId) {
  return control(
    await rpc(identity, "tools/call", {
      name: "runs.get",
      arguments: { run_id: runId },
    }),
  );
}
async function rejectMcp(identity, method, params, allowedCodes, options = {}) {
  const response = await rpcRaw(identity, method, params, options);
  const error = response.json?.error;
  let code = error?.data?.code ?? error?.code;
  if (response.json?.result?.isError)
    code = control(response.json.result).error?.code;
  verify(
    !response.ok || error || response.json?.result?.isError,
    "MCP authorization or conflict request was incorrectly accepted",
  );
  if (allowedCodes)
    verify(
      allowedCodes.includes(code),
      "MCP denial returned an unexpected error code",
    );
}
async function rejectRetrieve(identity, runId) {
  await rejectMcp(
    identity,
    "tools/call",
    { name: "runs.get", arguments: { run_id: runId } },
    [
      "forbidden",
      "not_found",
      "unauthenticated",
      "grant_revoked",
      "profile_disabled",
    ],
  );
}
async function ownerRun(client, runId) {
  const run = await owner(client, `/api/control/runs/${runId}`);
  equal(run.runId, runId, "Owner lookup returned the wrong Run");
  run.createdAt = apiDate(run.createdAt);
  run.deadline = run.deadline === null ? null : apiDate(run.deadline);
  gates.owner_api_iso_dates = { status: "pass" };
  verify(
    VALID_STATUS.has(run.status) && Number.isInteger(run.attempts),
    "Owner Run response lacked valid status or attempt count",
  );
  verify(
    !("arguments" in run) &&
      !("payload" in run) &&
      !("protectedPayload" in run),
    "Owner Run exposed a replay payload instead of a safe display",
  );
  return run;
}
async function waitOwner(client, runId, expected, timeout = pollTimeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    const run = await ownerRun(client, runId);
    if (expected.includes(run.status)) return run;
    verify(!TERMINAL.has(run.status), "Run terminated in an unexpected status");
    await sleep(200);
  }
  verify(
    false,
    "Run did not reach its expected durable status before the timeout",
  );
}
async function drain(client, count = 1) {
  await Promise.all(
    Array.from({ length: count }, () =>
      owner(client, "/api/control/drain", { method: "POST", body: {} }),
    ),
  );
}
async function initialize(identity) {
  const initialized = await rpc(identity, "initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "m1-http-conformance", version: "1.0.0" },
  });
  equal(
    initialized.protocolVersion,
    PROTOCOL,
    "MCP initialization did not negotiate the requested M1 protocol",
  );
  verify(
    initialized.capabilities?.tools && initialized.serverInfo?.name,
    "MCP initialization omitted Tool capability or server identity",
  );
  const notification = await request(null, identity.url, {
    method: "POST",
    status: 202,
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${identity.token}`,
      "mcp-protocol-version": PROTOCOL,
    },
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  equal(notification.text, "", "Initialized notification returned a body");
}
async function discover(identity) {
  const result = await rpc(identity, "tools/list", {});
  verify(
    Array.isArray(result.tools),
    "Tool discovery did not return a Tool list",
  );
  return result.tools;
}

async function checkExpiry(context, wait) {
  const { expiryClient: client, expiry, expiryBaseline } = context;
  currentGate = "real_15_minute_expiry";
  const deadline = Math.max(expiry.deadline, expiry.queuedDeadline);
  if (Date.now() < deadline && !wait) {
    const details = { deadline, remaining_ms: deadline - Date.now() };
    pending(
      "real_15_minute_expiry",
      "Real pending-approval deadline has not elapsed; not a pass",
      details,
    );
    pending(
      "approved_queue_start_after_deadline_expiry",
      "Approved queued work has not reached its real dispatch deadline; not a pass",
      details,
    );
    return;
  }
  if (Date.now() <= deadline) await sleep(deadline - Date.now() + 300);
  // Both original deadlines have elapsed before the paused queue is released.
  await profile(client, expiry.profileId, { dispatchPaused: false });
  await drain(client);
  await gate("real_15_minute_expiry", async () => {
    const expired = await waitOwner(client, expiry.runId, ["expired"]);
    equal(
      expired.deadline,
      expiry.deadline,
      "Pending approval deadline changed after creation",
    );
    equal(
      (await getRun(expiry.grant, expiry.runId)).status,
      "expired",
      "Grant lookup did not preserve terminal expiry",
    );
    const denied = await request(
      client,
      `/api/control/runs/${expiry.runId}/approve`,
      { method: "POST", body: {} },
    );
    verify(
      !denied.ok || denied.json?.status === "expired",
      "Owner approval revived an expired Run",
    );
    await drain(client, 3);
    await unchanged(client, expiryBaseline);
  });
  await gate("approved_queue_start_after_deadline_expiry", async () => {
    const expired = await waitOwner(client, expiry.queuedRunId, ["expired"]);
    equal(
      expired.deadline,
      expiry.queuedDeadline,
      "Approved queue deadline changed after creation",
    );
    equal(
      (await getRun(expiry.grant, expiry.queuedRunId)).status,
      "expired",
      "Approved queued Run dispatched after its immutable deadline",
    );
    await drain(client, 6);
    await unchanged(client, expiryBaseline);
  });
}

async function suite() {
  let client;
  let foreign;
  let profileId;
  let primary;
  let second;
  let expiry;
  let expiryClient;
  let crash;
  await gate("betterauth_owner_and_fixture_setup", async () => {
    [client, foreign, expiryClient] = await Promise.all([
      signup("owner"),
      signup("foreign-owner"),
      signup("expiry-owner"),
    ]);
    profileId = await setup(client, "primary-profile");
    primary = await grant(client, profileId, "primary-caller");
    second = await grant(client, profileId, "separate-caller", {
      expiresAt: null,
    });
    equal(
      second.expiresAt,
      null,
      "Explicit non-expiring grant did not preserve null expiry",
    );
    // Workspace-wide restriction tests must not cancel the real expiry fixtures.
    const expiryProfileId = await setup(expiryClient, "real-expiry-profile");
    const expiryGrant = await grant(
      expiryClient,
      expiryProfileId,
      "expiry-caller",
    );
    await profile(expiryClient, expiryProfileId, {
      approvalLifetimeMs: MIN_APPROVAL_MS,
      dispatchPaused: true,
    });
    const short = await request(
      expiryClient,
      `/api/control/profiles/${expiryProfileId}`,
      { method: "PATCH", body: { approvalLifetimeMs: 1000 } },
    );
    equal(
      short.status,
      400,
      "Approval lifetime below fifteen minutes was accepted",
    );
    await initialize(expiryGrant);
    const pendingRun = await invoke(expiryGrant, {
      value: 107,
      note: protectedNote(),
    });
    equal(
      pendingRun.status,
      "pending_approval",
      "Default no-match policy was not Ask",
    );
    const saved = await ownerRun(expiryClient, pendingRun.run_id);
    verify(
      Number.isInteger(saved.deadline) &&
        saved.deadline - saved.createdAt >= MIN_APPROVAL_MS,
      "Real pending approval used less than the minimum fifteen-minute lifetime",
    );
    verify(
      saved.deadline - saved.createdAt <= MIN_APPROVAL_MS + 1000,
      "Expiry test was not configured for an actual fifteen-minute deadline",
    );
    const queuedPending = await invoke(expiryGrant, {
      value: 113,
      note: protectedNote(),
    });
    equal(
      queuedPending.status,
      "pending_approval",
      "Queued-deadline proof did not begin pending",
    );
    await owner(
      expiryClient,
      `/api/control/runs/${queuedPending.run_id}/approve`,
      {
        method: "POST",
        body: {},
      },
    );
    const queued = await ownerRun(expiryClient, queuedPending.run_id);
    equal(
      queued.status,
      "queued",
      "Pre-deadline approval was not durably queued while paused",
    );
    verify(
      Number.isInteger(queued.deadline) &&
        queued.deadline - queued.createdAt >= MIN_APPROVAL_MS,
      "Approved queue did not retain a real fifteen-minute deadline",
    );
    expiry = {
      profileId: expiryProfileId,
      runId: saved.runId,
      deadline: saved.deadline,
      queuedRunId: queued.runId,
      queuedDeadline: queued.deadline,
      grant: expiryGrant,
    };
  });
  await gate("mcp_transport_and_stable_profile_discovery", async () => {
    await initialize(primary);
    await initialize(second);
    equal(
      primary.url,
      second.url,
      "Grants changed the stable Profile endpoint",
    );
    verify(
      !primary.url.includes(primary.token) &&
        !second.url.includes(second.token),
      "Grant token was embedded in the Profile URL",
    );
    const tools = await discover(primary);
    const fixture = tools.find((tool) => tool.name === FIXTURE);
    verify(
      fixture?.inputSchema?.type === "object",
      "Fixture was not discoverable with a JSON input schema",
    );
    verify(
      tools.some((tool) => tool.name === "runs.get"),
      "Run retrieval Tool was not advertised",
    );
    verify(
      fixture.inputSchema.properties?.fault?.enum?.includes(
        "crash_after_claim",
      ),
      "Fixture fault modes were not explicitly advertised",
    );
    for (const method of ["GET", "DELETE"]) {
      const response = await request(null, primary.url, {
        method,
        status: 405,
        headers: {
          authorization: `Bearer ${primary.token}`,
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL,
        },
      });
      equal(
        response.headers.get("allow"),
        "POST",
        "Unsupported MCP transport method omitted Allow: POST",
      );
    }
    const anonymous = await request(null, primary.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      headers: {
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
      },
    });
    verify(
      [401, 403].includes(anonymous.status),
      "MCP endpoint allowed discovery without a Grant",
    );
    await rejectMcp(primary, "tools/list", {}, undefined, {
      headers: { origin: "https://foreign-origin.invalid" },
    });
    await rejectMcp(primary, "tools/list", {}, ["unsupported_protocol"], {
      headers: { "mcp-protocol-version": "2024-11-05" },
    });
    await rejectMcp(primary, "tools/list", {}, undefined, {
      headers: { origin: "null" },
    });
    const missingVersion = await request(null, primary.url, {
      method: "POST",
      status: 400,
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${primary.token}`,
      },
      body: { jsonrpc: "2.0", id: 901, method: "tools/list", params: {} },
    });
    verify(
      missingVersion.json?.error,
      "Missing protocol version did not produce a structured transport error",
    );
    for (const headers of [
      { accept: "application/json" },
      { "content-type": "text/plain" },
    ]) {
      await rejectMcp(primary, "tools/list", {}, undefined, { headers });
    }
    const unknownMethod = await rpcRaw(primary, "m1.unknown", {});
    equal(
      unknownMethod.json?.error?.code,
      -32601,
      "Unsupported MCP method did not return JSON-RPC method-not-found",
    );
  });
  await gate("bounded_rpc_correlation", async () => {
    await rules(client, profileId, [rule("allow")]);
    const before = await stats(client);
    for (const id of ["r", "r".repeat(128)]) {
      const response = await rpcRaw(primary, "tools/list", {}, { id });
      equal(response.status, 200, "Valid bounded RPC ID was rejected");
      equal(response.json?.id, id, "Valid bounded RPC ID lost correlation");
      verify(
        response.json?.result && !response.json.error,
        "Valid bounded RPC ID did not return discovery",
      );
    }
    const params = { name: FIXTURE, arguments: { value: 0 } };
    const envelope = { jsonrpc: "2.0", id: "", method: "tools/call", params };
    const nearLimitLength =
      1024 * 1024 - Buffer.byteLength(JSON.stringify(envelope), "utf8") - 1;
    for (const id of ["", "r".repeat(129), "r".repeat(nearLimitLength)]) {
      const response = await rpcRaw(primary, "tools/call", params, { id });
      verify(
        !response.ok && response.json?.error,
        "Invalid RPC ID did not fail before dispatch",
      );
      equal(response.json?.id, null, "Invalid RPC ID was echoed in an error");
      equal(
        response.json?.error?.code,
        -32600,
        "Invalid RPC ID did not return invalid-request",
      );
      verify(
        Buffer.byteLength(response.text, "utf8") <= 4096,
        "Invalid RPC ID did not return a compact safe error",
      );
    }
    await drain(client, 2);
    await unchanged(client, before);
    const sharedId = "correlation-only";
    const keyedParams = {
      ...params,
      _meta: { [NAMESPACE]: { idempotency_key: randomUUID() } },
    };
    const first = await rpcRaw(primary, "tools/call", keyedParams, {
      id: sharedId,
    });
    const secondCall = await rpcRaw(primary, "tools/call", params, {
      id: sharedId,
    });
    equal(first.json?.id, sharedId, "Invocation lost RPC correlation");
    equal(secondCall.json?.id, sharedId, "Repeated RPC ID lost correlation");
    const firstRun = control(first.json?.result);
    const secondRun = control(secondCall.json?.result);
    verify(
      firstRun.run_id !== secondRun.run_id,
      "RPC correlation ID incorrectly deduplicated business invocations",
    );
    await waitOwner(client, firstRun.run_id, ["succeeded"]);
    await waitOwner(client, secondRun.run_id, ["succeeded"]);
    const replay = await rpcRaw(primary, "tools/call", keyedParams, {
      id: "different-correlation",
    });
    equal(
      replay.json?.id,
      "different-correlation",
      "Keyed replay did not retain its new RPC correlation ID",
    );
    equal(
      control(replay.json?.result).run_id,
      firstRun.run_id,
      "Changing RPC correlation ID replaced a business-keyed Run",
    );
    await effects(client, before, 2, 0);
  });
  await gate(
    "strict_metadata_boundaries_and_malformed_json_no_effect",
    async () => {
      await rules(client, profileId, [rule("allow")]);
      const before = await stats(client);
      const validKeys = ["a", "A", " a ", "x".repeat(128)];
      const runIds = new Set();
      for (const key of validKeys) {
        const run = await invoke(primary, { value: 0 }, key);
        runIds.add(run.run_id);
        await waitOwner(client, run.run_id, ["succeeded"]);
      }
      equal(
        runIds.size,
        validKeys.length,
        "Caller keys did not preserve spaces and case exactly",
      );
      for (const metadata of [
        { idempotency_key: "" },
        { idempotency_key: "x".repeat(129) },
        { idempotency_key: String.fromCharCode(1) },
        { idempotency_key: "é" },
        { idempotency_key: 1 },
        { idempotency_key: null },
        { trace_id: "" },
        { trace_id: "x".repeat(129) },
        { trace_id: String.fromCharCode(1) },
        { trace_id: "é" },
        { status: "allow" },
      ]) {
        await rejectMcp(primary, "tools/call", {
          name: FIXTURE,
          arguments: { value: 1000 },
          _meta: { [NAMESPACE]: metadata },
        });
      }
      for (const rawBody of [
        `{"jsonrpc":"2.0","id":10001,"method":"tools/call","params":{"name":${JSON.stringify(FIXTURE)},"arguments":{"value":1,"value":2}}}`,
        `{"jsonrpc":"2.0","id":10002,"method":"tools/call","params":{"name":${JSON.stringify(FIXTURE)},"arguments":{"value":1e400}}}`,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 10003,
          method: "tools/call",
          params: {
            name: FIXTURE,
            arguments: { value: 1, note: String.fromCharCode(0xd800) },
          },
        }),
      ]) {
        const rejected = await request(null, primary.url, {
          method: "POST",
          rawBody,
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${primary.token}`,
            "mcp-protocol-version": PROTOCOL,
          },
        });
        verify(
          !rejected.ok ||
            rejected.json?.error ||
            rejected.json?.result?.isError,
          "Malformed canonical JSON was accepted as executable work",
        );
      }
      await drain(client, 4);
      await effects(client, before, validKeys.length, 0);
    },
  );
  await gate("grant_labels_and_expired_retrieval", async () => {
    const duplicate = await request(
      client,
      `/api/control/profiles/${profileId}/grants`,
      { method: "POST", body: { label: "primary-caller" } },
    );
    verify(
      [400, 409].includes(duplicate.status) && duplicate.json?.error,
      "Duplicate confirmed Grant label was accepted",
    );
    const temporary = await grant(client, profileId, `short-${randomUUID()}`, {
      expiresAt: Date.now() + 10_000,
    });
    await initialize(temporary);
    await rules(client, profileId, [rule("ask")]);
    const before = await stats(client);
    const run = await invoke(temporary, { value: 1001, note: protectedNote() });
    equal(
      run.status,
      "pending_approval",
      "Grant expiration proof did not begin pending",
    );
    await sleep(Math.max(0, temporary.expiresAt - Date.now() + 100));
    await rejectMcp(
      temporary,
      "tools/call",
      { name: "runs.get", arguments: { run_id: run.run_id } },
      ["grant_expired", "unauthenticated", "forbidden"],
    );
    await owner(client, `/api/control/runs/${run.run_id}/cancel`, {
      method: "POST",
      body: {},
    });
    await unchanged(client, before);
  });
  // Start the real sixty-second uncertainty lease early, alongside the expiry clock.
  await gate("crash_claim_has_no_immediate_effect", async () => {
    await rules(client, profileId, [rule("allow")]);
    const before = await stats(client);
    const key = randomUUID();
    const args = {
      value: 109,
      note: protectedNote(),
      fault: "crash_after_claim",
    };
    const run = await invoke(primary, args, key);
    const claimed = await waitOwner(client, run.run_id, ["running"]);
    equal(claimed.attempts, 1, "Crash fixture was not claimed exactly once");
    equal(
      (await invoke(primary, args, key)).run_id,
      run.run_id,
      "Duplicate active crash claim replaced its original Run",
    );
    await unchanged(client, before);
    crash = { runId: run.run_id, key, args, began: Date.now() };
  });
  await gate("allow_one_write_and_retrieval_never_replays", async () => {
    const before = await stats(client);
    const args = { value: 7, note: protectedNote() };
    const key = randomUUID();
    const run = await invoke(primary, args, key);
    await waitOwner(client, run.run_id, ["succeeded"]);
    for (let index = 0; index < 5; index++)
      equal(
        (await getRun(primary, run.run_id)).status,
        "succeeded",
        "Terminal retrieval did not remain succeeded",
      );
    equal(
      (await invoke(primary, args, key)).run_id,
      run.run_id,
      "Identical completed invocation did not reuse its durable Run",
    );
    await effects(client, before, 1, 7);
  });
  await gate("block_auditable_without_effect", async () => {
    await rules(client, profileId, [rule("block")]);
    const before = await stats(client);
    const run = await invoke(primary, { value: 11, note: protectedNote() });
    equal(run.status, "blocked", "Block policy did not return a blocked Run");
    const saved = await ownerRun(client, run.run_id);
    equal(
      saved.status,
      "blocked",
      "Block denial was not durably owner-auditable",
    );
    equal(
      (await getRun(primary, run.run_id)).status,
      "blocked",
      "Blocked Run was not retrievable without dispatch",
    );
    await unchanged(client, before);
  });
  await gate("ask_wait_and_owner_deny_without_effect", async () => {
    await rules(client, profileId, [rule("ask")]);
    const before = await stats(client);
    const run = await invoke(primary, { value: 17, note: protectedNote() });
    equal(
      run.status,
      "pending_approval",
      "Ask did not produce a pending approval",
    );
    verify(
      typeof run.approval_url === "string",
      "Pending approval omitted its owner approval URL",
    );
    for (let index = 0; index < 3; index++)
      equal(
        (await getRun(primary, run.run_id)).status,
        "pending_approval",
        "Retrieval caused pending approval to dispatch",
      );
    await drain(client, 4);
    await unchanged(client, before);
    await owner(client, `/api/control/runs/${run.run_id}/deny`, {
      method: "POST",
      body: {},
    });
    await waitOwner(client, run.run_id, ["denied"]);
    await drain(client, 4);
    equal(
      (await getRun(primary, run.run_id)).status,
      "denied",
      "Denied Run did not remain terminal",
    );
    await unchanged(client, before);
  });
  await gate(
    "owner_approve_frozen_arguments_and_protected_display",
    async () => {
      const before = await stats(client);
      const key = randomUUID();
      const args = { value: 23, note: protectedNote() };
      const run = await invoke(primary, args, key);
      equal(
        run.status,
        "pending_approval",
        "Frozen argument proof did not begin pending",
      );
      const original = await ownerRun(client, run.run_id);
      equal(
        original.displayArguments?.value,
        23,
        "Owner display did not preserve the original numeric value",
      );
      equal(
        original.displayArguments?.note,
        "[redacted]",
        "Owner display did not redact the protected note",
      );
      verify(
        typeof original.frozenToolRevision === "string",
        "Owner inspection omitted immutable Tool revision provenance",
      );
      await profile(client, profileId, {
        approvalLifetimeMs: 30 * 60 * 1000,
        dispatchPaused: true,
      });
      await rules(client, profileId, [rule("ask", "fixture.*"), rule("ask")]);
      await rejectMcp(
        primary,
        "tools/call",
        {
          name: FIXTURE,
          arguments: { value: 2300, note: args.note },
          _meta: { [NAMESPACE]: { idempotency_key: key } },
        },
        ["idempotency_conflict"],
      );
      const frozen = await ownerRun(client, run.run_id);
      equal(
        frozen.deadline,
        original.deadline,
        "Configuration mutation changed a pending Run's original deadline",
      );
      equal(
        frozen.frozenToolRevision,
        original.frozenToolRevision,
        "Configuration mutation changed the frozen Tool revision",
      );
      equal(
        frozen.displayArguments?.value,
        23,
        "Changed request rewrote original pending display arguments",
      );
      await owner(client, "/api/control/runs");
      await owner(client, `/api/control/runs/${run.run_id}/approve`, {
        method: "POST",
        body: {},
      });
      equal(
        (await ownerRun(client, run.run_id)).status,
        "queued",
        "Owner approval did not persist queued work",
      );
      await unchanged(client, before);
      await profile(client, profileId, { dispatchPaused: false });
      // Zero HTTP traffic throughout a complete scheduling interval. Checking
      // immediately afterward cannot substitute a polling-triggered drain.
      await sleep(autonomousWait);
      equal(
        (await ownerRun(client, run.run_id)).status,
        "succeeded",
        "Autonomous scheduling did not finish approved work during the no-HTTP interval",
      );
      for (let index = 0; index < 5; index++) await getRun(primary, run.run_id);
      await owner(client, `/api/control/runs/${run.run_id}/approve`, {
        method: "POST",
        body: {},
      });
      await owner(client, `/api/control/runs/${run.run_id}/approve`, {
        method: "POST",
        body: {},
      });
      await effects(client, before, 1, 23);
    },
  );
  await gate("concurrent_dedup_canonical_json_and_key_conflict", async () => {
    await rules(client, profileId, [rule("allow")]);
    const before = await stats(client);
    const key = randomUUID();
    const note = protectedNote();
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        invoke(
          primary,
          index % 2 ? { note, value: 29 } : { value: 29, note },
          key,
        ),
      ),
    );
    const runId = responses[0].run_id;
    verify(
      responses.every((run) => run.run_id === runId),
      "Concurrent canonical-equivalent requests created different Runs",
    );
    await waitOwner(client, runId, ["succeeded"]);
    equal(
      (await invokeNumericSyntax(primary, note, key)).run_id,
      runId,
      "Canonical-equivalent numeric JSON created a different Run",
    );
    await rejectMcp(
      primary,
      "tools/call",
      {
        name: FIXTURE,
        arguments: { value: 30, note },
        _meta: { [NAMESPACE]: { idempotency_key: key } },
      },
      ["idempotency_conflict"],
    );
    await drain(client, 5);
    await effects(client, before, 1, 29);
  });
  await gate("idempotent_membership_denials", async () => {
    await rules(client, profileId, [rule("allow")]);
    const successfulKey = randomUUID();
    const successfulArgs = { value: 0 };
    const successful = await invoke(primary, successfulArgs, successfulKey);
    await waitOwner(client, successful.run_id, ["succeeded"]);
    const before = await stats(client);
    await profile(client, profileId, { toolEnabled: false });
    const key = randomUUID();
    const args = { value: 37 };
    const blocked = await invoke(primary, args, key);
    equal(
      blocked.status,
      "blocked",
      "Disabled membership did not block a new Run",
    );
    equal(
      blocked.error?.code,
      "tool_unavailable",
      "Disabled membership denial lacked its unavailable error",
    );
    equal(
      (await ownerRun(client, blocked.run_id)).status,
      "blocked",
      "Disabled membership denial was not durable",
    );
    deepEqual(
      await invoke(primary, args, key),
      blocked,
      "Repeated disabled-membership key changed the original Run",
    );
    equal(
      (await getRun(primary, blocked.run_id)).run_id,
      blocked.run_id,
      "Active Grant could not retrieve a removed-membership denial",
    );
    const replay = await invoke(primary, successfulArgs, successfulKey);
    equal(
      replay.run_id,
      successful.run_id,
      "Disabled membership replaced an existing successful keyed Run",
    );
    equal(
      replay.status,
      "succeeded",
      "Disabled membership changed an existing successful keyed Run",
    );
    equal(
      (await getRun(primary, successful.run_id)).status,
      "succeeded",
      "Membership removal incorrectly revoked active-Grant Run retrieval",
    );
    for (const conflictKey of [key, successfulKey])
      await rejectMcp(
        primary,
        "tools/call",
        {
          name: FIXTURE,
          arguments: { value: 38 },
          _meta: { [NAMESPACE]: { idempotency_key: conflictKey } },
        },
        ["idempotency_conflict"],
      );
    await unchanged(client, before);
    await profile(client, profileId, { toolEnabled: true });
    deepEqual(
      await invoke(primary, args, key),
      blocked,
      "Membership reenable replaced or executed the original blocked Run",
    );
    equal(
      (await getRun(primary, blocked.run_id)).status,
      "blocked",
      "Membership reenable changed the durable denial",
    );
    await drain(client, 3);
    await unchanged(client, before);
  });
  await gate("safe_before_effect_retry_is_bounded", async () => {
    const before = await stats(client);
    const args = {
      value: 31,
      note: protectedNote(),
      fault: "safe_before_effect",
    };
    const key = randomUUID();
    const run = await invoke(primary, args, key);
    const done = await waitOwner(client, run.run_id, ["succeeded"]);
    verify(
      done.attempts >= 2 && done.attempts <= 3,
      "Proven no-effect transient did not retry within the three-attempt bound",
    );
    for (let index = 0; index < 3; index++)
      equal(
        (await invoke(primary, args, key)).run_id,
        run.run_id,
        "Retry lookup replaced the original Run",
      );
    await drain(client, 6);
    await effects(client, before, 1, 31);
  });
  await gate("after_effect_unknown_never_reexecutes", async () => {
    const before = await stats(client);
    const args = { value: 37, note: protectedNote(), fault: "after_effect" };
    const key = randomUUID();
    const run = await invoke(primary, args, key);
    const unknown = await waitOwner(client, run.run_id, ["outcome_unknown"]);
    equal(unknown.attempts, 1, "Uncertain after-effect write was retried");
    verify(
      unknown.error && unknown.error.retryable === false,
      "Uncertain outcome was incorrectly marked retryable",
    );
    for (let index = 0; index < 5; index++) {
      equal(
        (await getRun(primary, run.run_id)).status,
        "outcome_unknown",
        "Unknown retrieval changed its terminal outcome",
      );
      equal(
        (await invoke(primary, args, key)).run_id,
        run.run_id,
        "Unknown duplicate created a new Run",
      );
    }
    await drain(client, 8);
    await effects(client, before, 1, 37);
  });
  await gate("grant_is_not_owner_and_cross_scope_isolation", async () => {
    const before = await stats(client);
    const run = await invoke(primary, { value: 0 });
    await waitOwner(client, run.run_id, ["succeeded"]);
    const after = await stats(client);
    await rejectOwner(null, `/api/control/runs/${run.run_id}/approve`, {
      method: "POST",
      body: {},
      headers: { authorization: `Bearer ${primary.token}` },
    });
    await rejectOwner(null, `/api/control/profiles/${profileId}/policies`, {
      method: "PUT",
      body: { rules: [rule("allow")] },
      headers: { authorization: `Bearer ${primary.token}` },
    });
    await rejectOwner(null, "/api/control/setup", {
      method: "POST",
      body: { label: "not-an-owner" },
      headers: { authorization: `Bearer ${primary.token}` },
    });
    await rejectOwner(null, `/api/control/runs/${run.run_id}`, {
      headers: { authorization: `Bearer ${primary.token}` },
    });
    await rejectOwner(client, `/api/control/profiles/${profileId}`, {
      method: "PATCH",
      body: { enabled: false },
      headers: { origin: "https://foreign-origin.invalid" },
    });
    await rejectOwner(foreign, `/api/control/runs/${run.run_id}`);
    await rejectOwner(foreign, `/api/control/profiles/${profileId}`, {
      method: "PATCH",
      body: { enabled: false },
    });
    await rejectRetrieve(second, run.run_id);
    const foreignProfile = await setup(foreign, "foreign-profile");
    const foreignGrant = await grant(foreign, foreignProfile, "foreign-caller");
    await initialize(foreignGrant);
    await rejectRetrieve(foreignGrant, run.run_id);
    await rejectMcp({ ...foreignGrant, url: primary.url }, "tools/list", {}, [
      "unauthenticated",
      "forbidden",
      "not_found",
    ]);
    await unchanged(client, after);
    equal(
      after.writes - before.writes,
      1,
      "Isolation setup did not produce exactly one controlled effect",
    );
  });
  await gate(
    "guessed_tool_and_invalid_arguments_are_durable_denials",
    async () => {
      const before = await stats(client);
      const guessed = await invoke(
        primary,
        { value: 41 },
        randomUUID(),
        "fixture.counter.guessed",
      );
      verify(
        ["blocked", "denied", "failed"].includes(guessed.status) &&
          guessed.error?.code === "tool_unavailable",
        "Guessed unavailable Tool did not return a durable denial",
      );
      await ownerRun(client, guessed.run_id);
      await getRun(primary, guessed.run_id);
      const invalid = await invoke(primary, {
        value: "not-an-integer",
        note: protectedNote(),
      });
      verify(
        TERMINAL.has(invalid.status) &&
          invalid.error?.code === "invalid_arguments",
        "Invalid arguments did not produce a durable validation denial",
      );
      await ownerRun(client, invalid.run_id);
      await unchanged(client, before);
    },
  );
  await gate("workspace_outer_block_and_policy_specificity_ties", async () => {
    const before = await stats(client);
    await rules(client, profileId, [rule("allow")]);
    await rules(client, null, [rule("block", "fixture.*")]);
    equal(
      (await invoke(primary, { value: 43 })).status,
      "blocked",
      "Inner exact Allow overrode mandatory workspace Block",
    );
    await rules(client, null, []);
    await rules(client, profileId, [rule("allow", "fixture.*"), rule("block")]);
    equal(
      (await invoke(primary, { value: 43 })).status,
      "blocked",
      "Exact Block did not beat broad Allow",
    );
    await rules(client, profileId, [rule("allow"), rule("block")]);
    equal(
      (await invoke(primary, { value: 43 })).status,
      "blocked",
      "Block did not win an equal-specificity tie",
    );
    await rules(client, profileId, [rule("allow"), rule("ask")]);
    const ask = await invoke(primary, { value: 43 });
    equal(
      ask.status,
      "pending_approval",
      "Ask did not win an equal-specificity Allow tie",
    );
    await owner(client, `/api/control/runs/${ask.run_id}/cancel`, {
      method: "POST",
      body: {},
    });
    await unchanged(client, before);
    await rules(client, profileId, [rule("block", "fixture.*"), rule("allow")]);
    const allowed = await invoke(primary, { value: 43 });
    await waitOwner(client, allowed.run_id, ["succeeded"]);
    await effects(client, before, 1, 43);
    await rules(client, profileId, [
      rule("block", "fixture.*"),
      rule("allow", "fixture.counter.*"),
    ]);
    const longerPrefix = await invoke(primary, { value: 5 });
    await waitOwner(client, longerPrefix.run_id, ["succeeded"]);
    await effects(client, before, 2, 48);
  });
  for (const kind of [
    "block",
    "membership_removed",
    "disabled",
    "revoked",
    "cancel",
  ]) {
    await gate(`pending_restriction_${kind}_never_dispatches`, async () => {
      await rules(client, profileId, [rule("ask")]);
      await profile(client, profileId, {
        enabled: true,
        toolEnabled: true,
        dispatchPaused: false,
      });
      const restrictedGrant =
        kind === "revoked"
          ? await grant(client, profileId, `revoke-${randomUUID()}`)
          : primary;
      const before = await stats(client);
      const run = await invoke(restrictedGrant, {
        value: 47,
        note: protectedNote(),
      });
      equal(
        run.status,
        "pending_approval",
        "Restriction test did not begin pending",
      );
      if (kind === "block") await rules(client, profileId, [rule("block")]);
      if (kind === "membership_removed")
        await profile(client, profileId, { toolEnabled: false });
      if (kind === "disabled")
        await profile(client, profileId, { enabled: false });
      if (kind === "revoked")
        await owner(client, `/api/control/grants/${restrictedGrant.grantId}`, {
          method: "DELETE",
        });
      if (kind === "cancel")
        await owner(client, `/api/control/runs/${run.run_id}/cancel`, {
          method: "POST",
          body: {},
        });
      if (kind !== "cancel") {
        const approval = await request(
          client,
          `/api/control/runs/${run.run_id}/approve`,
          { method: "POST", body: {} },
        );
        verify(
          !approval.ok || approval.json?.status !== "succeeded",
          "Approval bypassed a newly restrictive configuration",
        );
      }
      await drain(client, 5);
      const closed = await waitOwner(client, run.run_id, [
        "blocked",
        "canceled",
        "denied",
      ]);
      verify(closed.status !== "succeeded", "Restricted pending Run succeeded");
      if (kind === "revoked" || kind === "disabled")
        await rejectRetrieve(restrictedGrant, run.run_id);
      if (kind === "membership_removed")
        verify(
          !(await discover(primary)).some((tool) => tool.name === FIXTURE),
          "Removed Tool remained discoverable",
        );
      await unchanged(client, before);
      await profile(client, profileId, { enabled: true, toolEnabled: true });
      await rules(client, profileId, [rule("ask")]);
      await drain(client, 3);
      equal(
        (await ownerRun(client, run.run_id)).status,
        closed.status,
        "Restoring configuration revived a terminal restricted Run",
      );
      await unchanged(client, before);
    });
  }
  await gate(
    "queued_dispatch_rechecks_current_workspace_restrictions",
    async () => {
      const before = await stats(client);
      await profile(client, profileId, { dispatchPaused: true });
      await rules(client, profileId, [rule("ask")]);
      const run = await invoke(primary, { value: 53, note: protectedNote() });
      await owner(client, `/api/control/runs/${run.run_id}/approve`, {
        method: "POST",
        body: {},
      });
      equal(
        (await ownerRun(client, run.run_id)).status,
        "queued",
        "Recheck proof did not persist an approved queue entry",
      );
      await rules(client, null, [rule("block", "fixture.*")]);
      await profile(client, profileId, { dispatchPaused: false });
      await drain(client, 8);
      await waitOwner(client, run.run_id, ["blocked", "canceled"]);
      await unchanged(client, before);
      await rules(client, null, []);
    },
  );
  await gate("concurrent_queue_redelivery_claims_one_effect", async () => {
    const before = await stats(client);
    await profile(client, profileId, { dispatchPaused: true });
    await rules(client, profileId, [rule("ask")]);
    const key = randomUUID();
    const args = { value: 59, note: protectedNote() };
    const run = await invoke(primary, args, key);
    await owner(client, `/api/control/runs/${run.run_id}/approve`, {
      method: "POST",
      body: {},
    });
    await drain(client, 12);
    equal(
      (await ownerRun(client, run.run_id)).status,
      "queued",
      "Owner maintenance pause did not hold queued work",
    );
    await unchanged(client, before);
    await profile(client, profileId, { dispatchPaused: false });
    await Promise.all([
      drain(client, 16),
      ...Array.from({ length: 8 }, () => invoke(primary, args, key)),
    ]);
    const done = await waitOwner(client, run.run_id, ["succeeded"]);
    equal(
      done.attempts,
      1,
      "Concurrent queue redelivery claimed the effect more than once",
    );
    await drain(client, 8);
    await effects(client, before, 1, 59);
  });
  await gate(
    "stale_crash_claim_recovers_unknown_without_redispatch",
    async () => {
      const remaining = crash.began + CRASH_LEASE_MS + 500 - Date.now();
      if (remaining > 0) await sleep(remaining);
      const before = await stats(client);
      await drain(client, 10);
      const recovered = await waitOwner(client, crash.runId, [
        "outcome_unknown",
      ]);
      equal(
        recovered.attempts,
        1,
        "Crash recovery retried an uncertain claimed execution",
      );
      verify(
        recovered.error?.retryable === false,
        "Crash recovery marked uncertain execution retryable",
      );
      for (let index = 0; index < 5; index++)
        equal(
          (await getRun(primary, crash.runId)).status,
          "outcome_unknown",
          "Crash retrieval changed the uncertain outcome",
        );
      equal(
        (await invoke(primary, crash.args, crash.key)).run_id,
        crash.runId,
        "Duplicate uncertain crash claim created a new execution",
      );
      await drain(client, 10);
      await unchanged(client, before);
    },
  );
  const context = {
    client,
    profileId,
    primary,
    expiry,
    expiryClient,
    expiryBaseline: await stats(expiryClient),
  };
  await checkExpiry(context, process.env.M1_EXPIRY_WAIT === "yes");
  return context;
}

async function ensureStateDirectory() {
  const location = relative(ROOT, STATE);
  verify(
    location.startsWith(`.state${sep}`) && location !== `.state${sep}`,
    "Restart credentials must stay inside ignored .state",
  );
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const info = await lstat(STATE_DIR);
  verify(
    info.isDirectory() && !info.isSymbolicLink(),
    "Restart state directory must not be a symlink",
  );
  equal(
    await realpath(STATE_DIR),
    STATE_DIR,
    "Restart state directory resolved outside the ignored project directory",
  );
  verify(
    (info.mode & 0o077) === 0,
    "Restart state directory is accessible to other local users",
  );
}
async function persistRestartState(value) {
  const temporary = `${STATE}.${randomUUID()}.tmp`;
  const updated = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let written = false;
  try {
    await updated.writeFile(`${JSON.stringify(value)}\n`);
    await updated.sync();
    written = true;
  } finally {
    await updated.close();
    if (!written) await unlink(temporary);
  }
  try {
    await rename(temporary, STATE);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
}
function restoreClient(saved) {
  return {
    ...saved,
    cookies: new Map(
      saved.cookie.split("; ").map((pair) => {
        const split = pair.indexOf("=");
        return [pair.slice(0, split), pair.slice(split + 1)];
      }),
    ),
  };
}
async function prepare(context) {
  await gate("restart_approved_queue_prepared", async () => {
    // Check before issuing work, so an existing state file cannot be overwritten.
    await ensureStateDirectory();
    const file = await open(
      STATE,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let wrote = false;
    try {
      await rules(context.client, context.profileId, [rule("ask")]);
      await profile(context.client, context.profileId, {
        dispatchPaused: true,
      });
      const baseline = await stats(context.client);
      const args = { value: 61, note: protectedNote() };
      const key = randomUUID();
      const run = await invoke(context.primary, args, key);
      equal(
        run.status,
        "pending_approval",
        "Restart proof did not begin with an Ask approval",
      );
      await owner(context.client, `/api/control/runs/${run.run_id}/approve`, {
        method: "POST",
        body: {},
      });
      equal(
        (await ownerRun(context.client, run.run_id)).status,
        "queued",
        "Restart proof was not durably queued before disconnection",
      );
      await drain(context.client, 4);
      await unchanged(context.client, baseline);
      // A SECOND actual restart boundary: leave a fresh running claim, not
      // merely the simulated crash already recovered earlier in the suite.
      const claimProfile = await setup(
        context.client,
        "restart-running-claim-profile",
      );
      const claimGrant = await grant(
        context.client,
        claimProfile,
        "restart-running-claim-caller",
      );
      await rules(context.client, claimProfile, [rule("allow")]);
      await initialize(claimGrant);
      const claimArgs = {
        value: 67,
        note: protectedNote(),
        fault: "crash_after_claim",
      };
      const claimKey = randomUUID();
      const claimRun = await invoke(claimGrant, claimArgs, claimKey);
      const claimed = await waitOwner(context.client, claimRun.run_id, [
        "running",
      ]);
      equal(
        claimed.attempts,
        1,
        "Actual restart fixture did not persist one running claim",
      );
      await unchanged(context.client, baseline);
      gates.restart_running_claim_prepared = { status: "pass" };
      // The restart-only credential handoff is never output; no password retained.
      const state = {
        format: "m1-http-restart-v3",
        origin: base.origin,
        preparedAt: Date.now(),
        client: { cookie: context.client.cookie, orgId: context.client.orgId },
        primary: context.primary,
        profileId: context.profileId,
        expiry: context.expiry,
        expiryClient: {
          cookie: context.expiryClient.cookie,
          orgId: context.expiryClient.orgId,
        },
        expiryBaseline: context.expiryBaseline,
        restart: { runId: run.run_id, baseline, key, args },
        claimedRestart: {
          runId: claimRun.run_id,
          grant: claimGrant,
          args: claimArgs,
          key: claimKey,
          began: Date.now(),
        },
        protectedNotes: [...notes],
        gates: {
          ...gates,
          restart_approved_queue_prepared: { status: "pass" },
        },
      };
      await file.writeFile(`${JSON.stringify(state)}\n`);
      await file.sync();
      wrote = true;
    } finally {
      await file.close();
      if (!wrote) await unlink(STATE);
    }
  });
  pending(
    "actual_restart_and_disconnected_queue_recovery",
    "Restart or redeploy the real isolated application, then run --phase=resume; prepared work is not a pass",
  );
  pending(
    "actual_restart_claim_autonomous_uncertainty",
    "Fresh running claim requires actual restart plus autonomous stale-lease recovery; not a pass",
  );
  pending(
    "actual_restart_claim_unknown_never_redispatches",
    "Actual post-claim restart duplicate/retrieval safety remains unexercised",
  );
}
async function resume() {
  currentGate = "restart_state_handoff";
  verify(
    process.env.M1_RESTART_CONFIRMED === "yes",
    "Resume requires explicit confirmation of an actual externally evidenced server restart or redeploy",
  );
  await ensureStateDirectory();
  const file = await open(STATE, constants.O_RDONLY | constants.O_NOFOLLOW);
  let state;
  try {
    const info = await file.stat();
    verify(
      info.isFile() && (info.mode & 0o777) === 0o600,
      "Restart credentials require a regular mode-0600 file",
    );
    failureReason = "Restart state file was invalid";
    state = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  equal(
    state.format,
    "m1-http-restart-v3",
    "Restart state format was unsupported",
  );
  equal(
    state.origin,
    base.origin,
    "Restart credentials belong to a different target origin",
  );
  verify(
    state.restart?.runId &&
      state.claimedRestart?.runId &&
      state.client?.cookie &&
      state.primary?.token,
    "Restart credential handoff was incomplete",
  );
  for (const note of state.protectedNotes ?? []) notes.add(note);
  Object.assign(gates, state.gates);
  const client = restoreClient(state.client);
  const context = {
    ...state,
    client,
    expiryClient: restoreClient(state.expiryClient),
  };
  await gate("actual_restart_running_claim_persisted", async () => {
    const claim = await ownerRun(client, state.claimedRestart.runId);
    verify(
      ["running", "outcome_unknown"].includes(claim.status),
      "Actual restart lost or requeued the durable running barrier",
    );
    equal(
      claim.attempts,
      1,
      "Actual post-claim restart increased the dispatch attempt count",
    );
    await initialize(state.claimedRestart.grant);
    verify(
      ["running", "outcome_unknown"].includes(
        (await getRun(state.claimedRestart.grant, claim.runId)).status,
      ),
      "Grant lookup altered the post-restart running barrier",
    );
  });
  if (gates.actual_restart_and_disconnected_queue_recovery?.status !== "pass") {
    await gate("actual_restart_and_disconnected_queue_recovery", async () => {
      await request(null, "/healthz", { status: 200 });
      const session = await request(client, "/api/auth/get-session", {
        status: 200,
      });
      equal(
        session.json?.session?.activeOrganizationId,
        client.orgId,
        "BetterAuth owner session did not survive the actual restart",
      );
      const run = await ownerRun(client, state.restart.runId);
      if (state.restart.releasedAt) {
        verify(
          ["queued", "running", "succeeded"].includes(run.status),
          "Previously released restart Run lost its durable state",
        );
      } else {
        equal(
          run.status,
          "queued",
          "Approved queue did not survive the actual restart while paused",
        );
        await unchanged(client, state.restart.baseline);
      }
      await initialize(state.primary);
      if (!state.restart.releasedAt) {
        equal(
          (await getRun(state.primary, run.runId)).status,
          "queued",
          "Grant retrieval after restart dispatched paused work",
        );
        state.restart.releasedAt = Date.now();
        await persistRestartState({ ...state, gates });
      }
      await profile(client, state.profileId, { dispatchPaused: false });
      // No original caller, no /drain, and no HTTP during the schedule interval.
      const leaseRemaining = Math.max(
        0,
        state.claimedRestart.began + CRASH_LEASE_MS + 500 - Date.now(),
      );
      await sleep(leaseRemaining + autonomousWait);
      // Check uncertainty BEFORE any duplicate invocation or manual drain can
      // cause recovery. A full interval after lease expiry had zero HTTP.
      const recoveredClaim = await ownerRun(client, state.claimedRestart.runId);
      equal(
        recoveredClaim.status,
        "outcome_unknown",
        "Autonomous scheduling did not recover the actual restarted stale claim",
      );
      equal(
        recoveredClaim.attempts,
        1,
        "Autonomous restart recovery retried an uncertain write",
      );
      gates.actual_restart_claim_autonomous_uncertainty = {
        status: "pass",
        no_http_interval_ms: leaseRemaining + autonomousWait,
      };
      const done = await ownerRun(client, run.runId);
      equal(
        done.status,
        "succeeded",
        "Autonomous scheduling did not recover approved queued work during the no-HTTP interval",
      );
      equal(
        done.attempts,
        1,
        "Actual restart recovery claimed approved work more than once",
      );
      for (let index = 0; index < 5; index++)
        await getRun(state.primary, run.runId);
      equal(
        (await invoke(state.primary, state.restart.args, state.restart.key))
          .run_id,
        run.runId,
        "Restart lost the durable idempotency record",
      );
      await drain(client, 10);
      await effects(client, state.restart.baseline, 1, 61);
    });
    gates.actual_restart_and_disconnected_queue_recovery.evidence =
      "Actual restart/redeploy externally confirmed; durable queue and single effect HTTP-verified after no-HTTP interval";
  } else {
    equal(
      (await ownerRun(client, state.restart.runId)).status,
      "succeeded",
      "Previously verified restart Run lost its terminal result",
    );
    await effects(client, state.restart.baseline, 1, 61);
  }
  await gate("actual_restart_claim_unknown_never_redispatches", async () => {
    const before = await stats(client);
    const claim = await ownerRun(client, state.claimedRestart.runId);
    equal(
      claim.status,
      "outcome_unknown",
      "Actual restarted claim did not retain uncertain outcome",
    );
    equal(claim.attempts, 1, "Actual restarted claim was dispatched again");
    verify(
      claim.error?.retryable === false,
      "Actual restarted uncertain claim was marked retryable",
    );
    for (let index = 0; index < 5; index++)
      equal(
        (await getRun(state.claimedRestart.grant, claim.runId)).status,
        "outcome_unknown",
        "Post-restart retrieval replayed the uncertain claim",
      );
    equal(
      (
        await invoke(
          state.claimedRestart.grant,
          state.claimedRestart.args,
          state.claimedRestart.key,
        )
      ).run_id,
      claim.runId,
      "Post-restart duplicate claim created a new Run",
    );
    await drain(client, 10);
    await unchanged(client, before);
    await effects(client, state.restart.baseline, 1, 61);
  });
  await checkExpiry(context, process.env.M1_EXPIRY_WAIT === "yes");
  if (Object.values(gates).every((entry) => entry.status === "pass")) {
    await unlink(STATE);
  } else {
    // Keep completed restart evidence for a later real-deadline-only resume.
    await persistRestartState({
      ...state,
      client: { cookie: client.cookie, orgId: client.orgId },
      expiryClient: {
        cookie: context.expiryClient.cookie,
        orgId: context.expiryClient.orgId,
      },
      expiryBaseline: context.expiryBaseline,
      gates,
    });
  }
}

try {
  const args = process.argv.slice(2);
  verify(
    args.length <= 1 &&
      (args.length === 0 || /^--phase=(suite|prepare|resume)$/.test(args[0])),
    "Use --phase=suite, --phase=prepare, or --phase=resume",
  );
  if (args[0]) phase = args[0].slice("--phase=".length);
  verify(
    process.env.M1_ALLOW_MUTATION === "yes",
    "Set M1_ALLOW_MUTATION=yes only for a disposable local or isolated hosted database",
  );
  verify(
    process.env.M1_BASE_URL,
    "Set M1_BASE_URL to the disposable target's exact origin",
  );
  base = new URL(process.env.M1_BASE_URL);
  verify(
    ["http:", "https:"].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      base.pathname === "/" &&
      !base.search &&
      !base.hash,
    "M1_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment",
  );
  verify(
    !PRODUCTION_HOSTS.has(base.hostname.toLowerCase().replace(/\.$/, "")),
    "Known production application/controller URLs are prohibited",
  );
  // Re-read README at each execution so newly documented production addresses
  // are also denied, without using source files as evidence of product behavior.
  const readmeFile = await open(resolve(ROOT, "README.md"), "r");
  let readme;
  try {
    readme = await readmeFile.readFile("utf8");
  } finally {
    await readmeFile.close();
  }
  const production =
    readme.match(/### Verified deployment[^\n]*\n([\s\S]*?)(?=\n#{1,3} |$)/g) ??
    [];
  for (const section of production) {
    for (const match of section.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
      verify(
        base.hostname.toLowerCase().replace(/\.$/, "") !==
          match[1].toLowerCase(),
        "README production deployment URL is prohibited",
      );
    }
  }
  verify(
    Number.isInteger(pollTimeout) &&
      pollTimeout >= 3000 &&
      pollTimeout <= 300_000,
    "M1_POLL_TIMEOUT_MS must be an integer from 3000 through 300000",
  );
  verify(
    Number.isInteger(autonomousWait) &&
      autonomousWait >= 1000 &&
      autonomousWait <= 300_000,
    "M1_AUTONOMOUS_WAIT_MS must be an integer from 1000 through 300000; use at least one full hosted schedule interval",
  );
  gates.target_safety = { status: "pass" };
  await gate("live_health", async () => {
    const health = await request(null, "/healthz", { status: 200 });
    equal(
      health.json?.ok,
      true,
      "Target did not report live healthy persistence",
    );
  });
  if (phase === "resume") {
    await resume();
  } else {
    const context = await suite();
    if (phase === "prepare") await prepare(context);
    else {
      pending(
        "actual_restart_and_disconnected_queue_recovery",
        "Suite-only execution does not prove actual restart; use prepare/restart/resume",
      );
      pending(
        "actual_restart_claim_autonomous_uncertainty",
        "Suite-only execution does not prove recovery of a claim across actual restart",
      );
      pending(
        "actual_restart_claim_unknown_never_redispatches",
        "Suite-only execution does not prove post-claim actual restart duplicate safety",
      );
    }
  }
} catch {
  gates[currentGate] = { status: "fail", reason: failureReason };
}
report();
