#!/usr/bin/env node
/**
 * Real M2 HTTP acceptance, not SDK certification or Provider/OAuth registration proof.
 * Run only against actual disposable direct SQLite or isolated hosted Cloudflare.
 * M2_BASE_URL=<origin> M2_RUNTIME=local|hosted M2_ALLOW_MUTATION=yes \
 * M2_CONFIG_FILE=.state/m2-conformance/private.json node scripts/m2-conformance.mjs
 * --phase=prepare persists approved paused work; externally restart/redeploy the same
 * database/secret, then --phase=resume with M2_RESTART_CONFIRMED=yes.
 * Private config: {github?:{approvedDisposableIdentity:true,credential:{kind:'bearer',
 * token:string},ownership?:'user'|'workspace'},sources:[{kind,slug,displayName,source,accounts:[{requirement,create}],
 * operation:{tool,arguments,authorizedSubject?,expected?:[{pointer,value}],observation?:{url,headers,pointer,delta},
 * operationClass,authorizedDisposableWrite?:true},revisionSource?,driftSource?}],
 * controlledExternal?:{source:<same shape>,cases:[{tool,arguments,status,attempts,delta}]},
 * schemaTemplate?:ToolDefinition,expiredArtifact?:{profileId,artifactId,token}}.
 * operation.observation performs read-only GET against a real disposable Provider
 * resource; its integer counter must change by delta exactly once per success.
 * Writes need M2_EXTERNAL_WRITES=yes and authorizedDisposableWrite:true. Secrets are
 * loaded from a mode-0600 ignored file, never CLI arguments or report output.
 * Exit 0 all current-runtime gates pass; 1 failed; 2 pending external evidence.
 * Six-cell matrix distinguishes unexercised counterpart deployment from this run.
 * Owner routes follow the reviewed M2 contract; no direct DB/core/service invocation.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_VERSION,
  EXECUTION_NAMESPACE,
  FALLBACK_PREFIX,
  GITHUB_READ_SOURCE,
  githubSourceFixtures,
  LIMITS,
  metadataFixtures,
  openApiFixtures,
  PROTOCOL_VERSION,
  sandboxFixtures,
  schemaFixtures,
} from "./m2-contract-fixtures.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TYPES = ["typescript", "http", "remote_mcp"];
const TERMINAL = new Set([
  "succeeded",
  "denied",
  "blocked",
  "expired",
  "canceled",
  "failed",
  "outcome_unknown",
]);
const PRODUCTION = new Set([
  "cfl-mcpone-3e4b5c9dc0.ryandetzel3409.workers.dev",
  "cfl-lifecycle-controller-65ec5d0bab.ryandetzel3409.workers.dev",
]);
const gates = {};
const cells = Object.fromEntries(
  ["local", "hosted"].flatMap((runtime) =>
    TYPES.map((kind) => [`${runtime}/${kind}`, { status: "not_exercised" }]),
  ),
);
const protectedValues = new Set();
const verifiedGithubUsers = new Map();
const started = Date.now();
let base,
  runtime,
  config,
  current = "target_safety",
  reason = "M2 conformance assertion failed",
  sequence = 0;
const phase = process.argv[2]?.replace("--phase=", "") ?? "suite";
const waitMs = Number(process.env.M2_AUTONOMOUS_WAIT_MS ?? 70_000);
const pollMs = Number(process.env.M2_POLL_TIMEOUT_MS ?? 120_000);
const statePath = resolve(
  ROOT,
  process.env.M2_STATE_FILE ??
    `.state/m2-conformance/${process.env.M2_RUNTIME ?? "unknown"}-restart.json`,
);
const membershipStatePath = resolve(
  ROOT,
  process.env.M2_MEMBERSHIP_STATE_FILE ??
    `.state/m2-conformance/${process.env.M2_RUNTIME ?? "unknown"}-membership.json`,
);
function check(condition, message) {
  reason = message;
  assert.ok(condition, message);
}
function equal(actual, expected, message) {
  reason = message;
  assert.deepEqual(actual, expected, message);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function pending(name, message) {
  gates[name] = { status: "pending", reason: message };
}
async function gate(name, action) {
  current = name;
  const start = Date.now(),
    previous = gates[name];
  await action();
  const explicitlyPending =
    gates[name] !== previous && gates[name]?.status === "pending";
  gates[name] = {
    ...gates[name],
    status: explicitlyPending ? "pending" : "pass",
    elapsed_ms: Date.now() - start,
  };
}
function pointer(value, path) {
  check(
    typeof path === "string" && (path === "" || path.startsWith("/")),
    "Expected RFC 6901 JSON pointer",
  );
  return path === ""
    ? value
    : path
        .slice(1)
        .split("/")
        .reduce(
          (item, key) => item?.[key.replace(/~1/g, "/").replace(/~0/g, "~")],
          value,
        );
}
function protect(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (
      (/^(token|password|clientSecret|refresh_token|access_token)$/i.test(
        key,
      ) ||
        (key === "value" && value.kind === "api_key")) &&
      typeof item === "string" &&
      item.length >= 12
    )
      protectedValues.add(item);
    if (key === "headers" && item && typeof item === "object")
      for (const [name, header] of Object.entries(item)) {
        if (
          /authorization|cookie|api.key/i.test(name) &&
          typeof header === "string"
        ) {
          protectedValues.add(header);
          const token = header.replace(/^Bearer /i, "");
          if (token.length >= 12) protectedValues.add(token);
        }
      }
    protect(item);
  }
}
function noLeaks(text) {
  for (const value of protectedValues)
    check(
      !text.includes(value),
      "Credential appeared in public response or Run content",
    );
}
async function privateRead(path) {
  const location = resolve(ROOT, path);
  check(
    relative(ROOT, location).startsWith(`.state${sep}`),
    "Private configuration and handoffs must remain in ignored .state",
  );
  const metadata = await lstat(location);
  check(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      (metadata.mode & 0o077) === 0,
    "Private file must be regular, non-symlink and mode 0600",
  );
  equal(
    await realpath(location),
    location,
    "Private file path must not traverse symlinks",
  );
  const file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
async function saveState(value, location = statePath) {
  const directory = dirname(location);
  check(
    relative(ROOT, directory).startsWith(`.state${sep}`),
    "Resume secrets must remain in ignored .state",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  check(
    metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      (metadata.mode & 0o077) === 0,
    "Resume directory must be private and non-symlink",
  );
  equal(
    await realpath(directory),
    directory,
    "Resume directory path must not traverse symlinks",
  );
  const file = await open(
    location,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function request(
  client,
  path,
  {
    method = "GET",
    body,
    headers = {},
    status,
    binary = false,
    signal,
    redirect = "error",
  } = {},
) {
  const url = new URL(path, base);
  check(
    url.origin === base.origin,
    "Owner and MCP requests must stay on the exact application origin",
  );
  const outgoing = new Headers({
    accept: "application/json",
    origin: base.origin,
    ...headers,
  });
  if (client?.cookie) outgoing.set("cookie", client.cookie);
  if (body !== undefined && !outgoing.has("content-type"))
    outgoing.set("content-type", "application/json");
  reason = "Application HTTP request failed or timed out";
  const response = await fetch(url, {
    method,
    headers: outgoing,
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    redirect,
    signal: signal ?? AbortSignal.timeout(binary ? 120_000 : 30_000),
  });
  if (client) {
    for (const entry of response.headers.getSetCookie()) {
      const pair = entry.split(";", 1)[0];
      const at = pair.indexOf("=");
      check(at > 0, "Malformed session cookie");
      client.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    client.cookie = [...client.cookies]
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
  if (status !== undefined)
    equal(
      response.status,
      status,
      `Unexpected HTTP status for ${method} ${url.pathname}`,
    );
  if (binary)
    return {
      status: response.status,
      bytes: new Uint8Array(await response.arrayBuffer()),
      headers: response.headers,
    };
  const text = await response.text();
  noLeaks(text);
  const responseLimit = /^\/api\/control\/integrations\/[^/]+\/validate$/.test(
    url.pathname,
  )
    ? LIMITS.derivedMetadataBytes
    : LIMITS.inlineBytes;
  check(
    Buffer.byteLength(text) <= responseLimit,
    "HTTP/MCP serialized response exceeded its owner/caller bound",
  );
  let json = null;
  if (text) {
    check(
      response.headers.get("content-type")?.includes("application/json"),
      "Application returned non-JSON response",
    );
    reason = "Application returned invalid JSON";
    json = JSON.parse(text);
  }
  return { status: response.status, json, headers: response.headers, text };
}
async function owner(client, path, method = "GET", body, status = 200) {
  return (await request(client, path, { method, body, status })).json;
}
async function denied(client, path, method = "GET", body) {
  const response = await request(client, path, { method, body });
  check(
    [401, 403, 404].includes(response.status) && response.json?.error,
    "Foreign owner operation was not safely denied",
  );
}
async function signup(label) {
  const client = { cookies: new Map(), cookie: "", orgId: null };
  const password = randomBytes(32).toString("base64url");
  protectedValues.add(password);
  const email = `m2-${randomUUID()}@example.com`;
  const user = await owner(client, "/api/auth/sign-up/email", "POST", {
    name: `M2 ${label}`,
    email,
    password,
  });
  client.auth = { email, password };
  check(
    user.user?.id && client.cookie,
    "Real Better Auth signup did not establish a session",
  );
  client.userId = user.user.id;
  const slug = `m2-${randomUUID()}`;
  const org = await owner(client, "/api/auth/organization/create", "POST", {
    name: `M2 disposable ${label}`,
    slug,
  });
  client.orgId = org.id;
  await owner(client, "/api/auth/organization/set-active", "POST", {
    organizationSlug: slug,
  });
  const session = await owner(client, "/api/auth/get-session");
  equal(
    session.session?.activeOrganizationId,
    org.id,
    "Owner session did not persist workspace identity",
  );
  return client;
}
async function rpc(identity, method, params, allowError = false, options = {}) {
  const id = ++sequence;
  const response = await request(null, `/mcp/${identity.profileId}`, {
    ...options,
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${identity.token}`,
      ...(method === "initialize"
        ? {}
        : { "mcp-protocol-version": PROTOCOL_VERSION }),
    },
    body: { jsonrpc: "2.0", id, method, params },
  });
  equal(response.json?.jsonrpc, "2.0", "MCP response omitted JSON-RPC version");
  equal(response.json?.id, id, "MCP response did not echo request ID");
  if (allowError) return response;
  equal(response.status, 200, "MCP transport rejected authorized request");
  check(
    response.json.result && !response.json.error,
    "MCP authorized operation returned a transport error",
  );
  return response.json.result;
}
async function initialize(identity) {
  const result = await rpc(identity, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "m2-http-conformance", version: "1.0.0" },
  });
  equal(
    result.protocolVersion,
    PROTOCOL_VERSION,
    "MCP protocol negotiation mismatch",
  );
  check(
    result.capabilities?.tools && result.serverInfo?.name,
    "MCP initialization omitted Tool capability",
  );
  return result.serverInfo.version;
}
async function discover(identity) {
  const value = await rpc(identity, "tools/list", {});
  check(Array.isArray(value.tools), "Discovery omitted Tools");
  return value.tools;
}
function control(result) {
  check(Array.isArray(result.content), "MCP result omitted standard content");
  const blocks = result.content.filter(
    (item) => item.type === "text" && item.text?.startsWith(FALLBACK_PREFIX),
  );
  equal(blocks.length, 1, "Result omitted or duplicated control fallback");
  equal(
    result.content.at(-1),
    blocks[0],
    "Control fallback is not final content",
  );
  reason = "Control fallback was not JSON";
  const run = JSON.parse(blocks[0].text.slice(FALLBACK_PREFIX.length));
  const metadata = result._meta?.[EXECUTION_NAMESPACE];
  check(
    metadata &&
      Object.keys(metadata).every((key) =>
        ["run_id", "tool", "accounts"].includes(key),
      ),
    "Execution metadata leaked nonminimal fields",
  );
  equal(metadata.run_id, run.run_id, "Fallback/metadata Run identity mismatch");
  equal(metadata.tool, run.tool, "Fallback/metadata Tool identity mismatch");
  equal(
    metadata.accounts,
    run.accounts,
    "Fallback/metadata Account aliases mismatch",
  );
  check(
    TERMINAL.has(run.status) ||
      ["queued", "running", "pending_approval"].includes(run.status),
    "Unknown Run status",
  );
  check(typeof result.isError === "boolean", "MCP result omitted isError");
  return { ...run, business: result };
}
async function invoke(identity, operation, key = randomUUID(), options = {}) {
  return control(
    await rpc(
      identity,
      "tools/call",
      {
        name: operation.tool,
        arguments: operation.arguments,
        _meta: {
          [EXECUTION_NAMESPACE]: {
            idempotency_key: key,
            trace_id: `m2-${randomUUID()}`,
          },
        },
      },
      false,
      options,
    ),
  );
}
async function retrieval(identity, id) {
  return control(
    await rpc(identity, "tools/call", {
      name: "runs.get",
      arguments: { run_id: id },
    }),
  );
}
async function runView(client, id) {
  return owner(client, `/api/control/runs/${id}`);
}
async function finished(client, id, status = "succeeded") {
  const deadline = Date.now() + pollMs;
  while (Date.now() <= deadline) {
    const run = await runView(client, id);
    if (TERMINAL.has(run.status)) {
      equal(run.status, status, "Run terminal outcome mismatch");
      return run;
    }
    await sleep(500);
  }
  check(false, "Run did not terminate within real scheduler timeout");
}
async function admitAndDisconnect(
  client,
  identity,
  operation,
  key,
  { requireRunning = false, effectBefore } = {},
) {
  const previous = new Set(
    (await owner(client, "/api/control/runs")).map((entry) => entry.runId),
  );
  const controller = new AbortController();
  let result,
    failed = false;
  const call = invoke(identity, operation, key, {
    signal: controller.signal,
  }).then(
    (value) => {
      result = value;
    },
    () => {
      failed = true;
    },
  );
  const deadline = Date.now() + 10_000;
  let admitted;
  try {
    while (Date.now() < deadline) {
      const runs = await owner(client, "/api/control/runs");
      admitted = runs.find(
        (entry) =>
          !previous.has(entry.runId) &&
          entry.tool === operation.tool &&
          entry.grantId === identity.grantId &&
          entry.profileId === identity.profileId &&
          (!requireRunning || entry.status === "running"),
      );
      if (
        admitted &&
        (effectBefore === undefined ||
          (await observe(operation)) ===
            effectBefore + operation.observation.delta)
      )
        break;
      admitted = undefined;
      if (failed)
        check(
          false,
          "Uncertain-write invocation failed before any attributable admitted Run",
        );
      await sleep(100);
    }
    check(
      admitted && (!requireRunning || admitted.attempts === 1),
      "Real running claim/effect was not observed before disconnect/restart",
    );
    if (result)
      equal(
        result.run_id,
        admitted.runId,
        "MCP invocation and owned Run admission disagreed",
      );
    return {
      run_id: admitted.runId,
      status: admitted.status,
      attempts: admitted.attempts,
    };
  } finally {
    controller.abort();
    await call;
  }
}
async function policies(client, profileId, name, decision) {
  await owner(client, `/api/control/profiles/${profileId}/policies`, "PUT", {
    rules: [{ pattern: name, decision }],
  });
}
async function pause(client, profileId, value) {
  await owner(client, `/api/control/profiles/${profileId}`, "PATCH", {
    dispatchPaused: value,
  });
}
async function observe(operation) {
  const observation = operation.observation;
  if (!observation) return null;
  const url = new URL(observation.url);
  check(
    url.protocol === "https:" && !url.username && !url.password && !url.hash,
    "Provider readback must use HTTPS without URL credentials",
  );
  reason = "Provider read-only observation failed";
  const response = await fetch(url, {
    method: "GET",
    headers: observation.headers ?? {},
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  equal(
    response.status,
    200,
    "Provider read-only observation returned unexpected status",
  );
  const text = await response.text();
  noLeaks(text);
  check(
    Buffer.byteLength(text) <= LIMITS.inlineBytes,
    "Provider readback exceeds bounded inline response",
  );
  reason = "Provider readback returned invalid JSON";
  const document = JSON.parse(text);
  let value;
  if (observation.countMatches) {
    const entries = pointer(
      document,
      observation.countMatches.arrayPointer ?? "",
    );
    check(
      Array.isArray(entries) &&
        !response.headers.get("link")?.includes('rel="next"'),
      "Disposable Provider count readback is incomplete/paginated",
    );
    value = entries.filter((entry) =>
      observation.countMatches.where.every(
        (match) => pointer(entry, match.pointer) === match.value,
      ),
    ).length;
  } else value = pointer(document, observation.pointer);
  check(
    Number.isSafeInteger(value),
    "Provider effect observation must be an integer counter",
  );
  return value;
}
async function effect(operation, before, multiplier) {
  if (!operation.observation) return;
  equal(
    await observe(operation),
    before + multiplier * operation.observation.delta,
    "Provider effect count does not match authorized logical dispatch count",
  );
}
async function readGitHubUser(credential) {
  check(
    credential?.kind === "bearer" && typeof credential.token === "string",
    "Real GitHub proof requires an approved disposable credential, never a personal/mounted token",
  );
  if (verifiedGithubUsers.has(credential.token))
    return verifiedGithubUsers.get(credential.token);
  const response = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${credential.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "m2-independent-provider-readback",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  equal(
    response.status,
    200,
    "Independent authenticated GitHub identity readback failed",
  );
  const text = await response.text();
  noLeaks(text);
  check(
    Buffer.byteLength(text) <= 65_536,
    "Provider identity readback exceeds its bound",
  );
  const user = JSON.parse(text);
  check(
    Number.isSafeInteger(user.id) && typeof user.login === "string",
    "Provider identity readback omitted verified subject",
  );
  verifiedGithubUsers.set(credential.token, user);
  return user;
}
function authorizedManifest(context) {
  const { source } = context,
    definition = context.definitions.find(
      (tool) => tool.name === source.operation.tool,
    );
  check(
    definition &&
      source.accounts.length === 1 &&
      source.accounts[0].create.provider === "github",
    "Real matrix requires one exact authenticated GitHub proof route",
  );
  const requirement = source.accounts[0].requirement;
  check(
    definition.requirements[requirement]?.provider === "github" &&
      Object.keys(definition.requirements).length === 1,
    "Real operation did not freeze the selected Provider requirement",
  );
  const remote = source.kind === "remote_mcp";
  equal(
    definition.permissions,
    [
      {
        requirement,
        origin: remote
          ? "https://api.githubcopilot.com"
          : "https://api.github.com",
        methods: remote ? ["POST", "DELETE"] : ["GET"],
        path: remote ? "/mcp/" : "/user",
        match: "exact",
      },
    ],
    "Proof manifest permits unauthenticated or unrelated egress",
  );
  if (source.kind === "typescript") {
    equal(
      definition.implementation.source,
      GITHUB_READ_SOURCE,
      "Use harness-authored real broker identity recipe, never hardcoded result code",
    );
    equal(
      definition.implementation.modules,
      {},
      "Real identity recipe must not introduce an unreviewed module closure",
    );
  } else if (source.kind === "http") {
    equal(
      definition.implementation.method,
      "GET",
      "HTTP proof operation is not the selected authenticated identity read",
    );
    equal(
      definition.implementation.url,
      "https://api.github.com/user",
      "HTTP proof destination differs from selected real Provider operation",
    );
    equal(
      definition.implementation.parameters,
      [],
      "HTTP proof cannot substitute query/header/path routes",
    );
  } else {
    equal(
      definition.implementation.endpoint,
      "https://api.githubcopilot.com/mcp/",
      "Remote proof is not the official authenticated endpoint",
    );
    equal(
      definition.upstreamName,
      "get_me",
      "Remote proof did not select the documented authenticated identity operation",
    );
  }
}
function resultExpected(result, operation) {
  if (operation.authorizedSubject) {
    let subject = result.business.structuredContent;
    if (!subject) {
      const candidates = result.business.content.filter(
        (block) =>
          block.type === "text" && !block.text.startsWith(FALLBACK_PREFIX),
      );
      check(
        candidates.length === 1,
        "Remote identity result did not preserve one measurable business JSON block",
      );
      subject = JSON.parse(candidates[0].text);
    }
    equal(
      String(subject.id),
      String(operation.authorizedSubject.id),
      "Real authorized result differs from independently authenticated Provider subject",
    );
    equal(
      subject.login,
      operation.authorizedSubject.login,
      "Real authorized result differs from independently authenticated Provider login",
    );
    return;
  }
  check(
    Array.isArray(operation.expected) && operation.expected.length > 0,
    "Real source proof requires meaningful expected business output assertions",
  );
  for (const assertion of operation.expected)
    equal(
      pointer(result.business, assertion.pointer),
      assertion.value,
      "Provider business result differs from expected authorized resource",
    );
}
async function createProfile(client, label) {
  const setup = await owner(client, "/api/control/setup", "POST", { label });
  check(
    typeof setup.profileId === "string",
    "Owner setup omitted stable Profile identity",
  );
  const profile = await owner(
    client,
    `/api/control/profiles/${setup.profileId}`,
  );
  check(
    Number.isInteger(profile.revision),
    "Owner Profile inspection omitted observed publication CAS revision",
  );
  setup.revision = profile.revision;
  const identity = await owner(
    client,
    `/api/control/profiles/${setup.profileId}/grants`,
    "POST",
    { label: `${label} access` },
  );
  identity.profileId = setup.profileId;
  check(
    identity.token?.length >= 24 && identity.grantId,
    "Grant issuance omitted separate identity and opaque token",
  );
  protectedValues.add(identity.token);
  return { setup, identity };
}
function requireOperation(source) {
  check(
    TYPES.includes(source.kind) && typeof source.slug === "string",
    "Source proof has invalid Integration type or namespace",
  );
  check(
    source.accounts?.length > 0 || source.controlled === true,
    "Real Provider/source proof requires a verified named outbound Account",
  );
  const operation = source.operation;
  check(
    operation &&
      operation.tool?.startsWith(`${source.slug}.`) &&
      operation.arguments &&
      typeof operation.arguments === "object",
    "Proof operation must name its configured canonical Tool and business arguments",
  );
  check(
    ["read", "write", "destructive", "unknown"].includes(
      operation.operationClass,
    ),
    "Proof must declare reviewed operation class",
  );
  if (operation.operationClass !== "read") {
    check(
      process.env.M2_EXTERNAL_WRITES === "yes" &&
        operation.authorizedDisposableWrite === true,
      "External writes require explicit disposable-resource authorization",
    );
    check(
      operation.observation &&
        Number.isSafeInteger(operation.observation.delta) &&
        operation.observation.delta !== 0,
      "External write proof requires real read-only effect observation",
    );
  }
}
async function install(client, foreign, source, label, profileContext) {
  requireOperation(source);
  if (!source.controlled) {
    check(
      source.accounts.length === 1 &&
        source.accounts[0].create.provider === "github",
      "Only the selected supported real GitHub Provider closes this source matrix",
    );
    const user = await readGitHubUser(source.accounts[0].create.credential);
    source.operation.authorizedSubject = { id: user.id, login: user.login };
    equal(
      source.accounts[0].create.identity.subject,
      String(user.id),
      "Owner Account identity does not match independent real Provider readback",
    );
  }
  const { setup, identity } =
    profileContext ?? (await createProfile(client, label));
  const bindings = {},
    accountViews = [];
  await initialize(identity);
  for (const entry of source.accounts ?? []) {
    const view = await owner(
      client,
      "/api/control/accounts",
      "POST",
      entry.create,
      201,
    );
    check(
      view.accountId && view.health === "healthy",
      "Real outbound Account was not verified healthy",
    );
    equal(
      view.alias,
      entry.create.alias,
      "Account friendly alias changed during custody",
    );
    check(
      !("credential" in view) && !("ciphertext" in view),
      "Account response exposed credential custody",
    );
    bindings[`${source.slug}.${entry.requirement}`] = view.accountId;
    accountViews.push(view);
    await denied(foreign, `/api/control/accounts/${view.accountId}`);
  }
  let configuredSource = source.source;
  if (configuredSource.kind === "remote_mcp" && source.accounts?.length > 0) {
    const index = source.accounts.findIndex(
      (entry) => entry.requirement === source.discoveryRequirement,
    );
    check(
      index >= 0,
      "Remote discovery requires an explicitly selected discoveryRequirement, never implicit outbound Account fallback",
    );
    configuredSource = {
      ...configuredSource,
      accountId: accountViews[index].accountId,
    };
  }
  const created = await owner(
    client,
    "/api/control/integrations",
    "POST",
    {
      slug: source.slug,
      displayName: source.displayName ?? label,
      source: configuredSource,
    },
    201,
  );
  check(
    created.integrationId && created.draftRevisionId,
    "Draft creation omitted immutable identity",
  );
  await denied(foreign, `/api/control/integrations/${created.integrationId}`);
  check(
    !(await discover(identity)).some(
      (tool) => tool.name === source.operation.tool,
    ),
    "Unpublished draft escaped discovery",
  );
  const report = await owner(
    client,
    `/api/control/integrations/${created.integrationId}/validate`,
    "POST",
    { draftRevisionId: created.draftRevisionId },
  );
  check(
    report.reportDigest &&
      report.accepted.some((tool) => tool.name === source.operation.tool),
    "Configured real source operation failed reviewed validation",
  );
  const matched = report.affectedProfiles.find(
    (entry) => entry.profileId === setup.profileId,
  );
  const expectedRevision = (
    await owner(client, `/api/control/profiles/${setup.profileId}`)
  ).revision;
  if (matched)
    equal(
      matched.revision,
      expectedRevision,
      "Review impact snapshot became stale before publication",
    );
  check(
    Number.isInteger(expectedRevision),
    "Owner contract must expose current Profile revision for publication CAS",
  );
  const selectedTools = source.selectedTools ?? [source.operation.tool];
  check(
    selectedTools.every((name) =>
      report.accepted.some((tool) => tool.name === name),
    ),
    "Explicit reviewed membership includes an unaccepted Tool",
  );
  const target = {
    profileId: setup.profileId,
    expectedRevision,
    tools: selectedTools,
    bindings,
    policies: selectedTools.map((pattern) => ({ pattern, decision: "allow" })),
  };
  const published = await owner(
    client,
    `/api/control/integrations/${created.integrationId}/publish`,
    "POST",
    {
      draftRevisionId: created.draftRevisionId,
      reportDigest: report.reportDigest,
      expectedCurrentRevisionId: null,
      profiles: [target],
    },
  );
  check(
    published.revisionId &&
      published.profiles.some((entry) => entry.profileId === setup.profileId),
    "Publication did not atomically bind reviewed Profile membership",
  );
  const version = await initialize(identity);
  check(
    (await discover(identity)).some(
      (tool) => tool.name === source.operation.tool,
    ),
    "Reviewed publication is absent from stable Profile discovery",
  );
  return {
    client,
    foreign,
    source,
    identity,
    integrationId: created.integrationId,
    revisionId: published.revisionId,
    profileRevision: published.profiles.find(
      (entry) => entry.profileId === setup.profileId,
    ).revision,
    bindings,
    accountViews,
    definitions: report.accepted,
    protocolBuild: version,
  };
}
async function sourceSuite(context) {
  const { client, foreign, source, identity, accountViews, integrationId } =
    context;
  const operation = source.operation;
  let before,
    original,
    key = randomUUID();
  await gate(`${source.kind}/allow_authorized_operation`, async () => {
    before = await observe(operation);
    const duplicates = await Promise.all([
      invoke(identity, operation, key),
      invoke(identity, operation, key),
      invoke(identity, operation, key),
    ]);
    equal(
      new Set(duplicates.map((item) => item.run_id)).size,
      1,
      "Concurrent duplicate keys created multiple logical Runs",
    );
    original = duplicates[0];
    const completed = await finished(client, original.run_id);
    authorizedManifest(context);
    check(
      Number.isInteger(completed.outboundRequests) &&
        completed.outboundRequests > 0 &&
        completed.effectState === "completed",
      "Succeeded result lacks durable actual broker dispatch and trusted completed business evidence",
    );
    const result = await retrieval(identity, original.run_id);
    equal(result.status, "succeeded", "Authorized result retrieval failed");
    resultExpected(result, operation);
    const aliases = Object.fromEntries(
      accountViews.map((view, index) => [
        source.accounts[index].requirement,
        view.alias,
      ]),
    );
    equal(
      result.accounts ?? {},
      aliases,
      "Safe result provenance did not preserve selected Account aliases",
    );
    for (const view of accountViews)
      check(
        !JSON.stringify(result.business).includes(view.accountId),
        "Caller result exposed internal Account ID",
      );
    await effect(operation, before, 1);
    cells[`${runtime}/${source.kind}`] = {
      status: "pass",
      run_id: original.run_id,
      integration_revision: context.revisionId,
      protocol: PROTOCOL_VERSION,
      server_version: context.protocolBuild,
      effect_observed: Boolean(operation.observation),
      oauth_consent: "not_inferred_from_operation",
    };
  });
  await gate(`${source.kind}/retrieval_and_grant_isolation`, async () => {
    await retrieval(identity, original.run_id);
    await invoke(identity, operation, key);
    await effect(operation, before, 1);
    const sibling = await owner(
      client,
      `/api/control/profiles/${identity.profileId}/grants`,
      "POST",
      { label: "M2 retrieval isolation" },
    );
    sibling.profileId = identity.profileId;
    const deniedRun = await rpc(
      sibling,
      "tools/call",
      { name: "runs.get", arguments: { run_id: original.run_id } },
      true,
    );
    check(
      deniedRun.json.error && !deniedRun.json.result,
      "Sibling Grant retrieved another Grant's Run",
    );
    await denied(foreign, `/api/control/runs/${original.run_id}`);
  });
  await gate(`${source.kind}/metadata_rejection`, async () => {
    for (const fixture of metadataFixtures.filter((entry) => !entry.valid)) {
      if (fixture.name === "_account argument override") continue;
      const response = await rpc(
        identity,
        "tools/call",
        {
          name: operation.tool,
          arguments: operation.arguments,
          _meta: { [EXECUTION_NAMESPACE]: fixture.value },
        },
        true,
      );
      check(
        response.json.error && !response.json.result,
        "Invalid gateway metadata was accepted",
      );
    }
    await effect(operation, before, 1);
    const override = await rpc(
      identity,
      "tools/call",
      {
        name: operation.tool,
        arguments: {
          ...operation.arguments,
          _account: "caller-selected-account",
        },
      },
      true,
    );
    check(
      override.json.error && !override.json.result,
      "Fixed Account route accepted caller _account substitution",
    );
    await effect(operation, before, 1);
  });
  await gate(`${source.kind}/block_and_owner_denial`, async () => {
    await policies(client, identity.profileId, operation.tool, "block");
    equal(
      (await invoke(identity, operation)).status,
      "blocked",
      "Block policy did not prevent dispatch",
    );
    await policies(client, identity.profileId, operation.tool, "ask");
    const waiting = await invoke(identity, operation);
    equal(
      waiting.status,
      "pending_approval",
      "Ask did not create authoritative pending approval",
    );
    await effect(operation, before, 1);
    await denied(
      foreign,
      `/api/control/runs/${waiting.run_id}/approve`,
      "POST",
      {},
    );
    await owner(client, `/api/control/runs/${waiting.run_id}/deny`, "POST", {});
    await finished(client, waiting.run_id, "denied");
    await effect(operation, before, 1);
  });
  await gate(`${source.kind}/ask_frozen_approval_and_no_http`, async () => {
    await pause(client, identity.profileId, true);
    const waiting = await invoke(identity, operation);
    equal(waiting.status, "pending_approval", "Ask admission changed status");
    const frozen = await runView(client, waiting.run_id);
    await owner(
      client,
      `/api/control/runs/${waiting.run_id}/approve`,
      "POST",
      {},
    );
    const approved = await runView(client, waiting.run_id);
    equal(
      approved.deadline,
      frozen.deadline,
      "Approval extended frozen deadline",
    );
    await effect(operation, before, 1);
    await pause(client, identity.profileId, false);
    const quietStart = Date.now();
    await sleep(waitMs); // No application HTTP or manual drain in this interval.
    const noHttpElapsed = Date.now() - quietStart;
    await finished(client, waiting.run_id);
    resultExpected(await retrieval(identity, waiting.run_id), operation);
    await effect(operation, before, 2);
    gates[`${source.kind}/ask_frozen_approval_and_no_http`] = {
      no_application_http_ms: noHttpElapsed,
    };
  });
  await gate(
    `${source.kind}/current_account_and_integration_restrictions`,
    async () => {
      for (const target of [
        ...accountViews
          .slice(0, 1)
          .map((view) => `/api/control/accounts/${view.accountId}`),
        `/api/control/integrations/${integrationId}`,
      ]) {
        await pause(client, identity.profileId, true);
        const waiting = await invoke(identity, operation);
        equal(
          waiting.status,
          "pending_approval",
          "Restriction proof did not freeze Ask work",
        );
        await owner(
          client,
          `/api/control/runs/${waiting.run_id}/approve`,
          "POST",
          {},
        );
        await owner(client, target, "PATCH", { enabled: false });
        await pause(client, identity.profileId, false);
        await sleep(waitMs);
        check(
          ["blocked", "canceled"].includes(
            (await runView(client, waiting.run_id)).status,
          ),
          "Current unavailable Account/Integration did not prevent frozen dispatch",
        );
        await effect(operation, before, 2);
        await owner(client, target, "PATCH", { enabled: true });
      }
      const stale = await request(
        client,
        `/api/control/integrations/${integrationId}/publish`,
        {
          method: "POST",
          body: {
            draftRevisionId: context.revisionId,
            reportDigest: "stale-public-review",
            expectedCurrentRevisionId: null,
            profiles: [],
          },
        },
      );
      equal(
        stale.status,
        409,
        "Stale publication did not fail atomic revision CAS",
      );
    },
  );
  await gate(
    `${source.kind}/same_identity_alias_only_deduplication`,
    async () => {
      for (const view of accountViews)
        await owner(
          client,
          `/api/control/accounts/${view.accountId}`,
          "PATCH",
          { alias: `Changed ${view.alias}` },
        );
      const duplicate = await invoke(identity, operation, key);
      equal(
        duplicate.run_id,
        original.run_id,
        "Alias-only change caused identity conflict or a new Run",
      );
      const frozen = await retrieval(identity, original.run_id);
      equal(
        frozen.accounts,
        Object.fromEntries(
          accountViews.map((view, index) => [
            source.accounts[index].requirement,
            view.alias,
          ]),
        ),
        "Alias change rewrote frozen Run provenance",
      );
      await effect(operation, before, 2);
      if (source.rotation) {
        for (const entry of source.rotation) {
          const index = source.accounts.findIndex(
            (account) => account.requirement === entry.requirement,
          );
          check(
            index >= 0,
            "Rotation refers to an unknown selected requirement",
          );
          check(
            JSON.stringify(entry.credential) !==
              JSON.stringify(source.accounts[index].create.credential),
            "Reusing identical credential is not actual rotation evidence",
          );
          const rotated = await owner(
            client,
            `/api/control/accounts/${accountViews[index].accountId}`,
            "PATCH",
            { credential: entry.credential },
          );
          equal(
            rotated.identity,
            accountViews[index].identity,
            "Credential refresh/rotation substituted outbound Account identity",
          );
          equal(
            (await invoke(identity, operation, key)).run_id,
            original.run_id,
            "Same-identity credential rotation changed deduplication identity",
          );
        }
        await effect(operation, before, 2);
        const fresh = await invoke(identity, operation);
        const executed = await finished(client, fresh.run_id);
        check(
          executed.outboundRequests > 0 && executed.effectState === "completed",
          "Replacement credential did not execute a real completed Provider exchange",
        );
        resultExpected(await retrieval(identity, fresh.run_id), operation);
        await effect(operation, before, 3);
      } else
        pending(
          `${source.kind}/real_same_identity_credential_rotation`,
          "Provide a real replacement/refresh credential for the same disposable Provider identity; alias success does not prove refresh",
        );
      for (const view of accountViews)
        await owner(
          client,
          `/api/control/accounts/${view.accountId}`,
          "PATCH",
          { alias: view.alias },
        );
    },
  );
  if (source.revisionSource)
    await revisionSuite(context, source.revisionSource, false);
  else
    pending(
      `${source.kind}/immutable_revision_rollback`,
      "Provide revisionSource with a changed reviewed definition and unchanged operation result to exercise retained revisions/rollback",
    );
  if (source.driftSource)
    await revisionSuite(context, source.driftSource, true);
  else
    pending(
      `${source.kind}/drift_unpublished`,
      "Provide driftSource including new upstream Tool to prove refresh does not expand discovery/authority",
    );
}
async function revisionSuite(context, replacement, drift) {
  const { client, source, identity, integrationId } = context;
  await gate(
    `${source.kind}/${drift ? "drift_unpublished" : "immutable_revision_rollback"}`,
    async () => {
      const prior = await discover(identity);
      let waiting, frozen, key;
      if (!drift) {
        await policies(
          client,
          identity.profileId,
          source.operation.tool,
          "ask",
        );
        await pause(client, identity.profileId, true);
        key = randomUUID();
        waiting = await invoke(identity, source.operation, key);
        equal(
          waiting.status,
          "pending_approval",
          "Revision freeze did not preserve old reviewed Ask operation",
        );
        frozen = await runView(client, waiting.run_id);
      }
      const staged = await owner(
        client,
        `/api/control/integrations/${integrationId}/refresh`,
        "POST",
        { source: replacement },
        201,
      );
      check(
        staged.draftRevisionId !== context.revisionId,
        "Refresh reused immutable published revision identity",
      );
      const review = await owner(
        client,
        `/api/control/integrations/${integrationId}/validate`,
        "POST",
        { draftRevisionId: staged.draftRevisionId },
      );
      equal(
        await discover(identity),
        prior,
        "Refresh silently changed reviewed discovery/membership",
      );
      check(
        review.changes.some(
          (entry) => entry.kind === (drift ? "new" : "changed"),
        ),
        "Configured refresh did not produce required drift/revision change",
      );
      if (drift) return;
      const revision = review.affectedProfiles.find(
        (entry) => entry.profileId === identity.profileId,
      )?.revision;
      check(
        Number.isInteger(revision),
        "Revision review omitted affected Profile CAS authority",
      );
      const target = {
        profileId: identity.profileId,
        expectedRevision: revision,
        tools: [source.operation.tool],
        bindings: context.bindings,
        policies: [{ pattern: source.operation.tool, decision: "allow" }],
      };
      const published = await owner(
        client,
        `/api/control/integrations/${integrationId}/publish`,
        "POST",
        {
          draftRevisionId: staged.draftRevisionId,
          reportDigest: review.reportDigest,
          expectedCurrentRevisionId: context.revisionId,
          profiles: [target],
        },
      );
      check(
        published.revisionId !== context.revisionId,
        "Changed definition did not create new immutable revision",
      );
      equal(
        (await runView(client, waiting.run_id)).status,
        "pending_approval",
        "Publication silently relaxed a frozen Approval requirement",
      );
      const conflictResult = await rpc(identity, "tools/call", {
        name: source.operation.tool,
        arguments: source.operation.arguments,
        _meta: { [EXECUTION_NAMESPACE]: { idempotency_key: key } },
      });
      const conflict = control(conflictResult);
      equal(
        conflict.business.isError,
        true,
        "Changed immutable revision reused old idempotency fingerprint",
      );
      equal(
        conflict.error?.code,
        "idempotency_conflict",
        "Revision duplicate rejection was not exact frozen-fingerprint conflict",
      );
      equal(
        conflict.error?.retryable,
        false,
        "Revision conflict permitted retry under the changed key",
      );
      equal(
        conflict.run_id,
        waiting.run_id,
        "Revision conflict lost original Run provenance",
      );
      equal(
        conflict.error?.run_id,
        waiting.run_id,
        "Revision conflict lost original Run error correlation",
      );
      equal(
        conflict.status,
        "pending_approval",
        "Revision conflict rewrote the frozen Run status",
      );
      check(
        conflict.business.structuredContent === undefined &&
          conflict.business.content.length === 1,
        "Revision conflict returned business output",
      );
      const unchanged = await runView(client, waiting.run_id);
      equal(
        unchanged.status,
        frozen.status,
        "Revision conflict mutated the original Run",
      );
      equal(
        unchanged.deadline,
        frozen.deadline,
        "Revision conflict rewrote the frozen deadline",
      );
      equal(
        unchanged.frozenToolRevision,
        frozen.frozenToolRevision,
        "Revision conflict rewrote the frozen Tool revision",
      );
      await owner(
        client,
        `/api/control/runs/${waiting.run_id}/approve`,
        "POST",
        {},
      );
      equal(
        (await runView(client, waiting.run_id)).deadline,
        frozen.deadline,
        "Revision/Approval rewrote frozen deadline",
      );
      await pause(client, identity.profileId, false);
      await sleep(waitMs);
      await finished(client, waiting.run_id);
      const old = await retrieval(identity, waiting.run_id);
      resultExpected(old, source.operation);
      check(
        old.business.structuredContent?.__m2_conformance_revision === undefined,
        "Pending Run executed changed guest behavior instead of retained artifact",
      );
      const retained = await owner(
        client,
        `/api/control/integrations/${integrationId}/validate`,
        "POST",
        { draftRevisionId: context.revisionId },
      );
      target.expectedRevision = retained.affectedProfiles.find(
        (entry) => entry.profileId === identity.profileId,
      )?.revision;
      const rolled = await owner(
        client,
        `/api/control/integrations/${integrationId}/rollback`,
        "POST",
        {
          revisionId: context.revisionId,
          reportDigest: retained.reportDigest,
          expectedCurrentRevisionId: published.revisionId,
          profiles: [target],
        },
      );
      equal(
        rolled.revisionId,
        context.revisionId,
        "Rollback did not select retained reviewed revision",
      );
      equal(
        (await invoke(identity, source.operation, key)).run_id,
        waiting.run_id,
        "Rollback failed to restore exact retained fingerprint/reuse",
      );
    },
  );
}
function toolInputSchema(schema) {
  if (schema && typeof schema === "object" && schema.type === "object")
    return schema;
  function rebase(value, inDiscriminator = false, inMapping = false) {
    if (Array.isArray(value)) return value.map((item) => rebase(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          (key === "$ref" || inMapping) &&
          typeof item === "string" &&
          item.startsWith("#/")
            ? `#/properties/value/${item.slice(2)}`
            : rebase(
                item,
                key === "discriminator",
                inDiscriminator && key === "mapping",
              ),
        ]),
      );
    return value;
  }
  return {
    type: "object",
    properties: { value: rebase(schema) },
    required: ["value"],
    additionalProperties: false,
  };
}
function schemaOnlyTool(name, inputSchema) {
  return {
    name,
    description: "D12 schema-only validation; never a real Provider proof",
    inputSchema,
    operationClass: "read",
    requirements: {},
    permissions: [],
    implementation: {
      kind: "typescript",
      source: "export default async function (input) { return input; }",
      entrypoint: "default",
      modules: {},
    },
  };
}
function importMappings(document, slug) {
  const mapping = {};
  let index = 0;
  for (const [path, item] of Object.entries(document.paths ?? {}))
    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
      "trace",
    ])
      if (item[method]) {
        const upstreamName =
          item[method].operationId || `${method.toUpperCase()} ${path}`;
        mapping[upstreamName] = `${slug}.operation_${index++}`;
      }
  return mapping;
}
async function schemaSuite(client, publishedProfileId) {
  await gate("d12_schema_positive_negative", async () => {
    for (const fixture of schemaFixtures) {
      if (fixture.standaloneOnly) continue; // Exact raw-node budget/depth cases also execute in the real validator unit corpus.
      const slug = `schema_${randomUUID().replaceAll("-", "")}`;
      const tool = {
        ...(config.schemaTemplate ?? schemaOnlyTool(`${slug}.validate`, {})),
        name: `${slug}.validate`,
        inputSchema: toolInputSchema(fixture.schema),
      };
      let source = { kind: tool.implementation.kind, tools: [tool] };
      if (fixture.dialect === "3.0") {
        const document = {
          openapi: "3.0.3",
          info: { title: "D12 dialect fixture", version: "1" },
          servers: [{ url: "https://example.com" }],
          paths: {
            "/validate": {
              post: {
                requestBody: {
                  required: true,
                  content: { "application/json": { schema: fixture.schema } },
                },
                responses: {
                  200: {
                    description: "No invocation",
                    content: { "application/json": { schema: {} } },
                  },
                },
              },
            },
          },
        };
        source = {
          kind: "openapi",
          document: JSON.stringify(document),
          approvedRefOrigins: [],
          nameMapping: { "POST /validate": `${slug}.validate` },
          securityMappings: {},
          operationOptions: {},
        };
      }
      const created = await request(client, "/api/control/integrations", {
        method: "POST",
        body: { slug, displayName: `D12 ${fixture.name}`, source },
      });
      if (created.status >= 400) {
        check(
          !fixture.valid && created.status === 400 && created.json.error,
          "Schema creation rejected supported contract fixture",
        );
        continue;
      }
      equal(created.status, 201, "Schema-only draft creation failed");
      const review = await request(
        client,
        `/api/control/integrations/${created.json.integrationId}/validate`,
        {
          method: "POST",
          body: { draftRevisionId: created.json.draftRevisionId },
        },
      );
      const accepted =
        review.status === 200 &&
        review.json.accepted.length === 1 &&
        review.json.rejected.length === 0;
      equal(
        accepted,
        fixture.valid,
        `Schema validation differs from frozen positive/negative contract fixture: ${fixture.name}`,
      );
      if (fixture.warning) {
        const diagnostics = review.json.diagnostics ?? [];
        check(
          diagnostics.some((entry) => entry.code === "schema_warning"),
          "Accepted annotation warning disappeared from owner review",
        );
        check(
          diagnostics.every(
            (entry) =>
              ["schema_warning", "excluded_media"].includes(entry.code) &&
              [...entry.message].length <= 512 &&
              (entry.path === "" || entry.path.startsWith("/")),
          ),
          "Review diagnostics violated safe nonblocking carrier",
        );
      }
      equal(
        (
          await owner(
            client,
            `/api/control/integrations/${created.json.integrationId}`,
          )
        ).currentRevisionId,
        null,
        "Schema review implicitly published a Tool",
      );
    }
  });
  await gate("mcp_tool_schema_object_roots_only", async () => {
    for (const field of ["inputSchema", "outputSchema"])
      for (const schema of [
        true,
        {},
        { type: "string" },
        { type: "array", items: { type: "integer" } },
      ]) {
        const slug = `root_${randomUUID().replaceAll("-", "")}`;
        const tool = {
          ...schemaOnlyTool(`${slug}.validate`, {
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          [field]: schema,
        };
        const created = await request(client, "/api/control/integrations", {
          method: "POST",
          body: {
            slug,
            displayName: "Invalid MCP Tool schema root",
            source: { kind: "typescript", tools: [tool] },
          },
        });
        if (created.status === 400) {
          check(created.json.error, "Root rejection omitted safe diagnostic");
          continue;
        }
        equal(
          created.status,
          201,
          "Tool root fixture failed for unrelated transport/storage reason",
        );
        const review = await owner(
          client,
          `/api/control/integrations/${created.json.integrationId}/validate`,
          "POST",
          { draftRevisionId: created.json.draftRevisionId },
        );
        check(
          review.accepted.length === 0 && review.rejected.length > 0,
          "Tool scalar/bool/unproven root was silently coerced or omitted instead of rejected",
        );
      }
  });
  await gate("d12_openapi_positive_negative", async () => {
    for (const fixture of openApiFixtures()) {
      const slug = `openapi_${randomUUID().replaceAll("-", "")}`;
      const profileBefore = fixture.derivedBudget
        ? await owner(client, `/api/control/profiles/${publishedProfileId}`)
        : null;
      if (fixture.derivedBudget)
        check(
          Buffer.byteLength(JSON.stringify(fixture.document)) <
            LIMITS.specBytes &&
            Object.keys(fixture.document.paths).length === LIMITS.operations,
          "Derived overflow fixture violated original input bounds",
        );
      const created = await request(client, "/api/control/integrations", {
        method: "POST",
        body: {
          slug,
          displayName: `D12 ${fixture.name}`,
          source: {
            kind: "openapi",
            document: JSON.stringify(fixture.document),
            approvedRefOrigins: [],
            nameMapping: importMappings(fixture.document, slug),
            securityMappings: {},
            operationOptions: fixture.operationOptions ?? {},
          },
        },
      });
      if (created.status >= 400) {
        check(
          !fixture.valid &&
            [400, 413].includes(created.status) &&
            created.json.error,
          "Import rejected a supported positive fixture",
        );
        if (fixture.derivedBudget)
          check(
            false,
            "Derived budget must reject whole validated Revision, not legal input before owner review",
          );
        continue;
      }
      const review = await request(
        client,
        `/api/control/integrations/${created.json.integrationId}/validate`,
        {
          method: "POST",
          body: { draftRevisionId: created.json.draftRevisionId },
        },
      );
      if (fixture.derivedBudget) {
        equal(
          review.status,
          413,
          "Whole derived metadata overflow did not fail with413",
        );
        equal(
          review.json.error?.code,
          "import_invalid",
          "Derived overflow returned wrong safe error code",
        );
        check(
          /derived|normalized/i.test(review.json.error.message) &&
            /budget|8.?MiB/i.test(review.json.error.message),
          "Derived overflow omitted precise budget diagnostic",
        );
        equal(
          (
            await owner(
              client,
              `/api/control/integrations/${created.json.integrationId}`,
            )
          ).currentRevisionId,
          null,
          "Oversized derived Revision became active",
        );
        equal(
          await owner(client, `/api/control/profiles/${publishedProfileId}`),
          profileBefore,
          "Derived overflow mutated a Profile or partially auto-published authority",
        );
        continue;
      }
      const clean =
        review.status === 200 &&
        review.json.rejected.length === 0 &&
        review.json.accepted.length > 0;
      equal(
        clean,
        fixture.valid,
        `OpenAPI review differs from positive/negative fixture: ${fixture.name}`,
      );
      if (fixture.reviewOnly)
        check(
          review.json.rejected.length > 0 && review.json.accepted.length > 0,
          "Mixed import did not provide actionable supported/rejected operation review",
        );
      if (fixture.expectedDiagnostic)
        check(
          review.json.diagnostics?.some(
            (entry) => entry.code === fixture.expectedDiagnostic,
          ),
          "Explicit media selection lost nonblocking owner review diagnostic",
        );
      equal(
        (
          await owner(
            client,
            `/api/control/integrations/${created.json.integrationId}`,
          )
        ).currentRevisionId,
        null,
        "Import validation implicitly published supported subset",
      );
    }
  });
}
async function uploadArtifact(
  client,
  identity,
  payload,
  filename = "public-fixture.bin",
  status = 201,
) {
  const response = await request(
    client,
    `/api/control/artifacts?profileId=${identity.profileId}&grantId=${identity.grantId}`,
    {
      method: "POST",
      body: payload,
      binary: true,
      headers: {
        "content-type": "application/octet-stream",
        "x-artifact-filename": filename,
        accept: "application/json",
      },
      status,
    },
  );
  if (status !== 201) return response;
  const text = new TextDecoder().decode(response.bytes);
  noLeaks(text);
  reason = "Artifact upload did not return reference JSON";
  const artifact = JSON.parse(text);
  check(
    artifact.artifact_id && artifact.sha256?.match(/^[0-9a-f]{64}$/),
    "Artifact reference omitted ID or digest",
  );
  equal(
    artifact.size_bytes,
    payload.byteLength,
    "Artifact reference has incorrect protected payload size",
  );
  equal(
    artifact.sha256,
    createHash("sha256").update(payload).digest("hex"),
    "Artifact plaintext integrity digest mismatch",
  );
  check(
    !("url" in artifact) &&
      typeof artifact.expires_at === "string" &&
      new Date(artifact.expires_at).toISOString() === artifact.expires_at,
    "Artifact reference exposed URL or invalid retention timestamp",
  );
  let hasUnsafeFilenameCodeUnit = false;
  for (let index = 0; index < artifact.filename.length; index++) {
    const codeUnit = artifact.filename.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) {
      hasUnsafeFilenameCodeUnit = true;
      break;
    }
  }
  check(
    artifact.filename.length <= 128 &&
      !artifact.filename.includes("/") &&
      !artifact.filename.includes("\\") &&
      !hasUnsafeFilenameCodeUnit,
    "Artifact filename was not safely sanitized",
  );
  return artifact;
}
async function artifactSuite(client, foreign, profileContext) {
  const { identity } = profileContext;
  const refs = [];
  await gate("protected_artifact_upload_retrieval_isolation", async () => {
    for (const size of [0, 19, LIMITS.binaryBytes]) {
      const payload = Buffer.alloc(size, 65);
      const artifact = await uploadArtifact(
        client,
        identity,
        payload,
        "../public-fixture.bin",
      );
      refs.push(artifact);
      const fetched = await request(
        null,
        `/mcp/${identity.profileId}/artifacts/${artifact.artifact_id}`,
        {
          binary: true,
          headers: { authorization: `Bearer ${identity.token}` },
          status: 200,
        },
      );
      equal(
        Buffer.from(
          fetched.bytes.buffer,
          fetched.bytes.byteOffset,
          fetched.bytes.byteLength,
        ),
        payload,
        "Protected artifact roundtrip corrupted actual binary bytes",
      );
      check(
        fetched.headers.get("content-disposition")?.startsWith("attachment"),
        "Protected artifact was served inline",
      );
      equal(
        fetched.headers.get("x-content-type-options"),
        "nosniff",
        "Artifact omitted untrusted MIME protection",
      );
      check(
        fetched.headers.get("cache-control")?.includes("no-store"),
        "Protected artifact allowed retained public cache",
      );
      const head = await request(
        null,
        `/mcp/${identity.profileId}/artifacts/${artifact.artifact_id}`,
        {
          method: "HEAD",
          binary: true,
          headers: { authorization: `Bearer ${identity.token}` },
          status: 200,
        },
      );
      equal(head.bytes.byteLength, 0, "Artifact HEAD included a body");
    }
    const tooLarge = await uploadArtifact(
      client,
      identity,
      Buffer.alloc(LIMITS.binaryBytes + 1, 65),
      "oversized.bin",
      413,
    );
    noLeaks(new TextDecoder().decode(tooLarge.bytes));
    const artifact = refs[1];
    const sibling = await owner(
      client,
      `/api/control/profiles/${identity.profileId}/grants`,
      "POST",
      { label: "M2 artifact isolation" },
    );
    sibling.profileId = identity.profileId;
    equal(
      (
        await request(
          null,
          `/mcp/${identity.profileId}/artifacts/${artifact.artifact_id}`,
          {
            binary: true,
            headers: { authorization: `Bearer ${sibling.token}` },
          },
        )
      ).status,
      404,
      "Sibling Grant accessed protected artifact",
    );
    await denied(foreign, `/api/control/artifacts/${artifact.artifact_id}`);
    equal(
      (
        await request(
          null,
          `/mcp/${identity.profileId}/artifacts/${artifact.artifact_id}`,
          {
            binary: true,
            headers: {
              authorization: `Bearer ${identity.token}`,
              range: "bytes=0-1",
            },
          },
        )
      ).status,
      416,
      "Artifact endpoint accepted unsupported partial retrieval",
    );
    const revokedArtifact = await uploadArtifact(
      client,
      sibling,
      Buffer.from("public-revocation"),
    );
    await owner(client, `/api/control/grants/${sibling.grantId}`, "DELETE");
    check(
      [401, 403].includes(
        (
          await request(
            null,
            `/mcp/${identity.profileId}/artifacts/${revokedArtifact.artifact_id}`,
            {
              binary: true,
              headers: { authorization: `Bearer ${sibling.token}` },
            },
          )
        ).status,
      ),
      "Revoked Grant retained artifact access",
    );
    gates.protected_artifact_upload_retrieval_isolation = {
      artifacts: refs.map(({ artifact_id, size_bytes, sha256 }) => ({
        artifact_id,
        size_bytes,
        sha256,
      })),
    };
  });
  if (config.expiredArtifact)
    await gate("protected_artifact_actual_expiry", async () => {
      const prior = config.expiredArtifact;
      const response = await request(
        null,
        `/mcp/${prior.profileId}/artifacts/${prior.artifactId}`,
        { headers: { authorization: `Bearer ${prior.token}` }, status: 410 },
      );
      equal(
        response.json.error?.code,
        "content_expired",
        "Actually expired content did not remain safely unavailable",
      );
    });
  else
    pending(
      "protected_artifact_actual_expiry",
      "Provide a real previously expired protected artifact and still-active Grant; no fake-clock or direct database mutation counts as HTTP expiry evidence",
    );
  return { ...profileContext, refs };
}
async function controlledSuite(client, foreign) {
  if (!config.controlledExternal) {
    pending(
      "controlled_external_uncertain_write",
      "Provide a separate actual external fault source and read-only effect counter; real Provider success is not uncertainty proof",
    );
    return;
  }
  const controlConfig = config.controlledExternal;
  if (
    controlConfig.availableRuntimes &&
    !controlConfig.availableRuntimes.includes(runtime)
  ) {
    pending(
      "controlled_external_uncertain_write",
      "Configured controlled service is not reachable through this runtime's approved authenticated transport; no hosting/native-fetch bypass permitted",
    );
    return;
  }
  check(
    Array.isArray(controlConfig.cases) && controlConfig.cases.length >= 2,
    "Controlled source needs before-dispatch safe retry and post-write uncertainty cases",
  );
  const selectedTools = [
    ...new Set([
      controlConfig.source.operation.tool,
      ...controlConfig.cases
        .filter((entry) => !entry.source)
        .map((entry) => entry.tool),
      ...(controlConfig.restart ? [controlConfig.restart.tool] : []),
    ]),
  ];
  const context = await install(
    client,
    foreign,
    { ...controlConfig.source, controlled: true, selectedTools },
    "Controlled external faults (not real Provider proof)",
  );
  await gate("controlled_external_uncertain_write", async () => {
    check(
      Array.isArray(controlConfig.cases) && controlConfig.cases.length >= 2,
      "Controlled source needs before-dispatch safe retry and post-write uncertainty cases",
    );
    for (const fixture of controlConfig.cases) {
      const selected = fixture.source
        ? await install(
            client,
            foreign,
            fixture.source,
            `Fault ${fixture.source.slug}`,
          )
        : context;
      await policies(
        client,
        selected.identity.profileId,
        fixture.tool,
        "allow",
      );
      const operation = {
        ...controlConfig.source.operation,
        tool: fixture.tool,
        arguments: fixture.arguments,
      };
      const before = await observe(operation),
        key = randomUUID();
      const first =
        fixture.status === "outcome_unknown"
          ? await admitAndDisconnect(client, selected.identity, operation, key)
          : await invoke(selected.identity, operation, key);
      const final = await finished(client, first.run_id, fixture.status);
      equal(
        final.attempts,
        fixture.attempts,
        "External retry/uncertainty attempt count mismatch",
      );
      if (fixture.errorCode)
        equal(
          final.error?.code,
          fixture.errorCode,
          "Trusted fault diagnostic mismatch",
        );
      if (fixture.effectEvidence) {
        equal(
          final.effectState,
          fixture.effectEvidence,
          "Retry safety was not established by the authoritative native effect journal",
        );
        equal(
          final.outboundRequests,
          fixture.outboundRequests ?? 0,
          "Trusted pre-send request accounting mismatch",
        );
      }
      await invoke(selected.identity, operation, key);
      await retrieval(selected.identity, first.run_id);
      await sleep(waitMs);
      equal(
        (await runView(client, first.run_id)).attempts,
        fixture.attempts,
        "Duplicate/retrieval/autonomous recovery blindly redispatched external write",
      );
      equal(
        await observe(operation),
        before + fixture.delta,
        "External uncertain write effect/readback mismatch",
      );
    }
    check(
      controlConfig.cases.some(
        (entry) =>
          entry.status === "outcome_unknown" &&
          entry.attempts === 1 &&
          entry.delta !== 0,
      ),
      "No actual after-effect outcome_unknown proof case",
    );
    check(
      controlConfig.cases.some(
        (entry) =>
          ["not_dispatched", "verified_no_effect"].includes(
            entry.effectEvidence,
          ) &&
          entry.attempts > 1 &&
          entry.delta === 0,
      ),
      "No actual trusted pre-HTTP-send no-effect bounded retry proof case",
    );
  });
  return { context, controlConfig };
}
async function multipartSuite(client, foreign, artifacts, controlled) {
  if (!controlled?.controlConfig.capabilities?.includes("multipart")) {
    pending(
      "multipart_artifact_media_size_and_postwrite_result_bounds",
      "Actual controlled HTTPS multipart/binary endpoint required; an isolated GitHub write source cannot substitute media boundaries",
    );
    return;
  }
  const stats = new URL(
      controlled.controlConfig.source.operation.observation.url,
    ),
    echo = new URL("echo", stats),
    binary = new URL("binary", stats);
  const slug = `multipart_${randomUUID().replaceAll("-", "")}`,
    fileSchema = {
      type: "object",
      properties: { artifact_id: { type: "string", format: "uuid" } },
      required: ["artifact_id"],
      additionalProperties: false,
    };
  const bodySchema = {
    type: "object",
    properties: {
      files: { type: "array", items: fileSchema },
      label: { type: "string" },
    },
    required: ["files"],
    additionalProperties: false,
  };
  const longFields = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [
      `part${index}_${"x".repeat(7000)}`,
      { type: "string" },
    ]),
  );
  const definition = (
    name,
    url,
    schema,
    responseMedia = "application/json",
    method = "POST",
  ) => ({
    name: `${slug}.${name}`,
    description: "Controlled actual media boundary, not Provider acceptance",
    inputSchema: schema
      ? {
          type: "object",
          properties: { body: schema },
          required: ["body"],
          additionalProperties: false,
        }
      : { type: "object", properties: {}, additionalProperties: false },
    operationClass: method === "GET" ? "read" : "write",
    requirements: {},
    permissions: [
      {
        requirement: null,
        origin: url.origin,
        methods: [method],
        path: url.pathname,
        match: "exact",
      },
    ],
    implementation: {
      kind: "http",
      method,
      url: url.href,
      parameters: [],
      ...(schema
        ? {
            requestBody: {
              mediaType: "multipart/form-data",
              required: true,
              schema,
            },
          }
        : {}),
      response: { mediaType: responseMedia },
    },
  });
  const echoTool = `${slug}.echo`,
    overheadTool = `${slug}.overhead`,
    binaryTool = `${slug}.binary`;
  const operation = {
    tool: echoTool,
    arguments: { body: { files: [] } },
    operationClass: "write",
    authorizedDisposableWrite: true,
    expected: [{ pointer: "/structuredContent/count", value: 0 }],
    observation: { url: stats.href, pointer: "/requests", delta: 1 },
  };
  const source = {
    kind: "http",
    slug,
    controlled: true,
    accounts: [],
    source: {
      kind: "http",
      tools: [
        definition("echo", echo, bodySchema),
        definition("overhead", echo, {
          type: "object",
          properties: longFields,
          additionalProperties: false,
        }),
        definition("binary", binary, null, "application/octet-stream", "GET"),
      ],
    },
    selectedTools: [echoTool, overheadTool, binaryTool],
    operation,
  };
  const context = await install(
    client,
    foreign,
    source,
    "Protected actual multipart",
    artifacts,
  );
  async function rejected(tool, body, code, expectedStatus = "failed") {
    const before = await observe(operation),
      id = ++sequence;
    const response = await request(null, `/mcp/${context.identity.profileId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.identity.token}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
      },
      body: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: tool, arguments: { body } },
      },
    });
    if (response.json?.result) {
      const run = control(response.json.result),
        final = await finished(client, run.run_id, expectedStatus);
      if (code)
        equal(
          final.error?.code,
          code,
          "Multipart rejection diagnostic mismatch",
        );
      equal(
        final.outboundRequests,
        0,
        "Invalid multipart reached the actual outbound boundary",
      );
    } else
      check(
        [200, 400, 413].includes(response.status) && response.json?.error,
        "Multipart invalid input was not rejected at admission",
      );
    equal(
      await observe(operation),
      before,
      "Rejected multipart dispatched an upstream echo request",
    );
  }
  await gate(
    "multipart_artifact_media_size_and_postwrite_result_bounds",
    async () => {
      const small = artifacts.refs.find((ref) => ref.size_bytes === 19),
        big = artifacts.refs.find(
          (ref) => ref.size_bytes === LIMITS.binaryBytes,
        );
      for (const refs of [Array(10).fill(small), [big]]) {
        const before = await observe(operation),
          admitted = await invoke(context.identity, {
            ...operation,
            arguments: {
              body: {
                files: refs.map((ref) => ({ artifact_id: ref.artifact_id })),
                label: "public-field",
              },
            },
          });
        await finished(client, admitted.run_id);
        const result = await retrieval(context.identity, admitted.run_id),
          data = result.business.structuredContent;
        equal(
          data.count,
          refs.length,
          "Actual upstream received wrong multipart file count",
        );
        equal(
          data.files.map((file) => file.size_bytes),
          refs.map((ref) => ref.size_bytes),
          "Actual upstream multipart file sizes differ from protected artifacts",
        );
        equal(
          await observe(operation),
          before + 1,
          "Valid multipart was not dispatched exactly once",
        );
      }
      await rejected(
        echoTool,
        { files: Array(11).fill({ artifact_id: small.artifact_id }) },
        "payload_too_large",
      );
      const one = await uploadArtifact(
        client,
        context.identity,
        Buffer.from([1]),
        "one-byte.bin",
      );
      await rejected(
        echoTool,
        {
          files: [
            { artifact_id: big.artifact_id },
            { artifact_id: one.artifact_id },
          ],
        },
        "payload_too_large",
      );
      await rejected(
        echoTool,
        { files: [{ artifact_id: small.artifact_id, size_bytes: 0 }] },
        "invalid_arguments",
      );
      await rejected(
        overheadTool,
        Object.fromEntries(Object.keys(longFields).map((key) => [key, ""])),
        "payload_too_large",
      );
      const foreignProfile = await createProfile(
          foreign,
          "Foreign multipart artifact",
        ),
        foreignFile = await uploadArtifact(
          foreign,
          foreignProfile.identity,
          Buffer.from("foreign-public-artifact"),
        );
      await rejected(
        echoTool,
        { files: [{ artifact_id: foreignFile.artifact_id }] },
        "not_found",
        "blocked",
      );
      const siblingProfile = await createProfile(
          client,
          "Other Profile multipart artifact",
        ),
        siblingFile = await uploadArtifact(
          client,
          siblingProfile.identity,
          Buffer.from("other-profile-public-artifact"),
        );
      await rejected(
        echoTool,
        { files: [{ artifact_id: siblingFile.artifact_id }] },
        "not_found",
        "blocked",
      );
      const sibling = await owner(
        client,
        `/api/control/profiles/${context.identity.profileId}/grants`,
        "POST",
        { label: "Other Grant multipart" },
      );
      sibling.profileId = context.identity.profileId;
      const siblingFileSameProfile = await uploadArtifact(
        client,
        sibling,
        Buffer.from("other-grant-public-artifact"),
      );
      await rejected(
        echoTool,
        { files: [{ artifact_id: siblingFileSameProfile.artifact_id }] },
        "not_found",
        "blocked",
      );
      const admitted = await invoke(context.identity, {
        tool: binaryTool,
        arguments: {},
      });
      await finished(client, admitted.run_id);
      const result = await retrieval(context.identity, admitted.run_id),
        ref = result.business.structuredContent.artifact;
      check(
        ref.artifact_id && ref.sha256 && !ref.url,
        "Real binary Tool result was not protected ArtifactRef",
      );
      const bytes = await request(
        null,
        `/mcp/${context.identity.profileId}/artifacts/${ref.artifact_id}`,
        {
          binary: true,
          status: 200,
          headers: { authorization: `Bearer ${context.identity.token}` },
        },
      );
      equal(
        [...bytes.bytes],
        [0, 1, 2, 127, 128, 255],
        "Actual upstream binary result was corrupted",
      );
    },
  );
}
async function oauthSuite(client, foreign) {
  const input = {
    provider: "github",
    alias: "Disposable registered OAuth proof",
    ownership: "user",
    scopes: config.oauthStartScopes ?? ["read:user", "offline_access"],
    returnPath: "/api/control/accounts",
  };
  await gate("oauth_start_owner_authentication", async () => {
    const response = await request(null, "/api/control/accounts/oauth/start", {
      method: "POST",
      body: input,
    });
    check(
      [401, 403].includes(response.status),
      "OAuth start did not require authenticated owner",
    );
  });
  await gate("oauth_registration_and_return_path_fail_closed", async () => {
    const before = (await owner(client, "/api/control/accounts")).accounts
      .length;
    const started = await request(client, "/api/control/accounts/oauth/start", {
      method: "POST",
      body: input,
    });
    if (started.status === 503) {
      equal(
        started.json.error?.code,
        "oauth_unavailable",
        "Missing registration did not fail with actionable safe prerequisite",
      );
      equal(
        (await owner(client, "/api/control/accounts")).accounts.length,
        before,
        "Unavailable OAuth fabricated an Account",
      );
      pending(
        "real_oauth_registration_consent",
        "Actual separately registered local/hosted expiring GitHub OAuth App, exact callback and disposable consent/refresh credential unavailable; manual bearer never proves OAuth",
      );
      pending(
        "oauth_identity_substitution_scope_upgrade_and_callback_state",
        "Real registered state/consent required for identity/scope/refresh and callback binding evidence",
      );
      return;
    }
    equal(started.status, 200, "Registered OAuth start failed");
    equal(
      started.json.impact?.accountId,
      null,
      "New OAuth connection impact invented an existing Account",
    );
    equal(
      started.json.impact?.currentScopes,
      [],
      "New OAuth connection impact invented actual grants",
    );
    equal(
      started.json.impact?.published,
      [],
      "New OAuth connection impact invented bound Profile authority",
    );
    equal(
      [...(started.json.impact?.requestedScopes ?? [])].sort(),
      [...input.scopes].sort(),
      "OAuth impact does not disclose exact requested scope coverage",
    );
    const authorization = new URL(started.json.authorizationUrl);
    equal(
      authorization.origin,
      "https://github.com",
      "OAuth authorization destination is not native approved Provider",
    );
    equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
      "Real OAuth start omitted PKCE S256",
    );
    equal(
      authorization.searchParams.get("redirect_uri"),
      `${base.origin}/api/control/accounts/oauth/callback`,
      "OAuth callback is not exact runtime-local registered callback",
    );
    const state = authorization.searchParams.get("state");
    check(
      state?.length >= 24,
      "Registered OAuth start omitted opaque bounded state",
    );
    for (const returnPath of [
      "https://unreviewed.example.com/",
      "//unreviewed.example.com/",
      "/\\\\unreviewed.example.com/",
      "/settings/accounts#credential",
    ]) {
      const response = await request(
        client,
        "/api/control/accounts/oauth/start",
        { method: "POST", body: { ...input, returnPath } },
      );
      equal(response.status, 400, "OAuth accepted unsafe return path");
    }
    function safeCallback(response, expected) {
      equal(
        response.status,
        303,
        "OAuth callback failed without safe control-plane redirect",
      );
      const location = new URL(response.headers.get("location"), base);
      equal(
        location.origin,
        base.origin,
        "OAuth callback redirected outside control-plane origin",
      );
      check(
        [...location.searchParams.values()].includes(expected),
        "OAuth callback redirect omitted safe diagnostic",
      );
      check(
        !location.searchParams.has("code") &&
          !location.searchParams.has("state") &&
          !location.searchParams.has("access_token") &&
          !location.searchParams.has("refresh_token"),
        "OAuth callback leaked credential-bearing query state",
      );
    }
    const callback = `/api/control/accounts/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`;
    const foreignResult = await request(foreign, callback, {
      redirect: "manual",
      binary: true,
    });
    if (foreignResult.status === 303)
      safeCallback(foreignResult, "oauth_state_invalid");
    else
      check(
        [400, 401, 403].includes(foreignResult.status),
        "Foreign OAuth callback was not rejected",
      );
    const secondSession = {
      cookies: new Map(),
      cookie: "",
      orgId: client.orgId,
    };
    await owner(secondSession, "/api/auth/sign-in/email", "POST", client.auth);
    await owner(secondSession, "/api/auth/organization/set-active", "POST", {
      organizationId: client.orgId,
    });
    const sessionResult = await request(secondSession, callback, {
      redirect: "manual",
      binary: true,
    });
    if (sessionResult.status === 303)
      safeCallback(sessionResult, "oauth_state_invalid");
    else
      check(
        [400, 401, 403].includes(sessionResult.status),
        "Different-session OAuth callback was accepted",
      );
    safeCallback(
      await request(client, callback, { redirect: "manual", binary: true }),
      "oauth_consent_denied",
    );
    safeCallback(
      await request(client, callback, { redirect: "manual", binary: true }),
      "oauth_state_invalid",
    );
    equal(
      (await owner(client, "/api/control/accounts")).accounts.length,
      before,
      "Denied/foreign/replayed consent created outbound authority",
    );
    gates.oauth_callback_owner_session_state_denied_replay = { status: "pass" };
    pending(
      "real_oauth_registration_consent",
      "Registration/PKCE/denial probes are not actual successful disposable Provider consent or refresh proof",
    );
    pending(
      "oauth_identity_substitution_scope_upgrade_and_callback_state",
      "Complete actual consent, changed-subject rejection, incremental scopes and refresh/version races with owned disposable Provider identities",
    );
  });
}
async function probe(client, fixture, permissions = []) {
  const slug = `probe_${randomUUID().replaceAll("-", "")}`;
  const name = `${slug}.invoke`;
  const definition = {
    ...schemaOnlyTool(name, {
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    permissions,
    implementation: {
      kind: "typescript",
      source: fixture.source,
      entrypoint: fixture.entrypoint ?? "default",
      modules: fixture.modules ?? {},
    },
  };
  const { setup, identity } = await createProfile(client, fixture.name);
  const created = await request(client, "/api/control/integrations", {
    method: "POST",
    body: {
      slug,
      displayName: fixture.name,
      source: { kind: "typescript", tools: [definition] },
    },
  });
  if (created.status >= 400) {
    check(
      !fixture.positive &&
        created.status === 400 &&
        [
          "unsupported_feature",
          "import_invalid",
          "invalid_request",
          "broker_forbidden",
          ...(fixture.validationCodes ?? []),
        ].includes(created.json?.error?.code),
      `Probe was rejected for unrelated configuration failure: ${fixture.name}`,
    );
    return { status: "validation_rejected" };
  }
  equal(created.status, 201, "Probe draft creation failed");
  const review = await request(
    client,
    `/api/control/integrations/${created.json.integrationId}/validate`,
    { method: "POST", body: { draftRevisionId: created.json.draftRevisionId } },
  );
  if (review.status >= 400 || review.json.rejected.length > 0) {
    check(!fixture.positive, "Positive calibration probe was rejected");
    const codes = review.json.rejected?.map((item) => item.code) ?? [
      review.json.error?.code,
    ];
    check(
      codes.every((code) =>
        [
          "unsupported_feature",
          "import_invalid",
          "invalid_request",
          "broker_forbidden",
          ...(fixture.validationCodes ?? []),
        ].includes(code),
      ),
      `Probe rejection was not an isolation/feature diagnostic: ${fixture.name}`,
    );
    return { status: "validation_rejected", codes };
  }
  await owner(
    client,
    `/api/control/integrations/${created.json.integrationId}/publish`,
    "POST",
    {
      draftRevisionId: created.json.draftRevisionId,
      reportDigest: review.json.reportDigest,
      expectedCurrentRevisionId: null,
      profiles: [
        {
          profileId: setup.profileId,
          expectedRevision: setup.revision,
          tools: [name],
          bindings: {},
          policies: [{ pattern: name, decision: "allow" }],
        },
      ],
    },
  );
  await initialize(identity);
  const accepted = await invoke(identity, { tool: name, arguments: {} });
  const run = await finished(
    client,
    accepted.run_id,
    fixture.status ?? (fixture.positive ? "succeeded" : "failed"),
  );
  if (fixture.errorCodes)
    check(
      fixture.errorCodes.includes(run.error?.code),
      "Probe did not report the expected security/effect classification",
    );
  if (fixture.effectState !== undefined) {
    equal(
      run.attempts,
      1,
      "Security denial retried a possible external effect",
    );
    equal(
      run.effectState,
      fixture.effectState,
      "Trusted denial effect classification mismatch",
    );
    equal(
      run.outboundRequests,
      fixture.outboundRequests,
      "Forbidden redirect hop crossed the outbound boundary",
    );
  }
  if (fixture.positive) {
    const business = (await retrieval(identity, accepted.run_id)).business;
    equal(
      pointer(
        business,
        fixture.expectedBusiness?.pointer ?? "/structuredContent/public",
      ),
      fixture.expectedBusiness?.value ?? true,
      "Positive calibration did not execute actual guest/broker result contract",
    );
  }
  return { status: "executed", run_id: run.runId, error_code: run.error?.code };
}
async function sandboxSuite(client) {
  await gate("sandbox_dependency_environment_network_escapes", async () => {
    await probe(client, {
      name: "Positive isolated guest calibration",
      positive: true,
      source: "export default async function () { return {public:true}; }",
    });
    await probe(client, {
      name: "Actual typed pure-module compilation and execution",
      positive: true,
      source:
        'import { normalize } from "./vendor/pure.ts"; type PublicName=string; interface Result { public:boolean } export default function ():Result { const value:PublicName=normalize(" PUBLIC "); return {public:value==="public"}; }',
      modules: {
        "vendor/pure.ts":
          'export const version="1.0.0"; export function normalize(value:string):string { return value.trim().toLowerCase(); }',
      },
    });
    await probe(client, {
      name: "Actual plain array guest business result without object output schema",
      positive: true,
      source: "export default function () { return [1,2]; }",
      expectedBusiness: { pointer: "/content/0/text", value: "[1,2]" },
    });
    const evidence = [];
    for (const fixture of sandboxFixtures)
      evidence.push({
        name: fixture.name,
        ...(await probe(client, {
          ...fixture,
          errorCodes: [
            "execution_failed",
            "unsupported_feature",
            "broker_forbidden",
          ],
        })),
      });
    for (const fixture of [
      {
        name: "Infinite guest CPU",
        source: "export default function () { while (true) {} }",
      },
      {
        name: "Guest memory ceiling",
        source:
          "export default function () { return new Array(100000000).fill('public'); }",
      },
    ])
      evidence.push({
        name: fixture.name,
        ...(await probe(client, {
          ...fixture,
          errorCodes: ["sandbox_limit", "execution_timeout"],
        })),
      });
    equal(
      (await owner(null, "/healthz")).ok,
      true,
      "Guest isolation failure affected host health",
    );
    gates.sandbox_dependency_environment_network_escapes = { cases: evidence };
  });
}
async function brokerSuite(client, controlled) {
  if (!controlled?.controlConfig.capabilities?.includes("redirects")) {
    pending(
      "broker_method_path_redirect_private_destination",
      "Provision actual owned HTTPS controlled source with explicit redirect calibration capability",
    );
    return;
  }
  const observation = controlled.controlConfig.source.operation.observation;
  const endpoint = new URL(observation.url),
    origin = endpoint.origin,
    statsPath = endpoint.pathname;
  const namespacePath = statsPath.slice(0, statsPath.lastIndexOf("/"));
  const requestCode = (value) =>
    `export default async function (_input, ctx) { const response = await ctx.http.request(${JSON.stringify(value)}); return {public:response.status===200}; }`;
  const permission = (path, methods = ["GET"], match = "exact") => ({
    requirement: null,
    origin,
    methods,
    path,
    match,
  });
  await gate("broker_method_path_redirect_private_destination", async () => {
    const before = await observe(controlled.controlConfig.source.operation);
    await probe(
      client,
      {
        name: "Positive broker calibration",
        positive: true,
        source: requestCode({
          accountRequirement: null,
          method: "GET",
          url: observation.url,
        }),
      },
      [permission(statsPath)],
    );
    const cases = [
      {
        name: "forbidden HTTP method",
        value: {
          accountRequirement: null,
          method: "POST",
          url: observation.url,
        },
        permissions: [permission(statsPath)],
      },
      {
        name: "prefix segment escape",
        value: {
          accountRequirement: null,
          method: "GET",
          url: `${origin}${namespacePath}/read_admin`,
        },
        permissions: [permission(`${namespacePath}/read`, ["GET"], "prefix")],
      },
      {
        name: "forbidden auth header",
        value: {
          accountRequirement: null,
          method: "GET",
          url: observation.url,
          headers: { Authorization: "obvious-public-placeholder" },
        },
        permissions: [permission(statsPath)],
      },
      {
        name: "undeclared requirement",
        value: {
          accountRequirement: "undeclared",
          method: "GET",
          url: observation.url,
        },
        permissions: [permission(statsPath)],
      },
      {
        name: "private loopback URL",
        value: {
          accountRequirement: null,
          method: "GET",
          url: "https://127.0.0.1/forbidden",
        },
        permissions: [permission(statsPath)],
      },
      {
        name: "link-local metadata URL",
        value: {
          accountRequirement: null,
          method: "GET",
          url: "https://169.254.169.254/latest/meta-data",
        },
        permissions: [permission(statsPath)],
      },
      {
        name: "private redirect reauthorization",
        status: "outcome_unknown",
        errorCodes: ["outcome_unknown"],
        effectState: "possible",
        outboundRequests: 1,
        value: {
          accountRequirement: null,
          method: "GET",
          url: `${origin}${namespacePath}/redirect_private`,
        },
        permissions: [permission(`${namespacePath}/redirect_private`)],
      },
      {
        name: "unreviewed redirect reauthorization",
        status: "outcome_unknown",
        errorCodes: ["outcome_unknown"],
        effectState: "possible",
        outboundRequests: 1,
        value: {
          accountRequirement: null,
          method: "GET",
          url: `${origin}${namespacePath}/redirect_unreviewed`,
        },
        permissions: [permission(`${namespacePath}/redirect_unreviewed`)],
      },
    ];
    const evidence = [];
    for (const fixture of cases)
      evidence.push({
        name: fixture.name,
        ...(await probe(
          client,
          {
            name: fixture.name,
            source: requestCode(fixture.value),
            status: fixture.status,
            errorCodes: fixture.errorCodes ?? ["broker_forbidden"],
            effectState: fixture.effectState ?? "not_dispatched",
            outboundRequests: fixture.outboundRequests ?? 0,
          },
          fixture.permissions,
        )),
      });
    await effect(controlled.controlConfig.source.operation, before, 0);
    gates.broker_method_path_redirect_private_destination = { cases: evidence };
  });
}
async function compatibilitySuite(client, foreign, contexts) {
  const context = contexts.find(
    (entry) => entry.source.kind === "http" && entry.accountViews.length > 0,
  );
  if (!context) {
    pending(
      "account_issuer_audience_tenant_application_scope_compatibility",
      "Provide real healthy HTTP Provider Account and reviewed requirement to exercise incompatible/missing/foreign binding negatives",
    );
    return;
  }
  await gate(
    "account_issuer_audience_tenant_application_scope_compatibility",
    async () => {
      const definition = context.definitions.find(
        (entry) => entry.name === context.source.operation.tool,
      );
      const requirement = context.source.accounts[0].requirement,
        selected = context.accountViews[0];
      check(
        definition.requirements[requirement],
        "Configured Account proof requirement is absent from reviewed Tool",
      );
      const cases = [
        {
          name: "method",
          changes: {
            methods: [selected.method === "bearer" ? "oauth2" : "bearer"],
          },
          code: "account_incompatible",
        },
        {
          name: "issuer",
          changes: { issuer: "https://unmatched.example.com" },
          code: "account_incompatible",
        },
        {
          name: "audience",
          changes: { audience: "m2-unmatched-audience" },
          code: "account_incompatible",
        },
        {
          name: "tenant",
          changes: { tenant: "m2-unmatched-tenant" },
          code: "account_incompatible",
        },
        {
          name: "application",
          changes: { application: "m2-unmatched-application" },
          code: "account_incompatible",
        },
        {
          name: "scopes",
          changes: { scopes: ["m2:ungranted:scope"] },
          code: "account_scope_required",
        },
        {
          name: "missing binding",
          changes: {},
          code: "account_missing",
          missing: true,
        },
      ];
      for (const fixture of cases) {
        const slug = `compat_${randomUUID().replaceAll("-", "")}`,
          { setup } = await createProfile(
            client,
            `M2 incompatible ${fixture.name}`,
          );
        const tool = {
          ...definition,
          name: `${slug}.invoke`,
          requirements: {
            ...definition.requirements,
            [requirement]: {
              ...definition.requirements[requirement],
              ...fixture.changes,
            },
          },
        };
        const created = await owner(
          client,
          "/api/control/integrations",
          "POST",
          {
            slug,
            displayName: `M2 incompatible ${fixture.name}`,
            source: { kind: "http", tools: [tool] },
          },
          201,
        );
        const review = await owner(
          client,
          `/api/control/integrations/${created.integrationId}/validate`,
          "POST",
          { draftRevisionId: created.draftRevisionId },
        );
        if (review.rejected.length > 0) {
          check(
            review.accepted.length === 0 &&
              review.rejected.every((entry) => entry.code === fixture.code),
            "Trusted Provider rejected mismatch with wrong compatibility diagnosis",
          );
          equal(
            (
              await owner(
                client,
                `/api/control/integrations/${created.integrationId}`,
              )
            ).currentRevisionId,
            null,
            "Rejected Provider requirement published authority",
          );
          continue;
        }
        check(
          review.accepted.length === 1,
          "Compatibility review omitted the selected operation",
        );
        const bindings = fixture.missing
          ? {}
          : Object.fromEntries(
              context.source.accounts.map((entry, index) => [
                `${slug}.${entry.requirement}`,
                context.accountViews[index].accountId,
              ]),
            );
        const response = await request(
          client,
          `/api/control/integrations/${created.integrationId}/publish`,
          {
            method: "POST",
            body: {
              draftRevisionId: created.draftRevisionId,
              reportDigest: review.reportDigest,
              expectedCurrentRevisionId: null,
              profiles: [
                {
                  profileId: setup.profileId,
                  expectedRevision: setup.revision,
                  tools: [tool.name],
                  bindings,
                  policies: [{ pattern: tool.name, decision: "allow" }],
                },
              ],
            },
          },
        );
        equal(
          response.status,
          409,
          "Incompatible Account publication was not rejected atomically",
        );
        equal(
          response.json.error?.code,
          fixture.code,
          "Account compatibility rejection category mismatch",
        );
        equal(
          (
            await owner(
              client,
              `/api/control/integrations/${created.integrationId}`,
            )
          ).currentRevisionId,
          null,
          "Failed Account binding published partial authority",
        );
        await denied(foreign, `/api/control/profiles/${setup.profileId}`);
      }
    },
  );
}
async function m1Regression() {
  current = "m1_regression";
  const child = spawn(
    process.execPath,
    [resolve(ROOT, "scripts/m1-conformance.mjs"), `--phase=${phase}`],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        M1_BASE_URL: base.origin,
        M1_ALLOW_MUTATION: "yes",
        M1_STATE_FILE: `.state/m2-conformance/${runtime}-m1-restart.json`,
        M1_AUTONOMOUS_WAIT_MS: String(waitMs),
        M1_RESTART_CONFIRMED: process.env.M2_RESTART_CONFIRMED ?? "",
        M1_EXPIRY_WAIT: process.env.M2_EXPIRY_WAIT ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    diagnosticBytes = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (Buffer.byteLength(output) > LIMITS.inlineBytes) child.kill();
  });
  child.stderr.on("data", (chunk) => {
    diagnosticBytes += chunk.length;
  });
  const exitCode = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  noLeaks(output);
  reason = "M1 regression did not produce its structured evidence report";
  const evidence = JSON.parse(output);
  gates.m1_regression = {
    status: evidence.status,
    phase,
    gates: evidence.gates,
    diagnostic_bytes: diagnosticBytes,
  };
  check(
    exitCode === 0 || exitCode === 2,
    "Required real M1 regression failed; inspect separately preserved M1 gates",
  );
  equal(
    evidence.target_origin,
    base.origin,
    "M1 regression targeted a different deployment",
  );
  check(
    evidence.phase === phase && evidence.proof === "M1 black-box HTTP behavior",
    "M1 regression evidence does not match required actual-path phase",
  );
}
async function prepare(contexts, client, controlled) {
  const queued = [],
    expiries = [];
  check(
    contexts.length > 0,
    "Restart proof requires at least one actual published source operation, real Provider or separately labeled controlled external service",
  );
  for (const context of contexts)
    await gate(
      `${context.source.controlled ? "controlled_external" : context.source.kind}/restart_prepared`,
      async () => {
        await policies(
          client,
          context.identity.profileId,
          context.source.operation.tool,
          "ask",
        );
        await pause(client, context.identity.profileId, true);
        await owner(
          client,
          `/api/control/profiles/${context.identity.profileId}`,
          "PATCH",
          { approvalLifetimeMs: 24 * 60 * 60_000 },
        );
        const before = await observe(context.source.operation),
          key = randomUUID();
        const waiting = await invoke(
          context.identity,
          context.source.operation,
          key,
        );
        equal(
          waiting.status,
          "pending_approval",
          "Restart preparation did not freeze Ask Run",
        );
        await owner(
          client,
          `/api/control/runs/${waiting.run_id}/approve`,
          "POST",
          {},
        );
        equal(
          (await runView(client, waiting.run_id)).status,
          "queued",
          "Restart preparation did not persist approved queue",
        );
        await effect(context.source.operation, before, 0);
        queued.push({
          kind: context.source.kind,
          identity: context.identity,
          operation: context.source.operation,
          runId: waiting.run_id,
          before,
          key,
        });
        await owner(
          client,
          `/api/control/profiles/${context.identity.profileId}`,
          "PATCH",
          { approvalLifetimeMs: 15 * 60_000 },
        );
        const pendingExpiry = await invoke(
          context.identity,
          context.source.operation,
        );
        const pendingView = await runView(client, pendingExpiry.run_id);
        const queuedExpiry = await invoke(
          context.identity,
          context.source.operation,
        );
        const queuedView = await runView(client, queuedExpiry.run_id);
        await owner(
          client,
          `/api/control/runs/${queuedExpiry.run_id}/approve`,
          "POST",
          {},
        );
        for (const view of [pendingView, queuedView])
          check(
            Date.parse(view.deadline) >=
              Date.parse(view.createdAt) + 15 * 60_000,
            "Approval expiry was shortened below real contract minimum",
          );
        expiries.push({
          kind: context.source.kind,
          operation: context.source.operation,
          pendingRunId: pendingExpiry.run_id,
          queuedRunId: queuedExpiry.run_id,
          deadline: Math.max(
            Date.parse(pendingView.deadline),
            Date.parse(queuedView.deadline),
          ),
          before,
        });
        await owner(
          client,
          `/api/control/profiles/${context.identity.profileId}`,
          "PATCH",
          { approvalLifetimeMs: 24 * 60 * 60_000 },
        );
      },
    );
  await m1Regression();
  let running = null;
  if (controlled?.controlConfig.restart)
    await gate(
      "running_claim_restart_uncertain_external_write_prepared",
      async () => {
        const fixture = controlled.controlConfig.restart,
          identity = controlled.context.identity;
        const operation = {
          ...controlled.controlConfig.source.operation,
          tool: fixture.tool,
          arguments: fixture.arguments,
        };
        await policies(client, identity.profileId, fixture.tool, "allow");
        const before = await observe(operation),
          key = randomUUID();
        const claimed = await admitAndDisconnect(
          client,
          identity,
          operation,
          key,
          { requireRunning: true, effectBefore: before },
        );
        running = {
          identity,
          operation,
          before,
          key,
          runId: claimed.run_id,
          delta: fixture.delta,
        };
      },
    );
  else
    pending(
      "running_claim_restart_uncertain_external_write",
      "Provide controlledExternal.restart with actual after-write timeout source and effect counter",
    );
  await saveState({
    version: CONTRACT_VERSION,
    origin: base.origin,
    runtime,
    createdAt: new Date().toISOString(),
    client: { cookie: client.cookie, orgId: client.orgId },
    queued,
    expiries,
    running,
    gates,
    cells,
  });
  pending(
    "actual_restart_no_http_recovery",
    "Perform a real process replacement or hosted redeploy preserving isolated DB/secret, then resume",
  );
  pending(
    "real_approval_deadline_and_dispatch_expiry",
    "Real 15-minute pending and approved-queued deadlines are frozen; resume with M2_EXPIRY_WAIT=yes",
  );
}
async function resume() {
  check(
    process.env.M2_RESTART_CONFIRMED === "yes",
    "Resume requires externally evidenced real process replacement/hosted redeploy",
  );
  const saved = await privateRead(statePath);
  equal(saved.version, CONTRACT_VERSION, "Resume contract version mismatch");
  equal(saved.origin, base.origin, "Resume target origin mismatch");
  equal(saved.runtime, runtime, "Resume runtime mismatch");
  check(
    saved.queued.length > 0,
    "Resume handoff contains no real approved work",
  );
  Object.assign(gates, saved.gates);
  Object.assign(cells, saved.cells);
  delete gates.actual_restart_no_http_recovery;
  const client = {
    ...saved.client,
    cookies: new Map(
      saved.client.cookie.split("; ").map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
    ),
  };
  const expiryDeadline = Math.max(
    ...saved.expiries.map((entry) => entry.deadline),
  );
  if (Date.now() < expiryDeadline && process.env.M2_EXPIRY_WAIT !== "yes") {
    pending(
      "real_approval_deadline_and_dispatch_expiry",
      "Real deadline not reached; set M2_EXPIRY_WAIT=yes and resume this handoff",
    );
    return;
  }
  await gate("real_approval_deadline_and_dispatch_expiry", async () => {
    if (Date.now() < expiryDeadline)
      await sleep(expiryDeadline - Date.now() + waitMs);
    for (const entry of saved.expiries) {
      await finished(client, entry.pendingRunId, "expired");
      await finished(client, entry.queuedRunId, "expired");
      await effect(entry.operation, entry.before, 0);
    }
  });
  for (const item of saved.queued)
    await pause(client, item.identity.profileId, false);
  const noHttpStart = Date.now();
  await sleep(waitMs);
  const noHttpElapsed = Date.now() - noHttpStart;
  await gate("actual_restart_no_http_recovery", async () => {
    for (const item of saved.queued) {
      await finished(client, item.runId);
      const result = await retrieval(item.identity, item.runId);
      resultExpected(result, item.operation);
      await effect(item.operation, item.before, 1);
      equal(
        (await invoke(item.identity, item.operation, item.key)).run_id,
        item.runId,
        "Restart duplicate changed frozen logical Run",
      );
      await retrieval(item.identity, item.runId);
      await effect(item.operation, item.before, 1);
    }
  });
  gates.actual_restart_no_http_recovery.no_application_http_ms = noHttpElapsed;
  if (saved.running)
    await gate("running_claim_restart_uncertain_external_write", async () => {
      const item = saved.running,
        final = await finished(client, item.runId, "outcome_unknown");
      equal(
        final.attempts,
        1,
        "Restart blindly retried an external possibly committed write",
      );
      equal(
        (await invoke(item.identity, item.operation, item.key)).run_id,
        item.runId,
        "Restart uncertain duplicate created a new Run",
      );
      equal(
        (await retrieval(item.identity, item.runId)).status,
        "outcome_unknown",
        "Restart retrieval lost conservative unknown outcome",
      );
      equal(
        await observe(item.operation),
        item.before + item.delta,
        "Restart uncertain write was repeated or lost",
      );
    });
  await m1Regression();
  await unlink(statePath);
}
function schedulerSource() {
  const slug = `scheduler_${randomUUID().replaceAll("-", "")}`,
    tool = `${slug}.public`;
  const definition = {
    ...schemaOnlyTool(tool, {
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    implementation: {
      kind: "typescript",
      entrypoint: "default",
      modules: {},
      source: "export default async function () { return {public:true}; }",
    },
  };
  return {
    kind: "typescript",
    slug,
    controlled: true,
    proofScope: "actual-isolated-guest-scheduler-authoring-only-not-Provider",
    accounts: [],
    source: { kind: "typescript", tools: [definition] },
    revisionSource: {
      kind: "typescript",
      tools: [
        {
          ...definition,
          implementation: {
            ...definition.implementation,
            source:
              'export default async function () { return {public:true,__m2_conformance_revision:"reviewed"}; }',
          },
        },
      ],
    },
    driftSource: {
      kind: "typescript",
      tools: [definition, { ...definition, name: `${slug}.unpublished_extra` }],
    },
    operation: {
      tool,
      arguments: {},
      operationClass: "read",
      expected: [{ pointer: "/structuredContent/public", value: true }],
    },
  };
}
async function membershipPrepare(client, secondary) {
  const source =
    config.sources?.find((entry) => entry.kind === "typescript") ??
    schedulerSource();
  const context = await install(
    client,
    secondary,
    source,
    "Current principal actual HTTP authority",
  );
  const artifact = await uploadArtifact(
    client,
    context.identity,
    Buffer.from("public-principal-artifact"),
  );
  const serializeClient = ({ cookie, orgId, userId }) => ({
    cookie,
    orgId,
    userId,
  });
  await saveState(
    {
      version: CONTRACT_VERSION,
      origin: base.origin,
      runtime,
      primary: serializeClient(client),
      secondary: serializeClient(secondary),
      identity: context.identity,
      operation: context.source.operation,
      artifact,
      sourceScope: context.source.proofScope ?? "real-authenticated-GitHub",
      fixture: {
        organizationId: client.orgId,
        primaryUserId: client.userId,
        secondaryUserId: secondary.userId,
        role: "owner",
      },
    },
    membershipStatePath,
  );
  gates.membership_fixture_setup = {
    status: "pending",
    method:
      "Parent-owned isolated native server-only addMember or membership-row fixture only; not source authoring SQL",
    organization_id: client.orgId,
    primary_user_id: client.userId,
    secondary_user_id: secondary.userId,
    role: "owner",
    handoff: relative(ROOT, membershipStatePath),
    email_delivery: "not_claimed",
    email_verified_mutation: "prohibited",
  };
}
async function membershipResume() {
  const saved = await privateRead(membershipStatePath);
  equal(saved.version, CONTRACT_VERSION, "Membership handoff contract changed");
  equal(
    saved.origin,
    base.origin,
    "Membership fixture targeted a different deployment",
  );
  equal(
    saved.runtime,
    runtime,
    "Membership fixture targeted a different runtime",
  );
  protect(saved);
  const client = (value) => ({
    ...value,
    cookies: new Map(
      value.cookie.split("; ").map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
    ),
  });
  const primary = client(saved.primary),
    secondary = client(saved.secondary),
    identity = saved.identity;
  await gate("current_principal_membership_real_http", async () => {
    await owner(secondary, "/api/auth/organization/set-active", "POST", {
      organizationId: primary.orgId,
    });
    equal(
      (await owner(secondary, "/api/auth/organization/get-active-member")).role,
      "owner",
      "Parent fixture did not establish exact disposable secondary Owner membership",
    );
    const member = await owner(
      primary,
      "/api/auth/organization/get-active-member",
    );
    check(
      member.id && member.userId === primary.userId,
      "Primary actor membership is not actual native Auth state",
    );
    await owner(
      secondary,
      "/api/auth/organization/update-member-role",
      "POST",
      { memberId: member.id, organizationId: primary.orgId, role: "member" },
    );
    await policies(
      secondary,
      identity.profileId,
      saved.operation.tool,
      "allow",
    );
    const allowed = await invoke(identity, saved.operation);
    await finished(secondary, allowed.run_id);
    resultExpected(await retrieval(identity, allowed.run_id), saved.operation);
    const memberContent = await request(
      null,
      `/mcp/${identity.profileId}/artifacts/${saved.artifact.artifact_id}`,
      {
        binary: true,
        headers: { authorization: `Bearer ${identity.token}` },
        status: 200,
      },
    );
    equal(
      Buffer.from(memberContent.bytes).toString("utf8"),
      "public-principal-artifact",
      "Any-role current member lost eligible caller content",
    );
    await policies(secondary, identity.profileId, saved.operation.tool, "ask");
    await pause(secondary, identity.profileId, true);
    const waiting = await invoke(identity, saved.operation);
    equal(
      waiting.status,
      "pending_approval",
      "Current member could not admit frozen Ask work",
    );
    await owner(
      secondary,
      `/api/control/runs/${waiting.run_id}/approve`,
      "POST",
      {},
    );
    equal(
      (await runView(secondary, waiting.run_id)).status,
      "queued",
      "Different legitimate Owner could not approve same-workspace Run",
    );
    await owner(secondary, "/api/auth/organization/remove-member", "POST", {
      memberIdOrEmail: member.id,
      organizationId: primary.orgId,
    });
    await pause(secondary, identity.profileId, false);
    const quietStart = Date.now();
    await sleep(waitMs);
    const noHttpElapsed = Date.now() - quietStart;
    const final = await runView(secondary, waiting.run_id);
    check(
      ["blocked", "canceled"].includes(final.status),
      "Removed current principal dispatched formerly approved queued work",
    );
    equal(
      final.outboundRequests,
      0,
      "Removed principal won an outbound dispatch boundary",
    );
    equal(
      final.effectState,
      "not_dispatched",
      "Removed principal recorded an external effect",
    );
    const id = ++sequence,
      deniedMcp = await request(null, `/mcp/${identity.profileId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${identity.token}`,
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_VERSION,
        },
        body: { jsonrpc: "2.0", id, method: "tools/list", params: {} },
      });
    check(
      [401, 403].includes(deniedMcp.status) && !deniedMcp.json?.result,
      "Removed principal retained Grant authentication/discovery authority",
    );
    const deniedContent = await request(
      null,
      `/mcp/${identity.profileId}/artifacts/${saved.artifact.artifact_id}`,
      { binary: true, headers: { authorization: `Bearer ${identity.token}` } },
    );
    check(
      [401, 403, 404].includes(deniedContent.status),
      "Removed principal retained caller artifact content",
    );
    gates.current_principal_membership_real_http = {
      fixture_method:
        "Explicit native isolated Auth membership setup only; removal/role/approval/Grant/content/broker assertions actual HTTP",
      email_delivery: "not_claimed",
      email_verified_mutation: "none",
      source_scope: saved.sourceScope,
      no_application_http_ms: noHttpElapsed,
      denied_run_id: waiting.run_id,
    };
  });
  await unlink(membershipStatePath);
}
async function main() {
  check(
    process.argv.length <= 3 &&
      [
        "suite",
        "surfaces",
        "prepare",
        "resume",
        "membership-prepare",
        "membership-resume",
      ].includes(phase),
    "Use --phase=suite|surfaces|prepare|resume|membership-prepare|membership-resume",
  );
  check(
    process.env.M2_ALLOW_MUTATION === "yes",
    "Set M2_ALLOW_MUTATION=yes only for a disposable isolated target",
  );
  runtime = process.env.M2_RUNTIME;
  check(
    ["local", "hosted"].includes(runtime),
    "M2_RUNTIME must be local or hosted",
  );
  base = new URL(process.env.M2_BASE_URL);
  check(
    ["http:", "https:"].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      base.pathname === "/" &&
      !base.search &&
      !base.hash,
    "M2_BASE_URL must be exact HTTP(S) origin without credentials/path/query/fragment",
  );
  const hostname = base.hostname.toLowerCase().replace(/\.$/, "");
  check(
    !PRODUCTION.has(hostname),
    "Known production application/controller target prohibited",
  );
  const readme = await readFile(resolve(ROOT, "README.md"), "utf8");
  for (const section of readme.match(
    /### Verified deployment[^\n]*\n([\s\S]*?)(?=\n#{1,3} |$)/g,
  ) ?? [])
    for (const match of section.matchAll(/https:\/\/([a-z0-9.-]+)/gi))
      check(
        hostname !== match[1].toLowerCase(),
        "README production target prohibited",
      );
  if (runtime === "hosted")
    check(
      base.protocol === "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(hostname),
      "Hosted proof must use real HTTPS deployment, not Wrangler/local listener",
    );
  if (runtime === "local")
    check(
      ["localhost", "127.0.0.1", "[::1]"].includes(hostname),
      "Direct SQLite proof must use actual local listener",
    );
  check(
    Number.isInteger(waitMs) &&
      waitMs >= 1000 &&
      waitMs <= 300_000 &&
      Number.isInteger(pollMs) &&
      pollMs >= 3000 &&
      pollMs <= 300_000,
    "Scheduler/poll timing must be valid bounded integer milliseconds",
  );
  check(
    runtime !== "hosted" || waitMs >= 70_000,
    "Hosted no-HTTP proof must cover full native scheduler interval",
  );
  check(
    process.env.M2_CONFIG_FILE,
    "Provide mode-0600 ignored M2_CONFIG_FILE for actual authorized source prerequisites",
  );
  config = await privateRead(process.env.M2_CONFIG_FILE);
  protect(config);
  gates.target_safety = { status: "pass" };
  await gate("live_health", async () =>
    equal(
      (await owner(null, "/healthz")).ok,
      true,
      "Actual target did not report healthy persistence",
    ),
  );
  if (phase === "resume") return resume();
  if (phase === "membership-resume") return membershipResume();
  if (config.github && phase !== "surfaces") {
    check(
      config.github.approvedDisposableIdentity === true,
      "GitHub recipe requires explicit approved disposable identity; existing personal/mounted credentials are prohibited",
    );
    const user = await readGitHubUser(config.github.credential);
    config.sources = githubSourceFixtures({
      credential: config.github.credential,
      user,
      namespace: randomUUID(),
      ownership: config.github.ownership,
    });
  }
  let client, foreign;
  await gate("owner_workspace_setup", async () => {
    client = await signup("owner");
    foreign = await signup("foreign isolation");
  });
  if (phase === "surfaces") {
    const controlConfig = config.controlledExternal;
    check(
      controlConfig &&
        (!controlConfig.availableRuntimes ||
          controlConfig.availableRuntimes.includes(runtime)),
      "Reachable surfaces require an actual controlled HTTPS source for this runtime",
    );
    const context = await install(
      client,
      foreign,
      { ...controlConfig.source, controlled: true },
      "Approved reachable surfaces, not Provider acceptance",
    );
    const profile = await createProfile(
      client,
      "Reachable protected artifacts",
    );
    const artifacts = await artifactSuite(client, foreign, profile);
    const controlled = { context, controlConfig };
    await brokerSuite(client, controlled);
    await multipartSuite(client, foreign, artifacts, controlled);
    pending(
      "full_m2_acceptance",
      "Approved reduced surface proof does not claim full M2 acceptance",
    );
    return;
  }
  if (phase === "membership-prepare") return membershipPrepare(client, foreign);
  const contexts = [];
  for (const kind of TYPES) {
    const source = config.sources?.find((entry) => entry.kind === kind);
    if (source)
      check(
        source.controlled !== true && source.accounts?.length > 0,
        "Controlled/public fixture cannot substitute a real authorized source matrix cell",
      );
    if (!source) {
      cells[`${runtime}/${kind}`] = {
        status: "pending",
        reason:
          "Missing real authorized source/Account/operation prerequisites",
      };
      pending(
        `${kind}/real_authorized_operation`,
        "Supply actual authorized Provider/MCP source and meaningful business result assertions",
      );
      continue;
    }
    let context;
    await gate(`${kind}/owner_draft_publish_discovery`, async () => {
      context = await install(
        client,
        foreign,
        source,
        `M2 ${kind} ${randomUUID()}`,
      );
    });
    contexts.push(context);
    await sourceSuite(context);
  }
  let schedulerContext;
  if (!contexts.some((context) => context.source.kind === "typescript")) {
    const source = schedulerSource();
    await gate("isolated_guest_authoring_not_provider_proof", async () => {
      schedulerContext = await install(
        client,
        foreign,
        source,
        "Actual isolated guest immutable authoring only, not Provider proof",
      );
    });
  }
  // Review-only corpus is independent of the durable revision wait. Keep a
  // published Profile above so whole-source rejection still proves no change
  // to existing authority, then fail fast before the autonomous wait.
  await schemaSuite(
    client,
    (schedulerContext ?? contexts[0]).identity.profileId,
  );
  if (schedulerContext) {
    const source = schedulerContext.source;
    await revisionSuite(schedulerContext, source.revisionSource, false);
    await revisionSuite(schedulerContext, source.driftSource, true);
  }
  const artifactProfile = await createProfile(client, "M2 protected artifacts"),
    artifacts = await artifactSuite(client, foreign, artifactProfile);
  const controlled = await controlledSuite(client, foreign);
  await sandboxSuite(client);
  await brokerSuite(client, controlled);
  await compatibilitySuite(client, foreign, contexts);
  await oauthSuite(client, foreign);
  await multipartSuite(client, foreign, artifacts, controlled);
  pending(
    "current_principal_membership_real_http",
    "Use membership-prepare, parent-owned isolated native membership fixture setup, then membership-resume; no emailVerified fabrication or source authoring SQL",
  );
  if (phase === "prepare") {
    const restartContexts =
      contexts.length > 0
        ? contexts
        : controlled
          ? [controlled.context]
          : [schedulerContext];
    await prepare(restartContexts, client, controlled);
  } else {
    await m1Regression();
    pending(
      "real_approval_deadline_and_dispatch_expiry",
      "Use prepare and resume with M2_EXPIRY_WAIT=yes for both actual 15-minute expiry paths",
    );
    pending(
      "actual_restart_no_http_recovery",
      "Suite phase cannot prove a real restart; use prepare/restart/resume",
    );
  }
}
try {
  await main();
} catch {
  gates[current] = { ...gates[current], status: "fail", reason };
}
const status = Object.values(gates).some((item) => item.status === "fail")
  ? "fail"
  : Object.values(gates).some((item) => item.status === "pending")
    ? "pending"
    : "pass";
console.log(
  JSON.stringify(
    {
      proof:
        phase === "surfaces"
          ? "M2 reachable broker/multipart HTTP proof"
          : "M2 real black-box HTTP acceptance",
      contract_version: CONTRACT_VERSION,
      protocol: PROTOCOL_VERSION,
      phase,
      runtime: runtime ?? null,
      target_origin: base?.origin ?? null,
      status,
      elapsed_ms: Date.now() - started,
      protocol_client_certification: "not_claimed",
      six_source_deployment_cells: cells,
      gates,
    },
    null,
    2,
  ),
);
process.exitCode = status === "fail" ? 1 : status === "pending" ? 2 : 0;
