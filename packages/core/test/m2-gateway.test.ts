import { readFile } from "node:fs/promises";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createDatabase } from "@scaffold/database";
import { SQLiteBinding } from "@scaffold/database/sqlite";
import type {
  IntegrationDraft,
  ReviewReport,
} from "@scaffold/schema/integrations";
import { afterEach, describe, expect, it } from "vitest";
import type { GrantIdentity } from "../src/execution/service";
import type { OrgRoleResult } from "../src/guard";
import {
  type ConnectionCredentials,
  createConnectionCredentials,
} from "../src/integrations/connection-credentials";
import { IntegrationRoutes } from "../src/integrations/routes";
import {
  createIntegrationServices,
  type IntegrationServices,
} from "../src/integrations/runtime";
import { createQuickJSEngineFactory } from "../src/integrations/sandbox";
import type {
  HttpTransport,
  HttpTransportInput,
} from "../src/integrations/transport";

const secret = "public-gateway-test-root-not-a-production-credential";
const owner = { orgId: "gateway-org-one", userId: "gateway-owner-one" };
const foreign = { orgId: "gateway-org-two", userId: "gateway-owner-two" };
// Controlled transport never dials these public hosts. Production URL checks still apply.
const firstEndpoint = "https://api.example.com/mcp";
const secondEndpoint = "https://docs.example.com/mcp";
const bearer = "public-gateway-bearer-sensitive-marker";
const session = "public-gateway-session-sensitive-marker";
const opened: SQLiteBinding[] = [];
afterEach(() => {
  for (const binding of opened.splice(0)) binding.close();
});

