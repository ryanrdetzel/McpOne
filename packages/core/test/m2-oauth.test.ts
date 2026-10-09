import { readFile } from "node:fs/promises";
import { createDatabase } from "@scaffold/database";
import { SQLiteBinding } from "@scaffold/database/sqlite";
import type { Requirement } from "@scaffold/schema/integrations";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/execution/canonical";
import {
  accountIdentityDigest,
  createAccountsService,
} from "../src/integrations/accounts";
import { createCredentialProtection } from "../src/integrations/credential-protection";
import {
  createOAuthService,
  type OAuthImpactPreviewer,
  safeOAuthReturnPath,
} from "../src/integrations/oauth";
import type {
  OAuthRegistration,
  StoredCredential,
} from "../src/integrations/provider";
import { createGithubProvider } from "../src/integrations/providers/github";
import {
  type HttpTransportInput,
  TransportError,
} from "../src/integrations/transport";

const owner = {
  orgId: "oauth-org",
  userId: "oauth-owner",
  sessionId: "public-unit-session-not-a-real-session",
};
const secret = "public-oauth-root-for-controlled-tests-only";
const emptyWorkspaceImpact: OAuthImpactPreviewer = async () => ({
  published: [],
});
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
    .bind(owner.orgId, "OAuth Unit", "oauth-unit")
    .run();
  await binding
    .prepare("INSERT INTO users(id,name,email) VALUES(?,?,?)")
    .bind(owner.userId, "OAuth Owner", "oauth-owner@unit.example.com")
    .run();
  await binding
    .prepare(
      "INSERT INTO members(id,organization_id,user_id,role) VALUES('oauth-member',?,?,'owner')",
    )
    .bind(owner.orgId, owner.userId)
    .run();
  await binding
    .prepare(
      "INSERT INTO sessions(id,token,user_id,expires_at,active_organization_id) VALUES(?,?,?,?,?)",
    )
    .bind(
      owner.sessionId,
      "public-native-session-token-fixture",
      owner.userId,
      Date.now() + 86400000,
      owner.orgId,
    )
    .run();
  await binding
    .prepare("INSERT INTO control_workspaces(org_id,created_at) VALUES(?,?)")
    .bind(owner.orgId, Date.now())
    .run();
  return { binding, db: createDatabase(binding) };
}
function config(custody: "local" | "hosted"): OAuthRegistration {
  const controlOrigin =
    custody === "local" ? "http://localhost:8787" : "https://unit.example.com";
  return {
    kind: "github_app",
    clientId: "Iv1.unitclient",
    clientSecret: "public-registration-fixture-not-real",
    callbackUrl: `${controlOrigin}/api/control/accounts/oauth/callback`,
    controlOrigin,
    custody,
  };
}
function nativeFixture(
  custody: "local" | "hosted",
  hook?: (input: HttpTransportInput) => Promise<Response | undefined>,
  kind: OAuthRegistration["kind"] = "github_app",
) {
  const requests: HttpTransportInput[] = [];
  const registration = config(custody);
  registration.kind = kind;
  if (kind === "oauth_app")
    registration.clientId = "unitOAuthClientWithoutPrefix";
  let scopes: string[] = kind === "oauth_app" ? ["read:user"] : [];
  let subject = 101;
  let rotations = 0;
  const transport = {
    async request(input: HttpTransportInput) {
      requests.push(input);
      const custom = await hook?.(input);
      if (custom) return custom;
      if (input.url === "https://github.com/login/oauth/access_token") {
        const refreshing =
          new URLSearchParams(new TextDecoder().decode(input.body)).get(
            "grant_type",
          ) === "refresh_token";
        if (refreshing) rotations++;
        return Response.json({
          access_token: refreshing
            ? `publicRenewedOAuthAccess${rotations}`
            : kind === "oauth_app"
              ? "publicOpaqueOAuthAccessWithoutPrefix"
              : "ghu_publicunitaccess",
          token_type: "bearer",
          scope: scopes.join(","),
          expires_in: 28800,
          refresh_token: refreshing
            ? `publicRotatedRefresh${rotations}`
            : "publicOpaqueRefreshWithoutPrefix",
          refresh_token_expires_in: 15897600,
        });
      }
      if (input.url === "https://api.github.com/user")
        return Response.json(
          { id: subject, login: "unit-user" },
          {
            headers:
              kind === "oauth_app"
                ? { "x-oauth-scopes": scopes.join(",") }
                : {},
          },
        );
      if (input.url.endsWith(`/applications/${registration.clientId}/token`))
        return Response.json({
          app: { client_id: registration.clientId },
          user: { id: subject },
          scopes,
          expires_at: null,
        });
      throw new Error("Unexpected controlled fixture request");
    },
  };
  return {
    registration,
    requests,
    provider: createGithubProvider({ transport, oauth: registration }),
    setSubject(value: number) {
      subject = value;
    },
    setScopes(value: string[]) {
      scopes = [...value];
    },
  };
}
const start = {
  provider: "github",
  alias: "GitHub OAuth Unit",
  ownership: "user" as const,
  scopes: ["offline_access"],
  returnPath: "/api/control/accounts",
};

