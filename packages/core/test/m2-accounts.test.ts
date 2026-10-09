import { readFile } from "node:fs/promises";
import { createDatabase } from "@scaffold/database";
import { SQLiteBinding } from "@scaffold/database/sqlite";
import type { AccountView, Requirement } from "@scaffold/schema/integrations";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AccountsService,
  accountIdentityDigest,
  assertAccountCompatibility,
  createAccountsService,
} from "../src/integrations/accounts";
import { createCredentialProtection } from "../src/integrations/credential-protection";
import { createGithubProvider } from "../src/integrations/providers/github";
import { createRemoteMcpAdapter } from "../src/integrations/remote-mcp";
import type {
  HttpTransport,
  HttpTransportInput,
} from "../src/integrations/transport";

const secret = "public-M2-test-root-not-a-production-credential";
const owner = { orgId: "org-one", userId: "owner-one" };
const opened: SQLiteBinding[] = [];
afterEach(() => {
  for (const binding of opened.splice(0)) binding.close();
});
async function database() {
  const binding = new SQLiteBinding(":memory:");
  opened.push(binding);
  for (const file of [
    "0000_initial.sql",
    "0001_control.sql",
    "0003_m2_accounts.sql",
    "0005_m2_scope_coverage.sql",
  ])
    await binding.exec(
      await readFile(
        new URL(`../../database/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  await binding
    .prepare("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)")
    .bind(owner.orgId, "Unit Workspace", "unit-one")
    .run();
  await binding
    .prepare("INSERT INTO users(id,name,email) VALUES(?,?,?)")
    .bind(owner.userId, "Unit Owner", "owner-one@unit.example.com")
    .run();
  await binding
    .prepare(
      "INSERT INTO members(id,organization_id,user_id,role) VALUES('unit-member',?,?,'owner')",
    )
    .bind(owner.orgId, owner.userId)
    .run();
  await binding
    .prepare("INSERT INTO control_workspaces(org_id,created_at) VALUES(?,?)")
    .bind(owner.orgId, Date.now())
    .run();
  return { binding, db: createDatabase(binding) };
}
function githubTransport(
  handler?: (input: HttpTransportInput) => Promise<Response>,
): HttpTransport {
  return {
    async request(input) {
      if (handler) return handler(input);
      const token = input.headers.get("authorization");
      const id = token?.includes("two") ? 202 : 101;
      return Response.json(
        { id, login: `unit-${id}` },
        { headers: { "x-oauth-scopes": "read:user, repo" } },
      );
    },
  };
}
const requirement: Requirement = {
  provider: "github",
  methods: ["bearer"],
  scopes: ["read:user"],
  issuer: "https://github.com",
  audience: "https://api.github.com",
};
const nativeScopeCoverage = createGithubProvider({
  transport: githubTransport(),
}).coversScopes;
async function createAccount(
  service: AccountsService,
  ownership: "user" | "workspace" = "user",
  subject = "101",
  token = "public-unit-token-one",
) {
  return service.createAccount(owner, {
    provider: "github",
    alias: "GitHub Unit One",
    ownership,
    method: "bearer",
    identity: { subject },
    scopes: ["read:user"],
    credential: { kind: "bearer", token },
  });
}

describe("M2 Account isolation with real SQLite persistence and controlled Provider evidence", () => {
  it("discovers authenticated remote Tools through the real Account capability", async () => {
    const { db } = await database();
    const transport = githubTransport(async (input) => {
      if (new URL(input.url).origin === "https://api.github.com")
        return Response.json(
          { id: 101, login: "unit-101" },
          { headers: { "x-oauth-scopes": "read:user" } },
        );
      expect(input.headers.get("authorization")).toBe(
        "Bearer public-unit-token-one",
      );
      const rpc = JSON.parse(new TextDecoder().decode(input.body));
      if (rpc.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result:
          rpc.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "public-unit", version: "1" },
              }
            : {
                tools: [
                  {
                    name: "lookup",
                    description: "Unit lookup",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              },
      });
    });
    const accounts = createAccountsService({
      db,
      secret,
      providers: [createGithubProvider({ transport })],
    });
    const account = await createAccount(accounts);
    const remote = createRemoteMcpAdapter({
      transport,
      discoveryTransport: (context, id) =>
        accounts.createOwnerTransport(context, id),
      describeAuthentication: (context, id, endpoint) =>
        accounts.describeRemoteAuthentication(context, id, endpoint),
    });
    const result = await remote.resolveTools(
      {
        kind: "remote_mcp",
        endpoint: "https://api.githubcopilot.com/mcp/",
        namespace: "unit",
        nameMapping: {},
        accountId: account.accountId,
      },
      { ...owner, slug: "unit" },
    );
    expect(result.accepted.map((tool) => tool.name)).toEqual(["unit.lookup"]);
    expect(result.rejected).toEqual([]);
  });
  it("encrypts purpose-separated fresh nonces and rejects version/org/id/purpose swaps without changing M1", async () => {
    const codec = createCredentialProtection(secret);
    const value = {
      credential: { kind: "bearer", token: "public-unit-sensitive-marker" },
    };
    const cipher = await codec.encrypt(
      "org",
      "account",
      1,
      "credential",
      value,
    );
    expect(cipher).not.toContain(value.credential.token);
    expect(
      await codec.encrypt("org", "account", 1, "credential", value),
    ).not.toBe(cipher);
    expect(
      await codec.decrypt("org", "account", 1, "credential", cipher),
    ).toEqual(value);
    for (const [org, id, version, purpose] of [
      ["foreign", "account", 1, "credential"],
      ["org", "other", 1, "credential"],
      ["org", "account", 2, "credential"],
      ["org", "account", 1, "oauth_intent"],
    ] as const)
      await expect(
        codec.decrypt(org, id, version, purpose, cipher),
      ).rejects.toMatchObject({ code: "credential_unavailable" });
  });
  it("freezes distinct named same-Provider identities; User/Workspace never substitute", async () => {
    const { db, binding } = await database();
    const service = createAccountsService({
      db,
      secret,
      providers: [createGithubProvider({ transport: githubTransport() })],
    });
    const one = await createAccount(service),
      two = await createAccount(
        service,
        "workspace",
        "202",
        "public-unit-token-two",
      );
    const selected = await service.resolveBindings({
      orgId: owner.orgId,
      principalId: owner.userId,
      requirements: { source: requirement, other: requirement },
      bindings: { "unit.source": one.accountId, "unit.other": two.accountId },
      integrationSlug: "unit",
    });
    expect(selected.source!.identityDigest).not.toBe(
      selected.other!.identityDigest,
    );
    await expect(
      service.verifySelections({
        orgId: owner.orgId,
        principalId: null,
        requirements: { source: requirement },
        selections: { source: selected.source! },
      }),
    ).rejects.toMatchObject({ code: "account_incompatible" });
    await expect(
      service.resolveBindings({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirements: { source: requirement },
        bindings: { "unit.other": two.accountId },
        integrationSlug: "unit",
      }),
    ).rejects.toMatchObject({ code: "account_missing" });
    await expect(
      service.resolveBindings({
        orgId: owner.orgId,
        principalId: null,
        requirements: { other: requirement },
        bindings: { "unit.other": two.accountId },
        integrationSlug: "unit",
      }),
    ).resolves.toHaveProperty("other.accountId", two.accountId);
    await expect(
      service.getAccount(
        { orgId: "foreign", userId: owner.userId },
        one.accountId,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(JSON.stringify(await service.listAccounts(owner))).not.toMatch(
      /public-unit-token|cipher|refresh|credential_version/,
    );
    const cipher = await binding
      .prepare("SELECT cipher FROM control_credentials WHERE account_id=?")
      .bind(one.accountId)
      .first<{ cipher: string }>();
    expect(cipher!.cipher).not.toContain("public-unit-token-one");
    const authorized = await service.authorize({
      orgId: owner.orgId,
      principalId: owner.userId,
      requirement,
      selection: selected.source!,
      url: "https://api.github.com/user",
      headers: new Headers(),
    });
    expect(authorized.headers.get("authorization")).toBe(
      "Bearer public-unit-token-one",
    );
    expect(authorized.redact("public-unit-token-one")).toBe("[redacted]");
    await expect(
      service.authorize({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirement,
        selection: selected.source!,
        url: "https://echo.example.com/user",
        headers: new Headers(),
      }),
    ).rejects.toMatchObject({ code: "broker_forbidden" });
  });
  it.each([
    "method",
    "issuer",
    "audience",
    "tenant",
    "application",
    "scopes",
  ] as const)("requires exact current %s compatibility", async (dimension) => {
    const view: AccountView = {
      accountId: crypto.randomUUID(),
      provider: "github",
      alias: "Unit",
      ownership: "user",
      ownerUserId: owner.userId,
      method: "bearer",
      identity: {
        subject: "101",
        issuer: "https://github.com",
        audience: "https://api.github.com",
      },
      scopes: ["read:user"],
      enabled: true,
      health: "healthy",
      expiresAt: null,
      createdAt: new Date().toISOString(),
    };
    const changed: Requirement = {
      ...requirement,
      scopes: [...requirement.scopes],
    };
    if (dimension === "method") changed.methods = ["oauth2"];
    else if (dimension === "scopes") changed.scopes.push("admin:org");
    else changed[dimension] = "different-verified-claim";
    expect(() =>
      assertAccountCompatibility(
        view,
        changed,
        owner.userId,
        Date.now(),
        nativeScopeCoverage,
      ),
    ).toThrow();
    expect(() =>
      assertAccountCompatibility(
        { ...view, enabled: false },
        requirement,
        owner.userId,
        Date.now(),
        nativeScopeCoverage,
      ),
    ).toThrow();
    expect(() =>
      assertAccountCompatibility(
        { ...view, health: "revoked" },
        requirement,
        owner.userId,
        Date.now(),
        nativeScopeCoverage,
      ),
    ).toThrow();
    expect(() =>
      assertAccountCompatibility(
        { ...view, expiresAt: new Date(0).toISOString() },
        requirement,
        owner.userId,
        Date.now(),
        nativeScopeCoverage,
      ),
    ).toThrow();
  });
  it("preserves frozen identity and alias during same-subject rotation, blocks identity swaps and current disable", async () => {
    const { db, binding } = await database();
    const service = createAccountsService({
      db,
      secret,
      providers: [createGithubProvider({ transport: githubTransport() })],
    });
    const account = await createAccount(service);
    const selections = await service.resolveBindings({
      orgId: owner.orgId,
      principalId: owner.userId,
      requirements: { source: requirement },
      bindings: { "unit.source": account.accountId },
      integrationSlug: "unit",
    });
    await service.updateAccount(owner, account.accountId, {
      alias: "Renamed Unit",
      credential: { kind: "bearer", token: "public-unit-rotated-one" },
    });
    expect(selections.source!.alias).toBe("GitHub Unit One");
    await service.verifySelections({
      orgId: owner.orgId,
      principalId: owner.userId,
      requirements: { source: requirement },
      selections,
    });
    expect(
      await binding
        .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
        .bind(owner.orgId)
        .first("epoch"),
    ).toBe(0);
    await expect(
      service.updateAccount(owner, account.accountId, {
        credential: { kind: "bearer", token: "public-unit-token-two" },
      }),
    ).rejects.toMatchObject({ code: "account_identity_changed" });
    await service.updateAccount(owner, account.accountId, { enabled: false });
    expect(
      await binding
        .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
        .bind(owner.orgId)
        .first("epoch"),
    ).toBe(1);
    await expect(
      service.verifySelections({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirements: { source: requirement },
        selections,
      }),
    ).rejects.toMatchObject({ code: "account_disabled" });
  });
  it("checks current restrictions after claim fence before injection", async () => {
    const { db } = await database();
    const service = createAccountsService({
      db,
      secret,
      providers: [createGithubProvider({ transport: githubTransport() })],
    });
    const account = await createAccount(service);
    const selected = await service.resolveBindings({
      orgId: owner.orgId,
      principalId: owner.userId,
      requirements: { source: requirement },
      bindings: { "unit.source": account.accountId },
      integrationSlug: "unit",
    });
    await expect(
      service.authorize({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirement,
        selection: selected.source!,
        url: "https://api.github.com/user",
        headers: new Headers(),
        beforeCredentialUse: () =>
          service
            .updateAccount(owner, account.accountId, { enabled: false })
            .then(() => {}),
      }),
    ).rejects.toMatchObject({ code: "account_disabled" });
  });
  it("does not trust manual scope/app/tenant assertions or successful /user alone", async () => {
    const { db } = await database();
    const service = createAccountsService({
      db,
      secret,
      providers: [
        createGithubProvider({
          transport: githubTransport(async () =>
            Response.json({ id: 101, login: "unit" }),
          ),
        }),
      ],
    });
    await expect(createAccount(service)).rejects.toMatchObject({
      code: "account_scope_required",
    });
    await expect(
      service.createAccount(owner, {
        provider: "github",
        alias: "Unit",
        ownership: "workspace",
        method: "bearer",
        identity: { subject: "101", application: "asserted-app" },
        scopes: [],
        credential: { kind: "bearer", token: "public-unit" },
      }),
    ).rejects.toMatchObject({ code: "account_identity_changed" });
  });
  it("excludes token, scopes and alias from identity digest, includes immutable ownership and every optional claim", async () => {
    const base = {
      provider: "github",
      ownership: "user" as const,
      ownerUserId: owner.userId,
      method: "bearer",
      identity: {
        subject: "101",
        issuer: "https://github.com",
        audience: "https://api.github.com",
      },
    };
    expect(await accountIdentityDigest(base)).toBe(
      await accountIdentityDigest({ ...base, identity: { ...base.identity } }),
    );
    expect(
      await accountIdentityDigest({ ...base, ownerUserId: "other" }),
    ).not.toBe(await accountIdentityDigest(base));
    expect(
      await accountIdentityDigest({
        ...base,
        identity: { ...base.identity, application: "app" },
      }),
    ).not.toBe(await accountIdentityDigest(base));
  });
  it("atomically cancels only scope-affected waiting Runs, then expires nonrefreshable bindings without touching unrelated Accounts", async () => {
    const { db, binding } = await database();
    const service = createAccountsService({
      db,
      secret,
      providers: [createGithubProvider({ transport: githubTransport() })],
    });
    const account = await createAccount(service),
      other = await createAccount(
        service,
        "workspace",
        "202",
        "public-unit-token-two",
      );
    await binding
      .prepare(
        "INSERT INTO control_profiles(id,org_id,label,created_at,updated_at) VALUES('profile',?,'Unit',?,?)",
      )
      .bind(owner.orgId, Date.now(), Date.now())
      .run();
    await binding
      .prepare(
        "INSERT INTO control_grants(id,org_id,profile_id,label,token_hash,created_at) VALUES('grant',?,'profile','Unit','public-unit-hash',?)",
      )
      .bind(owner.orgId, Date.now())
      .run();
    const selected = await service.resolveBindings({
      orgId: owner.orgId,
      principalId: owner.userId,
      requirements: { source: requirement },
      bindings: { "unit.source": account.accountId },
      integrationSlug: "unit",
    });
    for (const [id, accountId, scopes] of [
      ["scoped", account.accountId, ["read:user"]],
      ["identity", account.accountId, []],
      ["other", other.accountId, []],
    ] as const) {
      await binding
        .prepare(
          "INSERT INTO control_runs(id,org_id,grant_id,profile_id,tool,tool_revision,status,created_at,updated_at,policy_decision,display_json,admitted_epoch) VALUES(?,?,'grant','profile','unit.read','unit-v1','pending_approval',?,?,'ask','{}',0)",
        )
        .bind(id, owner.orgId, Date.now(), Date.now())
        .run();
      await binding
        .prepare(
          "INSERT INTO control_run_accounts(run_id,requirement,account_id,identity_digest,alias,requirement_json) SELECT ?,'source',id,identity_digest,alias,? FROM control_accounts WHERE id=?",
        )
        .bind(id, JSON.stringify({ ...requirement, scopes }), accountId)
        .run();
    }
    await binding
      .prepare("UPDATE control_accounts SET scopes_json='[]' WHERE id=?")
      .bind(account.accountId)
      .run();
    expect(
      await binding
        .prepare("SELECT status FROM control_runs WHERE id='scoped'")
        .first("status"),
    ).toBe("canceled");
    expect(
      await binding
        .prepare("SELECT status FROM control_runs WHERE id='identity'")
        .first("status"),
    ).toBe("pending_approval");
    await service.verifySelections({
      orgId: owner.orgId,
      principalId: owner.userId,
      requirements: { source: { ...requirement, scopes: [] } },
      selections: selected,
    });
    await expect(
      service.verifySelections({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirements: { source: requirement },
        selections: selected,
      }),
    ).rejects.toMatchObject({ code: "account_scope_required" });
    await binding
      .prepare("UPDATE control_accounts SET expires_at=0 WHERE id=?")
      .bind(account.accountId)
      .run();
    await service.cleanup();
    expect(
      await binding
        .prepare("SELECT error_code FROM control_runs WHERE id='identity'")
        .first("error_code"),
    ).toBe("account_expired");
    expect(
      await binding
        .prepare("SELECT status FROM control_runs WHERE id='other'")
        .first("status"),
    ).toBe("pending_approval");
    expect(
      await binding
        .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
        .bind(owner.orgId)
        .first("epoch"),
    ).toBe(2);
    await expect(
      binding
        .prepare("UPDATE control_accounts SET identity_json='{}' WHERE id=?")
        .bind(account.accountId)
        .run(),
    ).rejects.toThrow();
    await expect(
      binding
        .prepare(
          "UPDATE control_run_accounts SET account_id=? WHERE run_id='identity'",
        )
        .bind(other.accountId)
        .run(),
    ).rejects.toThrow();
  });
  it("keeps immutable dedupe identities readable while current dispatch authorization is revoked", async () => {
    const { db, binding } = await database();
    const service = createAccountsService({
      db,
      secret,
      providers: [createGithubProvider({ transport: githubTransport() })],
    });
    const account = await createAccount(service);
    const context = {
      orgId: owner.orgId,
      principalId: owner.userId,
      requirements: { source: requirement },
      bindings: { "unit.source": account.accountId },
      integrationSlug: "unit",
    };
    const selected = await service.resolveBindings(context);
    await binding
      .prepare("DELETE FROM members WHERE user_id=?")
      .bind(owner.userId)
      .run();
    expect(
      (await service.resolveBoundIdentities(context)).source!.identityDigest,
    ).toBe(await accountIdentityDigest(account));
    await expect(
      service.verifySelections({ ...context, selections: selected }),
    ).rejects.toMatchObject({ code: "account_incompatible" });
    await binding
      .prepare(
        "INSERT INTO members(id,organization_id,user_id,role) VALUES('rejoined',?,?,'member')",
      )
      .bind(owner.orgId, owner.userId)
      .run();
    await expect(
      service.verifySelections({ ...context, selections: selected }),
    ).resolves.toBeUndefined();
    await binding
      .prepare("UPDATE control_accounts SET enabled=0 WHERE id=?")
      .bind(account.accountId)
      .run();
    expect(
      (await service.resolveBoundIdentities(context)).source!.accountId,
    ).toBe(account.accountId);
    await expect(service.resolveBindings(context)).rejects.toMatchObject({
      code: "account_disabled",
    });
  });
  it("validates every mapped acquisition method against real native Provider wire semantics without dispatch", async () => {
    const { db } = await database();
    let calls = 0;
    const service = createAccountsService({
      db,
      secret,
      providers: [
        createGithubProvider({
          transport: {
            async request() {
              calls++;
              throw new Error("must not dispatch");
            },
          },
        }),
      ],
    });
    const native = {
      provider: "github",
      methods: ["oauth2" as const],
      scopes: [],
    };
    expect(() =>
      service.validateSecurityMapping(
        { type: "http", scheme: "bearer" },
        native,
      ),
    ).not.toThrow();
    expect(() =>
      service.validateSecurityMapping(
        { type: "http", scheme: "bearer" },
        { ...native, methods: ["bearer", "oauth2"] },
      ),
    ).not.toThrow();
    expect(() =>
      service.validateSecurityMapping(
        { type: "http", scheme: "bearer" },
        { ...native, methods: ["none"] },
      ),
    ).toThrow();
    expect(() =>
      service.validateSecurityMapping(
        { type: "http", scheme: "basic" },
        native,
      ),
    ).toThrow();
    expect(() =>
      service.validateSecurityMapping(
        { type: "apiKey", in: "header", name: "x-api-key" },
        native,
      ),
    ).toThrow();
    const scheme = {
      type: "oauth2",
      flows: {
        authorizationCode: {
          authorizationUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          scopes: { offline_access: "Native refresh-token acquisition" },
        },
      },
    };
    expect(() => service.validateSecurityMapping(scheme, native)).not.toThrow();
    expect(() =>
      service.validateSecurityMapping(
        {
          ...scheme,
          flows: {
            authorizationCode: {
              ...scheme.flows.authorizationCode,
              tokenUrl: "https://echo.example.com/token",
            },
          },
        },
        native,
      ),
    ).toThrow();
    expect(() =>
      service.validateSecurityMapping(
        {
          ...scheme,
          flows: {
            authorizationCode: {
              ...scheme.flows.authorizationCode,
              scopes: { repo: "Not a GitHub App scope" },
            },
          },
        },
        native,
      ),
    ).toThrow();
    expect(() =>
      service.validateSecurityMapping(scheme, {
        ...native,
        methods: ["bearer"],
      }),
    ).toThrow();
    expect(calls).toBe(0);
  });
  it("uses only documented native inclusions without manufacturing stored granted scopes", async () => {
    const { db } = await database();
    const provider = createGithubProvider({
      transport: githubTransport(async () =>
        Response.json(
          { id: 101, login: "unit" },
          { headers: { "x-oauth-scopes": "user" } },
        ),
      ),
    });
    const service = createAccountsService({
      db,
      secret,
      providers: [provider],
    });
    const account = await service.createAccount(owner, {
      provider: "github",
      alias: "Normalized User",
      ownership: "user",
      method: "bearer",
      identity: { subject: "101" },
      scopes: ["user:email"],
      credential: { kind: "bearer", token: "public-normalized-unit-token" },
    });
    expect(account.scopes).toEqual(["user"]);
    expect(
      provider.coversScopes(account.scopes, [
        "read:user",
        "user:email",
        "user:follow",
      ]),
    ).toBe(true);
    expect(
      provider.coversScopes(["repo"], ["repo:status", "repo:invite"]),
    ).toBe(true);
    expect(
      provider.coversScopes(["user"], ["user:arbitrary", "admin:org"]),
    ).toBe(false);
    expect(provider.coversScopes(["read:user"], ["user:email"])).toBe(false);
    await expect(
      service.resolveBindings({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirements: { email: { ...requirement, scopes: ["user:email"] } },
        bindings: { "unit.email": account.accountId },
        integrationSlug: "unit",
      }),
    ).resolves.toHaveProperty("email.accountId", account.accountId);
  });
  it("applies identical normalized coverage in the durable scope-loss trigger and waiting requirements", async () => {
    const { db, binding } = await database();
    const service = createAccountsService({
      db,
      secret,
      providers: [createGithubProvider({ transport: githubTransport() })],
    });
    const account = await createAccount(service);
    await binding
      .prepare(
        "INSERT INTO control_profiles(id,org_id,label,created_at,updated_at) VALUES('scope-profile',?,'Scopes',?,?)",
      )
      .bind(owner.orgId, Date.now(), Date.now())
      .run();
    await binding
      .prepare(
        "INSERT INTO control_grants(id,org_id,profile_id,label,token_hash,created_at) VALUES('scope-grant',?,'scope-profile','Scopes','public-scope-hash',?)",
      )
      .bind(owner.orgId, Date.now())
      .run();
    for (const [id, scope] of [
      ["scope-read", "read:user"],
      ["scope-email", "user:email"],
    ] as const) {
      await binding
        .prepare(
          "INSERT INTO control_runs(id,org_id,grant_id,profile_id,tool,tool_revision,status,created_at,updated_at,policy_decision,display_json,admitted_epoch) VALUES(?,?,'scope-grant','scope-profile','unit.read','unit-v1','pending_approval',?,?,'ask','{}',0)",
        )
        .bind(id, owner.orgId, Date.now(), Date.now())
        .run();
      await binding
        .prepare(
          "INSERT INTO control_run_accounts(run_id,requirement,account_id,identity_digest,alias,requirement_json) SELECT ?,'source',id,identity_digest,alias,? FROM control_accounts WHERE id=?",
        )
        .bind(
          id,
          JSON.stringify({ ...requirement, scopes: [scope] }),
          account.accountId,
        )
        .run();
    }
    await binding
      .prepare(
        'UPDATE control_accounts SET scopes_json=\'["repo","user"]\' WHERE id=?',
      )
      .bind(account.accountId)
      .run();
    expect(
      await binding
        .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
        .bind(owner.orgId)
        .first("epoch"),
    ).toBe(0);
    expect(
      await binding
        .prepare("SELECT status FROM control_runs WHERE id='scope-read'")
        .first("status"),
    ).toBe("pending_approval");
    await binding
      .prepare(
        'UPDATE control_accounts SET scopes_json=\'["read:user","repo"]\' WHERE id=?',
      )
      .bind(account.accountId)
      .run();
    expect(
      await binding
        .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
        .bind(owner.orgId)
        .first("epoch"),
    ).toBe(1);
    expect(
      await binding
        .prepare("SELECT status FROM control_runs WHERE id='scope-read'")
        .first("status"),
    ).toBe("pending_approval");
    expect(
      await binding
        .prepare("SELECT error_code FROM control_runs WHERE id='scope-email'")
        .first("error_code"),
    ).toBe("account_scope_required");
  });
});