type Exchange = { input: HttpTransportInput; message: Record<string, unknown> };
type OwnerEnvironment = {
  Variables: { owner: Extract<OrgRoleResult, { ok: true }> };
};
interface Harness {
  binding: SQLiteBinding;
  services: IntegrationServices;
  credentials: ConnectionCredentials;
  app: OpenAPIHono<OwnerEnvironment>;
  transport: HttpTransport;
  exchanges: Exchange[];
}
function escaped(value: string) {
  return Array.from(
    value,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  ).join("");
}
function wire(
  id: unknown,
  result: unknown,
  headers: Record<string, string> = {},
) {
  // Secrets are not present as raw substrings on the wire: redaction must inspect
  // decoded strings AND property names, not just replace bytes before JSON parsing.
  const json = JSON.stringify({ jsonrpc: "2.0", id, result })
    .replaceAll(bearer, escaped(bearer))
    .replaceAll(session, escaped(session));
  return new Response(json, {
    headers: { "content-type": "application/json", ...headers },
  });
}
function controlledRemote(
  options: {
    discoveryEcho?: "bearer" | "session";
    resultEcho?: boolean;
    resultKeyEcho?: "bearer" | "session";
    beforeResponse?: (exchange: Exchange) => Promise<void>;
  } = {},
) {
  const exchanges: Exchange[] = [];
  const transport: HttpTransport = {
    async request(input) {
      const message: Record<string, unknown> = input.body
        ? JSON.parse(new TextDecoder().decode(input.body))
        : {};
      const exchange = { input, message };
      exchanges.push(exchange);
      await options.beforeResponse?.(exchange);
      if (input.method === "DELETE") return new Response(null, { status: 204 });
      if (message.method === "initialize")
        return wire(
          message.id,
          {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "controlled-gateway", version: "1" },
          },
          { "mcp-session-id": session },
        );
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (message.method === "tools/list") {
        const marker = options.discoveryEcho === "bearer" ? bearer : session;
        return wire(message.id, {
          tools: [
            {
              name: "lookup",
              description: options.discoveryEcho
                ? `Echo ${marker}`
                : "Read public fixture",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      }
      if (message.method === "tools/call") {
        expect(message.params).toEqual({ name: "lookup", arguments: {} });
        return wire(message.id, {
          content: [
            {
              type: "text",
              text: options.resultEcho
                ? `Bearer ${bearer}; session ${session}`
                : `Read ${new URL(input.url).host}`,
            },
          ],
          structuredContent: options.resultKeyEcho
            ? {
                [options.resultKeyEcho === "bearer" ? bearer : session]:
                  "sensitive identifier",
                safe: "retained",
              }
            : options.resultEcho
              ? {
                  value: bearer,
                  nested: [{ session, value: bearer }],
                  safe: "retained",
                }
              : { host: new URL(input.url).host },
        });
      }
      throw new Error("Unexpected controlled gateway operation");
    },
  };
  return { transport, exchanges };
}
async function setup(remote = controlledRemote()) {
  const binding = new SQLiteBinding(":memory:");
  opened.push(binding);
  for (const file of [
    "0000_initial.sql",
    "0001_control.sql",
    "0002_m2_catalog.sql",
    "0003_m2_accounts.sql",
    "0004_m2_artifacts.sql",
    "0005_m2_scope_coverage.sql",
    "0006_gateway_credentials.sql",
  ])
    await binding.exec(
      await readFile(
        new URL(`../../database/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  for (const [index, context] of [owner, foreign].entries()) {
    await binding
      .prepare("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)")
      .bind(
        context.orgId,
        `Gateway Workspace ${index}`,
        `gateway-workspace-${index}`,
      )
      .run();
    await binding
      .prepare("INSERT INTO users(id,name,email) VALUES(?,?,?)")
      .bind(
        context.userId,
        `Gateway Owner ${index}`,
        `gateway-${index}@example.com`,
      )
      .run();
    await binding
      .prepare(
        "INSERT INTO members(id,organization_id,user_id,role) VALUES(?,?,?,'owner')",
      )
      .bind(`gateway-member-${index}`, context.orgId, context.userId)
      .run();
  }
  const db = createDatabase(binding);
  const services = createIntegrationServices({
    db,
    secret,
    transport: remote.transport,
    providers: [],
    engineFactory: createQuickJSEngineFactory(),
  });
  const credentials = createConnectionCredentials({
    db,
    secret,
    transport: remote.transport,
  });
  const app = new OpenAPIHono<OwnerEnvironment>();
  app.use("*", async (c, next) => {
    c.set("owner", {
      ok: true,
      organizationId: owner.orgId,
      userId: owner.userId,
      sessionId: "gateway-owner-session",
    });
    await next();
  });
  app.route("/", new IntegrationRoutes(services).api);
  return { binding, services, credentials, app, ...remote };
}
async function connection(
  h: Harness,
  slug = "first",
  endpoint = firstEndpoint,
  token?: string,
) {
  return h.services.gateway.createConnection(owner, {
    slug,
    displayName: `${slug} remote`,
    endpoint,
    ...(token ? { bearerToken: token } : {}),
  });
}
async function publish(
  h: Harness,
  draft: IntegrationDraft,
  profileId: string,
  tools?: string[],
) {
  const report = await h.services.catalog.validate(
    owner,
    draft.integrationId,
    draft.draftRevisionId,
  );
  const profile = await h.services.catalog.profile(owner.orgId, profileId);
  const current = await h.services.catalog.get(
    owner.orgId,
    draft.integrationId,
  );
  await h.services.catalog.publish(owner, draft.integrationId, {
    draftRevisionId: draft.draftRevisionId,
    reportDigest: report.reportDigest,
    expectedCurrentRevisionId: current.currentRevisionId,
    profiles: [
      {
        profileId,
        expectedRevision: profile.revision,
        tools: tools ?? report.accepted.map((tool) => tool.name),
        bindings: {},
        policies: report.accepted.map((tool) => ({
          pattern: tool.name,
          decision: "allow",
        })),
      },
    ],
  });
  return report;
}
async function grant(h: Harness, profileId: string) {
  const issued = await h.services.execution.issueGrant(
    owner.orgId,
    profileId,
    "Gateway client",
    undefined,
    owner.userId,
  );
  return {
    ...issued,
    identity: await h.services.execution.authenticate(profileId, issued.token),
  };
}
async function invoke(
  h: Harness,
  identity: GrantIdentity,
  name = "first.lookup",
) {
  const admission = await h.services.execution.invoke(identity, {
    name,
    arguments: {},
  });
  await h.services.execution.drain();
  return h.services.execution.getRun(identity, admission.runId);
}
function credentialId(report: ReviewReport) {
  const implementation = report.accepted[0]?.implementation;
  if (
    implementation?.kind !== "remote_mcp" ||
    !implementation.connectionCredentialId
  )
    throw new Error(
      "Bearer remote discovery did not retain a credential reference",
    );
  return implementation.connectionCredentialId;
}
function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(bearer);
  expect(text).not.toContain(session);
  expect(text).not.toContain(escaped(bearer));
  expect(text).not.toContain(escaped(session));
}

describe("Gateway API and shared service behavior with real SQLite and controlled remote MCP", () => {
  it("creates an empty profile through the owner API, without provisioning the legacy fixture", async () => {
    const h = await setup();
    const response = await h.app.request("/gateway/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Empty gateway" }),
    });
    expect(response.status).toBe(201);
    const profile = await response.json();
    expect(profile).toMatchObject({
      label: "Empty gateway",
      enabled: true,
      tools: [],
      bindings: {},
    });
    const issued = await grant(h, profile.profileId);
    expect(
      (await h.services.execution.discover(issued.identity)).map(
        (tool) => tool.name,
      ),
    ).not.toContain("fixture.counter.increment");
    expect(
      await h.binding
        .prepare("SELECT count(*) AS count FROM control_tools")
        .first(),
    ).toEqual({ count: 0 });
    const list = await h.app.request("/gateway");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      connections: [],
      profiles: [{ profileId: profile.profileId, tools: [] }],
    });
  });

  it("publishes two connections with colliding upstream names into distinct namespaces and invokes the selected remote", async () => {
    const h = await setup();
    const profile = await h.services.gateway.createProfile(owner, {
      label: "Two remotes",
    });
    const response = await h.app.request("/gateway/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "first",
        displayName: "First remote",
        endpoint: firstEndpoint,
      }),
    });
    expect(response.status).toBe(201);
    const first: IntegrationDraft = await response.json();
    const second = await connection(h, "second", secondEndpoint);
    await publish(h, first, profile.profileId);
    const secondReport = await publish(h, second, profile.profileId);
    expect(secondReport.accepted.map((tool) => tool.name)).toEqual([
      "second.lookup",
    ]);
    expect(
      (await h.services.catalog.profile(owner.orgId, profile.profileId)).tools,
    ).toEqual(["first.lookup", "second.lookup"]);
    const issued = await grant(h, profile.profileId);
    expect(
      (await h.services.execution.discover(issued.identity)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["first.lookup", "runs.get", "second.lookup"]);
    expect(
      (await invoke(h, issued.identity)).businessResult?.structuredContent,
    ).toEqual({ host: "api.example.com" });
    expect(
      (await invoke(h, issued.identity, "second.lookup")).businessResult
        ?.structuredContent,
    ).toEqual({ host: "docs.example.com" });
    expect(
      h.exchanges
        .filter((exchange) => exchange.message.method === "tools/call")
        .map((exchange) => exchange.input.url),
    ).toEqual([firstEndpoint, secondEndpoint]);
    const state = await h.services.gateway.list(owner.orgId);
    expect(state.connections.map((item) => item.slug).sort()).toEqual([
      "first",
      "second",
    ]);
    expect((await h.services.gateway.list(foreign.orgId)).connections).toEqual(
      [],
    );
  });

  it("injects the downstream bearer only at the controlled transport and redacts decoded result strings and private sessions", async () => {
    const h = await setup(controlledRemote({ resultEcho: true }));
    const profile = await h.services.gateway.createProfile(owner, {
      label: "Bearer remote",
    });
    const response = await h.app.request("/gateway/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "first",
        displayName: "Bearer remote",
        endpoint: firstEndpoint,
        bearerToken: bearer,
      }),
    });
    expect(response.status).toBe(201);
    const draft: IntegrationDraft = await response.json();
    const report = await publish(h, draft, profile.profileId);
    const issued = await grant(h, profile.profileId);
    const result = await invoke(h, issued.identity);
    expect(result.status).toBe("succeeded");
    expect(result.businessResult?.structuredContent?.safe).toBe("retained");
    expect(JSON.stringify(result.businessResult)).toContain("[redacted]");
    for (const exchange of h.exchanges)
      expect(exchange.input.headers.get("authorization")).toBe(
        `Bearer ${bearer}`,
      );
    expect(
      h.exchanges.some((exchange) => exchange.message.method === "tools/call"),
    ).toBe(true);
    expectNoSecrets(result);
    expectNoSecrets(draft);
    expectNoSecrets(report);
    expectNoSecrets(await h.services.gateway.list(owner.orgId));
    expectNoSecrets(
      await h.services.catalog.get(owner.orgId, draft.integrationId),
    );
    expectNoSecrets(
      await h.services.catalog.snapshot(owner.orgId, draft.draftRevisionId),
    );
    expectNoSecrets(await h.services.execution.ownerRuns(owner.orgId));
    expectNoSecrets(
      await h.services.execution.ownerRun(owner.orgId, result.runId),
    );
    const catalog = await h.binding
      .prepare("SELECT content FROM control_catalog_chunks")
      .all();
    expectNoSecrets(catalog.results);
    const stored = await h.binding
      .prepare(
        "SELECT id,org_id,endpoint,cipher FROM control_connection_credentials",
      )
      .all();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]).toMatchObject({
      id: credentialId(report),
      org_id: owner.orgId,
      endpoint: firstEndpoint,
    });
    expectNoSecrets(stored.results);
    await expect(
      h.binding
        .prepare("UPDATE control_connection_credentials SET id=? WHERE id=?")
        .bind(crypto.randomUUID(), credentialId(report))
        .run(),
    ).rejects.toThrow("Connection credentials are immutable");
  });

  it.each(["bearer", "session"] as const)(
    "rejects decoded %s material in discovery instead of publishing altered manifest metadata",
    async (discoveryEcho) => {
      const h = await setup(controlledRemote({ discoveryEcho }));
      const draft = await connection(h, "first", firstEndpoint, bearer);
      await expect(
        h.services.catalog.validate(
          owner,
          draft.integrationId,
          draft.draftRevisionId,
        ),
      ).rejects.toMatchObject({ code: "import_invalid", retryable: false });
      expect(
        await h.binding
          .prepare("SELECT count(*) AS count FROM control_revision_manifests")
          .first(),
      ).toEqual({ count: 0 });
      expect(
        await h.binding
          .prepare("SELECT count(*) AS count FROM control_reviews")
          .first(),
      ).toEqual({ count: 0 });
      expectNoSecrets(
        (
          await h.binding
            .prepare("SELECT content FROM control_catalog_chunks")
            .all()
        ).results,
      );
      expect(
        h.exchanges.some(
          (exchange) => exchange.message.method === "tools/call",
        ),
      ).toBe(false);
    },
  );

  it.each(["bearer", "session"] as const)(
    "rejects decoded %s result keys without persisting credential material or silently renaming business identifiers",
    async (resultKeyEcho) => {
      const h = await setup(controlledRemote({ resultKeyEcho }));
      const profile = await h.services.gateway.createProfile(owner, {
        label: "Sensitive result key",
      });
      await publish(
        h,
        await connection(h, "first", firstEndpoint, bearer),
        profile.profileId,
      );
      const issued = await grant(h, profile.profileId);
      const result = await invoke(h, issued.identity);
      // A completed remote send with an unusable result is not safe to replay.
      expect(result.error?.code).toBe("outcome_unknown");
      expect(result.attempts).toBe(1);
      expect(result.businessResult).toBeUndefined();
      expectNoSecrets(result);
      expectNoSecrets(await h.services.execution.ownerRuns(owner.orgId));
      expect(
        h.exchanges.filter(
          (exchange) => exchange.message.method === "tools/call",
        ),
      ).toHaveLength(1);
    },
  );

  it("denies credential reuse across orgs, integrations, exact endpoints and unpublished profile selections before transport", async () => {
    const h = await setup();
    const profile = await h.services.gateway.createProfile(owner, {
      label: "Authorized",
    });
    const empty = await h.services.gateway.createProfile(owner, {
      label: "Unselected",
    });
    const otherProfile = await h.services.gateway.createProfile(foreign, {
      label: "Foreign",
    });
    const draft = await connection(h, "first", firstEndpoint, bearer);
    const report = await publish(h, draft, profile.profileId);
    const id = credentialId(report);
    const input = {
      orgId: owner.orgId,
      profileId: profile.profileId,
      integrationId: draft.integrationId,
      credentialId: id,
      endpoint: firstEndpoint,
      headers: new Headers(),
    };
    const authorized = await h.credentials.authorize(input);
    expect(authorized.headers.get("authorization")).toBe(`Bearer ${bearer}`);
    expect(authorized.redact(`Bearer ${bearer}`)).not.toContain(bearer);
    const sent = h.exchanges.length;
    for (const changed of [
      { orgId: foreign.orgId },
      { profileId: empty.profileId },
      { profileId: otherProfile.profileId },
      { integrationId: crypto.randomUUID() },
      { credentialId: crypto.randomUUID() },
      { endpoint: secondEndpoint },
      { endpoint: `${firstEndpoint}/` },
      { endpoint: `${firstEndpoint}?other=1` },
    ])
      await expect(
        h.credentials.authorize({ ...input, ...changed }),
      ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(
      h.credentials.ownerTransport(foreign, id, firstEndpoint),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      h.credentials.ownerTransport(owner, id, secondEndpoint),
    ).rejects.toMatchObject({ code: "forbidden" });
    const ownerTransport = await h.credentials.ownerTransport(
      owner,
      id,
      firstEndpoint,
    );
    const discoveryRequest = h.exchanges[0]?.input;
    if (!discoveryRequest) throw new Error("Expected a real discovery request");
    await expect(
      ownerTransport.request({ ...discoveryRequest, url: secondEndpoint }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      ownerTransport.request({
        ...discoveryRequest,
        url: firstEndpoint,
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "owner-business-denied",
            method: "tools/call",
            params: { name: "lookup", arguments: {} },
          }),
        ),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await h.services.catalog.patch(owner.orgId, draft.integrationId, {
      enabled: false,
    });
    await expect(h.credentials.authorize(input)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(h.exchanges).toHaveLength(sent);
  });

  it("does not authorize a draft credential merely because its profile exists", async () => {
    const h = await setup();
    const profile = await h.services.gateway.createProfile(owner, {
      label: "Unpublished",
    });
    const draft = await connection(h, "first", firstEndpoint, bearer);
    const report = await h.services.catalog.validate(
      owner,
      draft.integrationId,
      draft.draftRevisionId,
    );
    await expect(
      h.credentials.authorize({
        orgId: owner.orgId,
        profileId: profile.profileId,
        integrationId: draft.integrationId,
        credentialId: credentialId(report),
        endpoint: firstEndpoint,
        headers: new Headers(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (await h.services.catalog.profile(owner.orgId, profile.profileId)).tools,
    ).toEqual([]);
  });

  it("preserves another source's selections and policies when a connection is republished with no selected tools", async () => {
    const h = await setup();
    const profile = await h.services.gateway.createProfile(owner, {
      label: "Preserved selections",
    });
    const first = await connection(h);
    const second = await connection(h, "second", secondEndpoint);
    await publish(h, first, profile.profileId);
    await publish(h, second, profile.profileId);
    const refreshed = await h.services.catalog.refresh(
      owner,
      first.integrationId,
      {},
    );
    await publish(h, refreshed, profile.profileId, []);
    expect(
      (await h.services.catalog.profile(owner.orgId, profile.profileId)).tools,
    ).toEqual(["second.lookup"]);
    const issued = await grant(h, profile.profileId);
    expect(
      (await h.services.execution.discover(issued.identity)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["runs.get", "second.lookup"]);
    expect((await invoke(h, issued.identity, "second.lookup")).status).toBe(
      "succeeded",
    );
    const calls = h.exchanges.filter(
      (exchange) => exchange.message.method === "tools/call",
    );
    expect(calls.map((exchange) => exchange.input.url)).toEqual([
      secondEndpoint,
    ]);
  });

  it("fences a grant revoked during remote initialization before the business invocation", async () => {
    let revoke: (() => Promise<void>) | undefined;
    const h = await setup(
      controlledRemote({
        async beforeResponse(exchange) {
          if (exchange.message.method === "initialize") await revoke?.();
        },
      }),
    );
    const profile = await h.services.gateway.createProfile(owner, {
      label: "Revoked during handshake",
    });
    await publish(
      h,
      await connection(h, "first", firstEndpoint, bearer),
      profile.profileId,
    );
    const issued = await grant(h, profile.profileId);
    const sent = h.exchanges.length;
    revoke = () =>
      h.services.execution.revokeGrant(owner.orgId, issued.grantId);
    const admitted = await h.services.execution.invoke(issued.identity, {
      name: "first.lookup",
      arguments: {},
    });
    await h.services.execution.drain();
    const result = await h.services.execution.ownerRun(
      owner.orgId,
      admitted.runId,
    );
    expect(result.error?.code).toBe("grant_revoked");
    expect(result.businessResult).toBeUndefined();
    expect(
      h.exchanges.slice(sent).map((exchange) => exchange.message.method),
    ).toEqual(["initialize"]);
    expectNoSecrets(result);
  });

  it("revokes cached grant authority for discovery and invocation without sending another downstream request", async () => {
    const h = await setup();
    const profile = await h.services.gateway.createProfile(owner, {
      label: "Revoked grant",
    });
    await publish(
      h,
      await connection(h, "first", firstEndpoint, bearer),
      profile.profileId,
    );
    const issued = await grant(h, profile.profileId);
    expect((await invoke(h, issued.identity)).status).toBe("succeeded");
    const sent = h.exchanges.length;
    await h.services.execution.revokeGrant(owner.orgId, issued.grantId);
    await expect(
      h.services.execution.authenticate(profile.profileId, issued.token),
    ).rejects.toMatchObject({ code: "grant_revoked" });
    await expect(
      h.services.execution.discover(issued.identity),
    ).rejects.toMatchObject({ code: "grant_revoked" });
    const denied = await h.services.execution.invoke(issued.identity, {
      name: "first.lookup",
      arguments: {},
    });
    await h.services.execution.drain();
    expect(denied.error?.code).toBe("grant_revoked");
    expect(h.exchanges).toHaveLength(sent);
    expect(
      (await h.services.gateway.list(owner.orgId)).profiles[0]?.grants,
    ).toContainEqual(
      expect.objectContaining({ grantId: issued.grantId, revoked: true }),
    );
  });
});