describe("M2 native GitHub OAuth controlled protocol/custody tests (not live registration proof)", () => {
  it("truthfully rejects missing registration and unsupported requested app scopes", async () => {
    const { db } = await database();
    const provider = createGithubProvider({
      transport: {
        async request() {
          throw new Error("must not dispatch");
        },
      },
    });
    const accounts = createAccountsService({
      db,
      secret,
      providers: [provider],
    });
    const oauth = createOAuthService({
      db,
      secret,
      accounts,
      providers: [provider],
      previewImpact: emptyWorkspaceImpact,
    });
    await expect(oauth.startOAuth(owner, start)).rejects.toMatchObject({
      code: "oauth_unavailable",
      status: 503,
    });
    const fixture = nativeFixture("local");
    const registered = createOAuthService({
      db,
      secret,
      accounts,
      providers: [fixture.provider],
      previewImpact: emptyWorkspaceImpact,
    });
    await expect(
      registered.startOAuth(owner, { ...start, scopes: ["repo"] }),
    ).rejects.toMatchObject({ code: "account_scope_required" });
    expect(fixture.requests).toHaveLength(0);
  });
  it.each([
    "//foreign.test/path",
    "https://foreign.test/path",
    "/api/control/%2e%2e/escape",
    "/api/control/%2Fescape",
    "/api/control/../escape",
    "/api/control/accounts?code=secret",
    "/api/control/accounts#fragment",
    "/api/control/accounts\\escape",
  ])("rejects unsafe return path %s", (path) => {
    expect(() => safeOAuthReturnPath(path)).toThrow();
  });
  it.each(["local", "hosted"] as const)(
    "uses same native PKCE/state/identity and encrypted %s custody",
    async (custody) => {
      const { db, binding } = await database(),
        fixture = nativeFixture(custody);
      const accounts = createAccountsService({
          db,
          secret,
          providers: [fixture.provider],
        }),
        oauth = createOAuthService({
          db,
          secret,
          accounts,
          providers: [fixture.provider],
          previewImpact: emptyWorkspaceImpact,
        });
      const started = await oauth.startOAuth(owner, start),
        authorization = new URL(started.authorizationUrl),
        state = authorization.searchParams.get("state")!;
      expect(authorization.origin).toBe("https://github.com");
      expect(authorization.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(authorization.searchParams.get("scope")).toBe("offline_access");
      expect(authorization.searchParams.get("redirect_uri")).toBe(
        fixture.registration.callbackUrl,
      );
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const storedState = await binding
        .prepare("SELECT * FROM control_oauth_states")
        .first<{
          state_digest: string;
          intent_cipher: string;
          session_digest: string;
        }>();
      expect(storedState!.state_digest).toBe(await sha256(state));
      expect(JSON.stringify(storedState)).not.toContain(state);
      expect(JSON.stringify(storedState)).not.toContain(owner.sessionId);
      expect(
        await oauth.callback(
          { ...owner, sessionId: "foreign-session" },
          { state, code: "public-code" },
          fixture.registration.callbackUrl,
        ),
      ).toMatchObject({ error: "oauth_state_invalid" });
      expect(fixture.requests).toHaveLength(0);
      const result = await oauth.callback(
        owner,
        { state, code: "public-code" },
        fixture.registration.callbackUrl,
      );
      expect(result).toEqual({ returnPath: start.returnPath });
      const exchange = new URLSearchParams(
        new TextDecoder().decode(fixture.requests[0]!.body),
      );
      const verifier = exchange.get("code_verifier")!;
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      );
      const challenge = btoa(String.fromCharCode(...digest))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      expect(challenge).toBe(authorization.searchParams.get("code_challenge"));
      const list = await accounts.listAccounts(owner);
      expect(list.accounts[0]).toMatchObject({
        method: "oauth2",
        identity: {
          subject: "101",
          issuer: "https://github.com",
          audience: "https://api.github.com",
          application: fixture.registration.clientId,
        },
        scopes: [],
        health: "healthy",
      });
      expect(JSON.stringify(list)).not.toMatch(
        /ghu_|ghr_|clientSecret|cipher|registrationId/,
      );
      const tokenRecord = await binding
        .prepare("SELECT * FROM control_credentials")
        .first<{ cipher: string }>();
      expect(tokenRecord!.cipher).not.toMatch(/ghu_|ghr_|public-code/);
      expect(
        await oauth.callback(
          owner,
          { state, code: "public-code" },
          fixture.registration.callbackUrl,
        ),
      ).toMatchObject({ error: "oauth_state_invalid" });
      expect(fixture.requests).toHaveLength(3);
    },
  );
  it("consumes denial/expired/wrong callback once without exchange and keeps existing Account usable", async () => {
    const { db, binding } = await database(),
      fixture = nativeFixture("local");
    const accounts = createAccountsService({
        db,
        secret,
        providers: [fixture.provider],
      }),
      oauth = createOAuthService({
        db,
        secret,
        accounts,
        providers: [fixture.provider],
        previewImpact: emptyWorkspaceImpact,
      });
    const connected = await oauth.startOAuth(owner, start);
    await oauth.callback(
      owner,
      {
        state: new URL(connected.authorizationUrl).searchParams.get("state")!,
        code: "public-code",
      },
      fixture.registration.callbackUrl,
    );
    const account = (await accounts.listAccounts(owner)).accounts[0]!;
    await expect(
      oauth.startOAuth(owner, {
        ...start,
        accountId: account.accountId,
        scopes: ["repo"],
      }),
    ).rejects.toMatchObject({ code: "account_scope_required" });
    for (const kind of ["denial", "expiry", "callback"] as const) {
      const started = await oauth.startOAuth(owner, {
          ...start,
          accountId: account.accountId,
        }),
        state = new URL(started.authorizationUrl).searchParams.get("state")!;
      if (kind === "expiry")
        await binding
          .prepare(
            "UPDATE control_oauth_states SET expires_at=0 WHERE state_digest=?",
          )
          .bind(await sha256(state))
          .run();
      const result = await oauth.callback(
        owner,
        {
          state,
          code: "public-code",
          ...(kind === "denial"
            ? { error: "untrusted-provider-error-message" }
            : {}),
        },
        kind === "callback"
          ? "http://localhost:8787/other"
          : fixture.registration.callbackUrl,
      );
      expect(result.error).toBe(
        kind === "denial" ? "oauth_consent_denied" : "oauth_state_invalid",
      );
      expect(result.returnPath).not.toContain(
        "untrusted-provider-error-message",
      );
    }
    expect(fixture.requests).toHaveLength(3);
    expect(await accounts.getAccount(owner, account.accountId)).toMatchObject({
      health: "healthy",
      identity: { subject: "101" },
      scopes: [],
    });
  });
  it("reconnects same identity only and does not overwrite a rotated credential after consent", async () => {
    const { db } = await database(),
      fixture = nativeFixture("local");
    const accounts = createAccountsService({
        db,
        secret,
        providers: [fixture.provider],
      }),
      oauth = createOAuthService({
        db,
        secret,
        accounts,
        providers: [fixture.provider],
        previewImpact: emptyWorkspaceImpact,
      });
    const first = await oauth.startOAuth(owner, start);
    await oauth.callback(
      owner,
      {
        state: new URL(first.authorizationUrl).searchParams.get("state")!,
        code: "public-code",
      },
      fixture.registration.callbackUrl,
    );
    const account = (await accounts.listAccounts(owner)).accounts[0]!;
    const change = await oauth.startOAuth(owner, {
      ...start,
      accountId: account.accountId,
    });
    fixture.setSubject(202);
    expect(
      await oauth.callback(
        owner,
        {
          state: new URL(change.authorizationUrl).searchParams.get("state")!,
          code: "public-code",
        },
        fixture.registration.callbackUrl,
      ),
    ).toMatchObject({ error: "account_identity_changed" });
    fixture.setSubject(101);
    const rotation = await oauth.startOAuth(owner, {
      ...start,
      accountId: account.accountId,
    });
    await accounts.updateAccount(owner, account.accountId, {
      credential: { kind: "bearer", token: "ghu_publicmanualrotation" },
    });
    expect(
      await oauth.callback(
        owner,
        {
          state: new URL(rotation.authorizationUrl).searchParams.get("state")!,
          code: "public-code",
        },
        fixture.registration.callbackUrl,
      ),
    ).toMatchObject({ error: "account_identity_changed" });
    expect(
      (await accounts.getAccount(owner, account.accountId)).identity.subject,
    ).toBe("101");
  });
  it("serializes rotating refresh and CAS prevents stale refresh from overwriting owner rotation", async () => {
    const { db, binding } = await database();
    let release!: () => void, entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
    const fixture = nativeFixture("local", async (input) => {
      if (input.url === "https://github.com/login/oauth/access_token") {
        entered();
        await blocked;
      }
      return undefined;
    });
    const accounts = createAccountsService({
      db,
      secret,
      providers: [fixture.provider],
    });
    const account = await accounts.activateOAuth(owner, {
      provider: "github",
      alias: "Refresh Unit",
      ownership: "user",
      verified: {
        identity: {
          subject: "101",
          issuer: "https://github.com",
          audience: "https://api.github.com",
          application: fixture.registration.clientId,
        },
        scopes: [],
        expiresAt: Date.now() - 1,
        stored: {
          credential: { kind: "bearer", token: "ghu_publicexpired" },
          refreshToken: "ghr_publicoriginal",
          refreshExpiresAt: Date.now() + 600000,
          registrationId: fixture.provider.registrationId,
        },
      },
    });
    const requirement: Requirement = {
      provider: "github",
      methods: ["oauth2"],
      scopes: [],
    };
    const selection = (
      await accounts.resolveBindings({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirements: { source: requirement },
        bindings: { "unit.source": account.accountId },
        integrationSlug: "unit",
      })
    ).source!;
    const attempts: string[] = [];
    const pending = accounts.authorize({
      orgId: owner.orgId,
      principalId: owner.userId,
      requirement,
      selection,
      url: "https://api.github.com/user",
      headers: new Headers(),
      beforeProviderRequest: async (attempt) => {
        attempts.push(attempt.url);
      },
    });
    await enteredPromise;
    await expect(
      accounts.authorize({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirement,
        selection,
        url: "https://api.github.com/user",
        headers: new Headers(),
      }),
    ).rejects.toMatchObject({ code: "credential_unavailable" });
    await accounts.updateAccount(owner, account.accountId, {
      credential: { kind: "bearer", token: "ghu_publicmanualrotation" },
    });
    release();
    await expect(pending).rejects.toMatchObject({
      code: "credential_unavailable",
    });
    const row = await binding
      .prepare(
        "SELECT version,cipher FROM control_credentials WHERE account_id=?",
      )
      .bind(account.accountId)
      .first<{ version: number; cipher: string }>();
    expect(row!.version).toBe(2);
    const stored = await createCredentialProtection(
      secret,
    ).decrypt<StoredCredential>(
      owner.orgId,
      account.accountId,
      row!.version,
      "credential",
      row!.cipher,
    );
    expect(stored.credential).toEqual({
      kind: "bearer",
      token: "ghu_publicmanualrotation",
    });
    expect(attempts).toHaveLength(1);
  });
  it("implements OAuth App incremental actual scopes, preserves denied/insufficient upgrades, and exposes scope-only impact", async () => {
    const { db, binding } = await database(),
      fixture = nativeFixture("local", undefined, "oauth_app");
    const accounts = createAccountsService({
      db,
      secret,
      providers: [fixture.provider],
    });
    const integrationId = crypto.randomUUID(),
      draftRevisionId = crypto.randomUUID(),
      profileId = crypto.randomUUID();
    const oauth = createOAuthService({
      db,
      secret,
      accounts,
      providers: [fixture.provider],
      async previewImpact(_owner, input) {
        const tools = [
          {
            name: "unit.email",
            requirement: "source",
            currentScopesSatisfied: input.coversScopes(input.currentScopes, [
              "user:email",
            ]),
            requestedScopesSufficient: input.coversScopes(
              input.requestedScopes,
              ["user:email"],
            ),
          },
        ];
        return {
          published: [],
          ...(input.review
            ? {
                proposed: {
                  integrationId,
                  draftRevisionId,
                  callable: false as const,
                  profiles: [
                    { profileId, label: "Selected controlled review", tools },
                  ],
                },
              }
            : {}),
        };
      },
    });
    const first = await oauth.startOAuth(owner, {
      ...start,
      scopes: ["read:user", "offline_access"],
    });
    expect(first.impact).toEqual({
      accountId: null,
      currentScopes: [],
      requestedScopes: ["read:user"],
      published: [],
    });
    expect(
      await oauth.callback(
        owner,
        {
          state: new URL(first.authorizationUrl).searchParams.get("state")!,
          code: "public-code",
        },
        fixture.registration.callbackUrl,
      ),
    ).not.toHaveProperty("error");
    const account = (await accounts.listAccounts(owner)).accounts[0]!;
    const original = await binding
      .prepare(
        "SELECT version,cipher FROM control_credentials WHERE account_id=?",
      )
      .bind(account.accountId)
      .first<{ version: number; cipher: string }>();
    const email: Requirement = {
      provider: "github",
      methods: ["oauth2"],
      scopes: ["user:email"],
    };
    await expect(
      accounts.resolveBindings({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirements: { source: email },
        bindings: { "unit.source": account.accountId },
        integrationSlug: "unit",
      }),
    ).rejects.toMatchObject({ code: "account_scope_required" });
    const upgradeInput = {
      ...start,
      accountId: account.accountId,
      scopes: ["user:email"],
      review: { integrationId, draftRevisionId, profileIds: [profileId] },
    };
    const denied = await oauth.startOAuth(owner, upgradeInput);
    expect(denied.impact).toMatchObject({
      currentScopes: ["read:user"],
      requestedScopes: ["read:user", "user:email"],
      proposed: {
        callable: false,
        profiles: [
          {
            tools: [
              {
                currentScopesSatisfied: false,
                requestedScopesSufficient: true,
              },
            ],
          },
        ],
      },
    });
    expect(new URL(denied.authorizationUrl).searchParams.get("scope")).toBe(
      "offline_access read:user user:email",
    );
    expect(
      await oauth.callback(
        owner,
        {
          state: new URL(denied.authorizationUrl).searchParams.get("state")!,
          error: "access_denied",
        },
        fixture.registration.callbackUrl,
      ),
    ).toMatchObject({ error: "oauth_consent_denied" });
    const insufficient = await oauth.startOAuth(owner, upgradeInput);
    expect(
      await oauth.callback(
        owner,
        {
          state: new URL(insufficient.authorizationUrl).searchParams.get(
            "state",
          )!,
          code: "public-code",
        },
        fixture.registration.callbackUrl,
      ),
    ).toMatchObject({ error: "account_scope_required" });
    expect(
      await binding
        .prepare(
          "SELECT version,cipher FROM control_credentials WHERE account_id=?",
        )
        .bind(account.accountId)
        .first(),
    ).toEqual(original);
    expect(await accounts.getAccount(owner, account.accountId)).toMatchObject({
      health: "healthy",
      scopes: ["read:user"],
    });
    const upgraded = await oauth.startOAuth(owner, upgradeInput);
    fixture.setScopes(["read:user", "user:email"]);
    expect(
      await oauth.callback(
        owner,
        {
          state: new URL(upgraded.authorizationUrl).searchParams.get("state")!,
          code: "public-code",
        },
        fixture.registration.callbackUrl,
      ),
    ).not.toHaveProperty("error");
    expect(await accounts.getAccount(owner, account.accountId)).toMatchObject({
      identity: account.identity,
      scopes: ["read:user", "user:email"],
    });
    await expect(
      accounts.resolveBindings({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirements: { source: email },
        bindings: { "unit.source": account.accountId },
        integrationSlug: "unit",
      }),
    ).resolves.toHaveProperty(
      "source.identityDigest",
      await accountIdentityDigest(account),
    );
    expect(
      await binding
        .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
        .bind(owner.orgId)
        .first("epoch"),
    ).toBe(0);
  });
  it("rejects an oversized complete OAuth impact response before storing any intent", async () => {
    const { db, binding } = await database(),
      fixture = nativeFixture("local");
    const accounts = createAccountsService({
      db,
      secret,
      providers: [fixture.provider],
    });
    const oauth = createOAuthService({
      db,
      secret,
      accounts,
      providers: [fixture.provider],
      async previewImpact() {
        return {
          published: Array.from({ length: 8000 }, () => ({
            profileId: crypto.randomUUID(),
            label: "x".repeat(128),
            tools: [],
          })),
        };
      },
    });
    await expect(oauth.startOAuth(owner, start)).rejects.toMatchObject({
      code: "payload_too_large",
      status: 413,
    });
    expect(
      await binding
        .prepare("SELECT count(*) AS count FROM control_oauth_states")
        .first("count"),
    ).toBe(0);
    expect(fixture.requests).toHaveLength(0);
  });
  it.each(["logout", "owner_role"] as const)(
    "rechecks native owner-session %s before consuming state",
    async (change) => {
      const { db, binding } = await database(),
        fixture = nativeFixture("local");
      const accounts = createAccountsService({
          db,
          secret,
          providers: [fixture.provider],
        }),
        oauth = createOAuthService({
          db,
          secret,
          accounts,
          providers: [fixture.provider],
          previewImpact: emptyWorkspaceImpact,
        });
      const started = await oauth.startOAuth(owner, start);
      if (change === "logout")
        await binding
          .prepare("DELETE FROM sessions WHERE id=?")
          .bind(owner.sessionId)
          .run();
      else
        await binding
          .prepare("UPDATE members SET role='member' WHERE user_id=?")
          .bind(owner.userId)
          .run();
      expect(
        await oauth.callback(
          owner,
          {
            state: new URL(started.authorizationUrl).searchParams.get("state")!,
            code: "public-code",
          },
          fixture.registration.callbackUrl,
        ),
      ).toMatchObject({ error: "oauth_state_invalid" });
      expect(fixture.requests).toHaveLength(0);
      expect((await accounts.listAccounts(owner)).accounts).toHaveLength(0);
    },
  );
  it.each(["before_token_send", "after_token_rotation"] as const)(
    "reuses rotating credentials only with aggregate native no-send proof: %s",
    async (failure) => {
      const { db, binding } = await database();
      let fail = true;
      const fixture = nativeFixture("local", async (input) => {
        if (
          fail &&
          input.url ===
            (failure === "before_token_send"
              ? "https://github.com/login/oauth/access_token"
              : "https://api.github.com/user")
        ) {
          fail = false;
          throw new TransportError("dns_failure", false);
        }
        return undefined;
      });
      const accounts = createAccountsService({
        db,
        secret,
        providers: [fixture.provider],
      });
      const account = await accounts.activateOAuth(owner, {
        provider: "github",
        alias: "Controlled refresh",
        ownership: "user",
        verified: {
          identity: {
            subject: "101",
            issuer: "https://github.com",
            audience: "https://api.github.com",
            application: fixture.registration.clientId,
          },
          scopes: [],
          expiresAt: Date.now() - 1,
          stored: {
            credential: { kind: "bearer", token: "publicExpiredAccess" },
            refreshToken: "publicOriginalRefresh",
            refreshExpiresAt: Date.now() + 600000,
            registrationId: fixture.provider.registrationId,
          },
        },
      });
      const requirement: Requirement = {
        provider: "github",
        methods: ["oauth2"],
        scopes: [],
      };
      const selection = (
        await accounts.resolveBindings({
          orgId: owner.orgId,
          principalId: owner.userId,
          requirements: { source: requirement },
          bindings: { "unit.source": account.accountId },
          integrationSlug: "unit",
        })
      ).source!;
      const input = {
        orgId: owner.orgId,
        principalId: owner.userId,
        requirement,
        selection,
        url: "https://api.github.com/user",
        headers: new Headers(),
      };
      await expect(accounts.authorize(input)).rejects.toMatchObject({
        code: "dns_failure",
        mayHaveDispatched: failure === "after_token_rotation",
      });
      expect(
        await binding
          .prepare(
            "SELECT refresh_unusable,refresh_lease_id FROM control_credentials WHERE account_id=?",
          )
          .bind(account.accountId)
          .first(),
      ).toEqual({
        refresh_unusable: Number(failure === "after_token_rotation"),
        refresh_lease_id: null,
      });
      if (failure === "before_token_send") {
        const authorized = await accounts.authorize(input);
        expect(authorized.headers.get("authorization")).toBe(
          "Bearer publicRenewedOAuthAccess1",
        );
        const record = await binding
          .prepare(
            "SELECT version,cipher FROM control_credentials WHERE account_id=?",
          )
          .bind(account.accountId)
          .first<{ version: number; cipher: string }>();
        expect(record!.version).toBe(2);
        const stored = await createCredentialProtection(
          secret,
        ).decrypt<StoredCredential>(
          owner.orgId,
          account.accountId,
          record!.version,
          "credential",
          record!.cipher,
        );
        expect(stored.refreshToken).toBe("publicRotatedRefresh1");
        expect(
          await accountIdentityDigest(
            await accounts.getAccount(owner, account.accountId),
          ),
        ).toBe(await accountIdentityDigest(account));
      } else {
        const count = fixture.requests.length;
        await expect(accounts.authorize(input)).rejects.toMatchObject({
          code: "account_expired",
        });
        expect(fixture.requests).toHaveLength(count);
      }
    },
  );
  it("refreshes OAuth App tokens through every native fence with identical verified scope/identity and no scope parameter", async () => {
    const { db, binding } = await database(),
      fixture = nativeFixture("local", undefined, "oauth_app");
    const accounts = createAccountsService({
        db,
        secret,
        providers: [fixture.provider],
      }),
      oauth = createOAuthService({
        db,
        secret,
        accounts,
        providers: [fixture.provider],
        previewImpact: emptyWorkspaceImpact,
      });
    const connected = await oauth.startOAuth(owner, {
      ...start,
      scopes: ["read:user", "offline_access"],
    });
    await oauth.callback(
      owner,
      {
        state: new URL(connected.authorizationUrl).searchParams.get("state")!,
        code: "public-code",
      },
      fixture.registration.callbackUrl,
    );
    const account = (await accounts.listAccounts(owner)).accounts[0]!;
    const requirement: Requirement = {
      provider: "github",
      methods: ["oauth2"],
      scopes: ["read:user"],
    };
    const selection = (
      await accounts.resolveBindings({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirements: { source: requirement },
        bindings: { "unit.source": account.accountId },
        integrationSlug: "unit",
      })
    ).source!;
    await binding
      .prepare("UPDATE control_accounts SET expires_at=? WHERE id=?")
      .bind(Date.now() - 1, account.accountId)
      .run();
    const epochAfterFixtureExpiry = await binding
      .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
      .bind(owner.orgId)
      .first("epoch");
    const order: string[] = [];
    const authorized = await accounts.authorize({
      orgId: owner.orgId,
      principalId: owner.userId,
      requirement,
      selection,
      url: "https://api.github.com/user",
      headers: new Headers(),
      async beforeProviderRequest(attempt) {
        order.push(attempt.url);
      },
      async beforeCredentialUse(budget) {
        expect(budget.maxValueBytes).toBeLessThanOrEqual(8192);
        order.push("business-fence");
      },
    });
    expect(order).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      `https://api.github.com/applications/${fixture.registration.clientId}/token`,
      "business-fence",
    ]);
    const refresh = fixture.requests.slice(3)[0]!;
    const body = new URLSearchParams(new TextDecoder().decode(refresh.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("publicOpaqueRefreshWithoutPrefix");
    expect(body.has("scope")).toBe(false);
    expect(authorized.headers.get("authorization")).toBe(
      "Bearer publicRenewedOAuthAccess1",
    );
    const after = await accounts.getAccount(owner, account.accountId);
    expect(after.scopes).toEqual(["read:user"]);
    expect(await accountIdentityDigest(after)).toBe(selection.identityDigest);
    expect(
      await binding
        .prepare("SELECT version FROM control_credentials WHERE account_id=?")
        .bind(account.accountId)
        .first("version"),
    ).toBe(2);
    expect(
      await binding
        .prepare("SELECT epoch FROM control_workspaces WHERE org_id=?")
        .bind(owner.orgId)
        .first("epoch"),
    ).toBe(epochAfterFixtureExpiry);
  });
  it.each(["application", "scope_concordance"] as const)(
    "never activates unproved OAuth App %s claims",
    async (mismatch) => {
      const { db } = await database();
      const fixture = nativeFixture(
        "local",
        async (input) => {
          if (input.url.includes("/applications/"))
            return Response.json({
              app: {
                client_id:
                  mismatch === "application"
                    ? "other-application"
                    : "unitOAuthClientWithoutPrefix",
              },
              user: { id: 101 },
              scopes:
                mismatch === "scope_concordance"
                  ? ["user:email"]
                  : ["read:user"],
              expires_at: null,
            });
          return undefined;
        },
        "oauth_app",
      );
      const accounts = createAccountsService({
          db,
          secret,
          providers: [fixture.provider],
        }),
        oauth = createOAuthService({
          db,
          secret,
          accounts,
          providers: [fixture.provider],
          previewImpact: emptyWorkspaceImpact,
        });
      const connected = await oauth.startOAuth(owner, {
        ...start,
        scopes: ["read:user", "offline_access"],
      });
      expect(
        await oauth.callback(
          owner,
          {
            state: new URL(connected.authorizationUrl).searchParams.get(
              "state",
            )!,
            code: "public-code",
          },
          fixture.registration.callbackUrl,
        ),
      ).toMatchObject({
        error:
          mismatch === "application"
            ? "account_identity_changed"
            : "account_scope_required",
      });
      expect((await accounts.listAccounts(owner)).accounts).toHaveLength(0);
    },
  );
  it("does not activate an Account after native owner authority is lost during exchange", async () => {
    const { db, binding } = await database();
    const fixture = nativeFixture("local", async (input) => {
      if (input.url === "https://github.com/login/oauth/access_token")
        await binding
          .prepare("UPDATE members SET role='member' WHERE user_id=?")
          .bind(owner.userId)
          .run();
      return undefined;
    });
    const accounts = createAccountsService({
        db,
        secret,
        providers: [fixture.provider],
      }),
      oauth = createOAuthService({
        db,
        secret,
        accounts,
        providers: [fixture.provider],
        previewImpact: emptyWorkspaceImpact,
      });
    const connected = await oauth.startOAuth(owner, start);
    expect(
      await oauth.callback(
        owner,
        {
          state: new URL(connected.authorizationUrl).searchParams.get("state")!,
          code: "public-code",
        },
        fixture.registration.callbackUrl,
      ),
    ).toMatchObject({ error: "oauth_state_invalid" });
    expect((await accounts.listAccounts(owner)).accounts).toHaveLength(0);
  });
  it.each(["bad_refresh_token", "invalid_grant"] as const)(
    "marks only the selected Account reconnect-required for native %s",
    async (error) => {
      const { db, binding } = await database();
      const fixture = nativeFixture("local", async (input) =>
        input.url === "https://github.com/login/oauth/access_token"
          ? Response.json({ error })
          : undefined,
      );
      const accounts = createAccountsService({
        db,
        secret,
        providers: [fixture.provider],
      });
      const account = await accounts.activateOAuth(owner, {
        provider: "github",
        alias: "Expired controlled OAuth",
        ownership: "user",
        verified: {
          identity: {
            subject: "101",
            issuer: "https://github.com",
            audience: "https://api.github.com",
            application: fixture.registration.clientId,
          },
          scopes: [],
          expiresAt: Date.now() - 1,
          stored: {
            credential: { kind: "bearer", token: "publicExpiredAccess" },
            refreshToken: "publicBadRefresh",
            refreshExpiresAt: Date.now() + 600000,
            registrationId: fixture.provider.registrationId,
          },
        },
      });
      const other = await accounts.createAccount(owner, {
        provider: "github",
        alias: "Unaffected controlled PAT",
        ownership: "workspace",
        method: "bearer",
        identity: { subject: "101" },
        scopes: [],
        credential: { kind: "bearer", token: "publicOtherToken" },
      });
      const requirement: Requirement = {
        provider: "github",
        methods: ["oauth2"],
        scopes: [],
      };
      const selection = (
        await accounts.resolveBindings({
          orgId: owner.orgId,
          principalId: owner.userId,
          requirements: { source: requirement },
          bindings: { "unit.source": account.accountId },
          integrationSlug: "unit",
        })
      ).source!;
      await expect(
        accounts.authorize({
          orgId: owner.orgId,
          principalId: owner.userId,
          requirement,
          selection,
          url: "https://api.github.com/user",
          headers: new Headers(),
        }),
      ).rejects.toMatchObject({ code: "account_revoked" });
      expect(await accounts.getAccount(owner, account.accountId)).toMatchObject(
        { health: "revoked", identity: { subject: "101" } },
      );
      expect(await accounts.getAccount(owner, other.accountId)).toMatchObject({
        health: "healthy",
        enabled: true,
      });
      expect(
        await binding
          .prepare(
            "SELECT refresh_unusable FROM control_credentials WHERE account_id=?",
          )
          .bind(account.accountId)
          .first("refresh_unusable"),
      ).toBe(1);
    },
  );
  it("never takes over an abandoned rotating-refresh lease or resends its secret", async () => {
    const { db, binding } = await database(),
      fixture = nativeFixture("local");
    const accounts = createAccountsService({
      db,
      secret,
      providers: [fixture.provider],
    });
    const account = await accounts.activateOAuth(owner, {
      provider: "github",
      alias: "Abandoned controlled refresh",
      ownership: "user",
      verified: {
        identity: {
          subject: "101",
          issuer: "https://github.com",
          audience: "https://api.github.com",
          application: fixture.registration.clientId,
        },
        scopes: [],
        expiresAt: Date.now() - 1,
        stored: {
          credential: { kind: "bearer", token: "publicExpiredAccess" },
          refreshToken: "publicAmbiguousRefresh",
          refreshExpiresAt: Date.now() + 600000,
          registrationId: fixture.provider.registrationId,
        },
      },
    });
    const requirement: Requirement = {
      provider: "github",
      methods: ["oauth2"],
      scopes: [],
    };
    const selection = (
      await accounts.resolveBindings({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirements: { source: requirement },
        bindings: { "unit.source": account.accountId },
        integrationSlug: "unit",
      })
    ).source!;
    await binding
      .prepare(
        "UPDATE control_credentials SET refresh_lease_id='abandoned',refresh_lease_until=0 WHERE account_id=?",
      )
      .bind(account.accountId)
      .run();
    await expect(
      accounts.authorize({
        orgId: owner.orgId,
        principalId: owner.userId,
        requirement,
        selection,
        url: "https://api.github.com/user",
        headers: new Headers(),
      }),
    ).rejects.toMatchObject({ code: "credential_unavailable" });
    expect(fixture.requests).toHaveLength(0);
    expect(
      await binding
        .prepare(
          "SELECT refresh_unusable,refresh_lease_id FROM control_credentials WHERE account_id=?",
        )
        .bind(account.accountId)
        .first(),
    ).toEqual({ refresh_unusable: 1, refresh_lease_id: null });
    expect(await accounts.getAccount(owner, account.accountId)).toMatchObject({
      health: "expired",
    });
  });
});
