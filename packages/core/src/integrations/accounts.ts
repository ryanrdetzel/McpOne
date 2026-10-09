import type { Database } from "@scaffold/database";
import {
  type AccountIdentity,
  AccountView,
  CreateAccountInput,
  hasCodeUnitInRange,
  jsonProblem,
  PatchAccountInput,
  type Requirement,
  type SelectedAccount,
} from "@scaffold/schema/integrations";
import { canonicalJson, sha256 } from "../execution/canonical";
import { ControlError } from "../execution/service";
import { parseStrictJson } from "../strict-json";
import { brokerUrl } from "./broker";
import { createCredentialProtection } from "./credential-protection";
import type {
  CredentialHeaderBudget,
  ProviderAdapter,
  ProviderBeforeRequest,
  ScopeCoverage,
  StoredCredential,
  VerifiedCredential,
} from "./provider";
import { type HttpTransportInput, TransportError } from "./transport";

export interface AccountOwner {
  orgId: string;
  userId: string;
}
interface AccountRow {
  id: string;
  org_id: string;
  owner_user_id: string | null;
  ownership: "user" | "workspace";
  provider: string;
  method: AccountView["method"];
  identity_json: string;
  identity_digest: string;
  scopes_json: string;
  alias: string;
  enabled: number;
  health: AccountView["health"];
  expires_at: number | null;
  credential_version: number;
  created_at: number;
  updated_at: number;
  cipher: string | null;
  refresh_unusable: number | null;
  refresh_lease_id: string | null;
  refresh_lease_until: number | null;
}
export interface AccountSelectionContext {
  orgId: string;
  principalId: string | null;
  requirements: Record<string, Requirement>;
  selections: Record<string, SelectedAccount>;
}
export interface AccountBindingContext {
  orgId: string;
  principalId: string | null;
  requirements: Record<string, Requirement>;
  bindings: Record<string, string>;
  integrationSlug: string;
}
export interface AccountAuthorization {
  orgId: string;
  principalId: string | null;
  requirement: Requirement;
  selection: SelectedAccount;
  url: string;
  headers: Headers;
  beforeCredentialUse?: (budget: CredentialHeaderBudget) => Promise<void>;
  beforeProviderRequest?: ProviderBeforeRequest;
}
export interface OAuthReconnect {
  view: AccountView;
  credentialVersion: number;
}
export interface AccountsService {
  createAccount(owner: AccountOwner, input: unknown): Promise<AccountView>;
  listAccounts(owner: AccountOwner): Promise<{ accounts: AccountView[] }>;
  getAccount(owner: AccountOwner, id: string): Promise<AccountView>;
  updateAccount(
    owner: AccountOwner,
    id: string,
    patch: unknown,
  ): Promise<AccountView>;
  resolveBindings(
    input: AccountBindingContext,
  ): Promise<Record<string, SelectedAccount>>;
  /** Immutable identity metadata for dedupe only; never a dispatch authorization. */
  resolveBoundIdentities(
    input: AccountBindingContext,
  ): Promise<Record<string, SelectedAccount>>;
  verifySelections(input: AccountSelectionContext): Promise<void>;
  validateRequirement(requirement: Requirement): void;
  validateSecurityMapping(
    scheme: Record<string, unknown>,
    requirement: Requirement,
  ): void;
  authorize(
    input: AccountAuthorization,
  ): Promise<{ headers: Headers; redact(text: string): string }>;
  createOwnerTransport(
    owner: AccountOwner,
    accountId: string,
  ): Promise<{
    request(input: HttpTransportInput): Promise<Response>;
    redact(text: string): string;
  }>;
  describeRemoteAuthentication(
    owner: AccountOwner,
    accountId: string | undefined,
    endpoint: string,
  ): Promise<{ requirement: "remote"; definition: Requirement } | null>;
  /** Trusted OAuth service only; never expose this mutation to guest/config routes. */
  activateOAuth(
    owner: AccountOwner,
    input: {
      provider: string;
      alias: string;
      ownership: "user" | "workspace";
      accountId?: string;
      expectedVersion?: number;
      verified: VerifiedCredential;
    },
  ): Promise<AccountView>;
  oauthReconnect(owner: AccountOwner, id: string): Promise<OAuthReconnect>;
  cleanup(): Promise<void>;
}
const ACCOUNT_SQL =
  "SELECT a.*, c.cipher, c.refresh_unusable, c.refresh_lease_id, c.refresh_lease_until FROM control_accounts a LEFT JOIN control_credentials c ON c.account_id=a.id AND c.org_id=a.org_id";
const SQL_NOW = "cast((julianday('now') - 2440587.5)*86400000 as integer)";
const codes = {
  account_missing: "Select a fixed eligible Account for this requirement.",
  account_disabled: "Enable or explicitly repair the fixed Account.",
  account_incompatible:
    "The fixed Account is incompatible with this requirement.",
  account_scope_required:
    "Reconnect the fixed Account with the required verified permissions.",
  account_identity_changed:
    "The fixed Account identity changed. Explicitly review a different binding.",
  account_expired: "Reconnect or refresh the fixed Account.",
  account_revoked: "Reconnect the revoked Account.",
  credential_unavailable: "Reconnect or rotate the fixed Account credential.",
} as const;
function accountError(code: keyof typeof codes): never {
  throw new ControlError(code, codes[code], 409);
}
export async function accountIdentityDigest(input: {
  provider: string;
  ownership: "user" | "workspace";
  ownerUserId: string | null;
  method: string;
  identity: AccountIdentity;
}): Promise<string> {
  return sha256(
    canonicalJson({
      provider: input.provider,
      ownership: input.ownership,
      owner_user_id: input.ownerUserId,
      method: input.method,
      subject: input.identity.subject,
      issuer: input.identity.issuer ?? null,
      audience: input.identity.audience ?? null,
      tenant: input.identity.tenant ?? null,
      application: input.identity.application ?? null,
    }),
  );
}
export function assertAccountIdentityCompatibility(
  view: AccountView,
  requirement: Requirement,
  principalId: string | null,
): void {
  if (
    view.ownership === "user" &&
    (principalId === null || view.ownerUserId !== principalId)
  )
    accountError("account_incompatible");
  if (
    view.provider !== requirement.provider ||
    !requirement.methods.includes(view.method)
  )
    accountError("account_incompatible");
  if (
    (["issuer", "audience", "tenant", "application"] as const).some(
      (key) =>
        requirement[key] !== undefined &&
        requirement[key] !== view.identity[key],
    )
  )
    accountError("account_incompatible");
}
/** Pure current-restriction check used by both admission and dispatch; no fallback. */
export function assertAccountCompatibility(
  view: AccountView,
  requirement: Requirement,
  principalId: string | null,
  now: number,
  coversScopes: ScopeCoverage,
  allowRefresh = false,
): void {
  if (!view.enabled) accountError("account_disabled");
  assertAccountIdentityCompatibility(view, requirement, principalId);
  if (!coversScopes(view.scopes, requirement.scopes))
    accountError("account_scope_required");
  if (view.health === "revoked") accountError("account_revoked");
  if (view.health === "error" || view.health === "unverified")
    accountError("credential_unavailable");
  if (
    (view.health === "expired" ||
      (view.expiresAt !== null && Date.parse(view.expiresAt) <= now)) &&
    !allowRefresh
  )
    accountError("account_expired");
}
export function createAccountsService(options: {
  db: Database;
  secret: string;
  providers: readonly ProviderAdapter[];
  now?: () => number;
}): AccountsService {
  const client = options.db.$client,
    now = options.now ?? Date.now,
    protection = createCredentialProtection(options.secret);
  const providers: Record<string, ProviderAdapter> = Object.create(null);
  for (const provider of options.providers) {
    if (providers[provider.provider])
      throw new Error("Duplicate trusted Provider");
    providers[provider.provider] = provider;
  }
  function providerFor(name: string): ProviderAdapter {
    const provider = providers[name];
    if (!provider) accountError("account_incompatible");
    return provider;
  }
  function view(row: AccountRow): AccountView {
    return AccountView.parse({
      accountId: row.id,
      provider: row.provider,
      alias: row.alias,
      ownership: row.ownership,
      ownerUserId: row.owner_user_id,
      method: row.method,
      identity: JSON.parse(row.identity_json),
      scopes: JSON.parse(row.scopes_json),
      enabled: row.enabled === 1,
      health:
        row.health === "healthy" &&
        row.expires_at !== null &&
        row.expires_at <= now()
          ? "expired"
          : row.health,
      expiresAt:
        row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    });
  }
  async function load(orgId: string, id: string): Promise<AccountRow> {
    const result = await client
      .prepare(`${ACCOUNT_SQL} WHERE a.org_id=? AND a.id=?`)
      .bind(orgId, id)
      .first<AccountRow>();
    if (!result) accountError("account_missing");
    return result;
  }
  async function owned(owner: AccountOwner, id: string): Promise<AccountRow> {
    const row = await client
      .prepare(
        `${ACCOUNT_SQL} WHERE a.org_id=? AND a.id=? AND (a.ownership='workspace' OR a.owner_user_id=?)`,
      )
      .bind(owner.orgId, id, owner.userId)
      .first<AccountRow>();
    if (!row)
      throw new ControlError(
        "not_found",
        "The requested resource was not found.",
        404,
      );
    return row;
  }
  async function assertCurrentPrincipal(row: AccountRow): Promise<void> {
    if (
      row.ownership === "user" &&
      !(await client
        .prepare(
          "SELECT 1 AS eligible FROM users u JOIN members m ON m.user_id=u.id WHERE u.id=? AND m.organization_id=? LIMIT 1",
        )
        .bind(row.owner_user_id, row.org_id)
        .first())
    )
      accountError("account_incompatible");
  }
  async function compatible(
    row: AccountRow,
    requirement: Requirement,
    principalId: string | null,
    identityDigest?: string,
  ) {
    const provider = providerFor(row.provider);
    provider.validateRequirement(requirement);
    if (identityDigest !== undefined && identityDigest !== row.identity_digest)
      accountError("account_identity_changed");
    const allowRefresh =
      row.method === "oauth2" &&
      row.health === "healthy" &&
      Boolean(row.cipher) &&
      row.refresh_unusable === 0;
    assertAccountCompatibility(
      view(row),
      requirement,
      principalId,
      now(),
      provider.coversScopes,
      allowRefresh,
    );
    await assertCurrentPrincipal(row);
  }
  async function create(
    owner: AccountOwner,
    input: {
      provider: string;
      alias: string;
      ownership: "user" | "workspace";
      method: AccountView["method"];
      verified: VerifiedCredential;
    },
  ) {
    const id = crypto.randomUUID(),
      createdAt = now(),
      ownerUserId = input.ownership === "user" ? owner.userId : null;
    const digest = await accountIdentityDigest({
      ...input,
      ownerUserId,
      identity: input.verified.identity,
    });
    const cipher = await protection.encrypt(
      owner.orgId,
      id,
      1,
      "credential",
      input.verified.stored,
    );
    await client.batch([
      client
        .prepare(
          "INSERT INTO control_accounts(id,org_id,owner_user_id,ownership,provider,method,identity_json,identity_digest,scopes_json,alias,enabled,health,expires_at,credential_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,'healthy',?,1,?,?)",
        )
        .bind(
          id,
          owner.orgId,
          ownerUserId,
          input.ownership,
          input.provider,
          input.method,
          canonicalJson(input.verified.identity),
          digest,
          canonicalJson(input.verified.scopes),
          input.alias,
          input.verified.expiresAt,
          createdAt,
          createdAt,
        ),
      client
        .prepare(
          "INSERT INTO control_credentials(account_id,org_id,version,cipher,refresh_unusable) VALUES(?,?,1,?,?)",
        )
        .bind(
          id,
          owner.orgId,
          cipher,
          Number(
            input.method === "oauth2" && !input.verified.stored.refreshToken,
          ),
        ),
    ]);
    return view(await owned(owner, id));
  }
  async function replace(
    row: AccountRow,
    verified: VerifiedCredential,
    leaseId?: string,
    metadata?: { alias?: string; enabled?: boolean },
  ): Promise<void> {
    if (canonicalJson(verified.identity) !== row.identity_json)
      accountError("account_identity_changed");
    const version = row.credential_version + 1;
    const cipher = await protection.encrypt(
      row.org_id,
      row.id,
      version,
      "credential",
      verified.stored,
    );
    const lease = leaseId
      ? ` AND refresh_lease_id=? AND refresh_lease_until>${SQL_NOW}`
      : "";
    const values = [
      version,
      cipher,
      Number(row.method === "oauth2" && !verified.stored.refreshToken),
      row.id,
      row.org_id,
      row.credential_version,
      ...(leaseId ? [leaseId] : []),
    ];
    const results = await client.batch([
      client
        .prepare(
          `UPDATE control_credentials SET version=?,cipher=?,refresh_lease_id=NULL,refresh_lease_until=NULL,refresh_unusable=? WHERE account_id=? AND org_id=? AND version=?${lease} RETURNING account_id`,
        )
        .bind(...values),
      client
        .prepare(
          "UPDATE control_accounts SET scopes_json=?,expires_at=?,health='healthy',alias=coalesce(?,alias),enabled=coalesce(?,enabled),updated_at=? WHERE id=? AND org_id=? AND credential_version=? AND EXISTS(SELECT 1 FROM control_credentials c WHERE c.account_id=control_accounts.id AND c.version=? AND c.cipher=?)",
        )
        .bind(
          canonicalJson(verified.scopes),
          verified.expiresAt,
          metadata?.alias ?? null,
          metadata?.enabled === undefined ? null : Number(metadata.enabled),
          now(),
          row.id,
          row.org_id,
          version,
          version,
          cipher,
        ),
    ]);
    if (!results[0]?.results.length) accountError("credential_unavailable");
  }
  async function credential(
    row: AccountRow,
    beforeRequest?: ProviderBeforeRequest,
  ): Promise<{ row: AccountRow; stored: StoredCredential }> {
    if (!row.cipher) accountError("credential_unavailable");
    let stored = await protection.decrypt<StoredCredential>(
      row.org_id,
      row.id,
      row.credential_version,
      "credential",
      row.cipher,
    );
    if (row.expires_at === null || row.expires_at > now())
      return { row, stored };
    if (
      row.method !== "oauth2" ||
      row.refresh_unusable ||
      !stored.refreshToken ||
      !stored.refreshExpiresAt ||
      stored.refreshExpiresAt <= now()
    )
      accountError("account_expired");
    const leaseId = crypto.randomUUID();
    // An abandoned lease may already have rotated a token remotely. Never take
    // over that same rotating secret: mark refresh unusable and require consent.
    await client.batch([
      client
        .prepare(
          `UPDATE control_credentials SET refresh_unusable=1,refresh_lease_id=NULL,refresh_lease_until=NULL WHERE account_id=? AND org_id=? AND version=? AND refresh_lease_until<=${SQL_NOW}`,
        )
        .bind(row.id, row.org_id, row.credential_version),
      client
        .prepare(
          "UPDATE control_accounts SET health='expired',updated_at=? WHERE id=? AND org_id=? AND credential_version=? AND EXISTS(SELECT 1 FROM control_credentials c WHERE c.account_id=control_accounts.id AND c.version=? AND c.refresh_unusable=1)",
        )
        .bind(
          now(),
          row.id,
          row.org_id,
          row.credential_version,
          row.credential_version,
        ),
    ]);
    const leased = await client
      .prepare(
        `UPDATE control_credentials SET refresh_lease_id=?,refresh_lease_until=${SQL_NOW}+45000 WHERE account_id=? AND org_id=? AND version=? AND refresh_unusable=0 AND refresh_lease_id IS NULL RETURNING account_id`,
      )
      .bind(leaseId, row.id, row.org_id, row.credential_version)
      .first();
    if (!leased) accountError("credential_unavailable");
    try {
      const checkLease = async () => {
        const current = await load(row.org_id, row.id);
        if (!current.enabled) accountError("account_disabled");
        if (current.health === "revoked") accountError("account_revoked");
        if (
          current.health === "error" ||
          current.credential_version !== row.credential_version ||
          current.refresh_lease_id !== leaseId ||
          current.refresh_lease_until === null ||
          current.refresh_lease_until <= now()
        )
          accountError("credential_unavailable");
        await assertCurrentPrincipal(current);
      };
      const verified = await providerFor(row.provider).refresh({
        stored,
        expectedIdentity: JSON.parse(row.identity_json) as AccountIdentity,
        expectedScopes: JSON.parse(row.scopes_json) as string[],
        beforeRequest: async (attempt) => {
          await checkLease();
          await beforeRequest?.(attempt);
          await checkLease();
        },
      });
      await replace(row, verified, leaseId);
      row = await load(row.org_id, row.id);
      if (!row.cipher) accountError("credential_unavailable");
      stored = await protection.decrypt<StoredCredential>(
        row.org_id,
        row.id,
        row.credential_version,
        "credential",
        row.cipher,
      );
      return { row, stored };
    } catch (error) {
      if (
        (error instanceof TransportError ||
          (error instanceof ControlError && "mayHaveDispatched" in error)) &&
        error.mayHaveDispatched === false
      ) {
        // Positive no-send evidence permits reusing the still-unrotated secret.
        await client
          .prepare(
            "UPDATE control_credentials SET refresh_lease_id=NULL,refresh_lease_until=NULL WHERE account_id=? AND org_id=? AND version=? AND refresh_lease_id=?",
          )
          .bind(row.id, row.org_id, row.credential_version, leaseId)
          .run();
        throw error;
      }
      await client.batch([
        client
          .prepare(
            "UPDATE control_credentials SET refresh_unusable=1,refresh_lease_id=NULL,refresh_lease_until=NULL WHERE account_id=? AND org_id=? AND version=? AND refresh_lease_id=?",
          )
          .bind(row.id, row.org_id, row.credential_version, leaseId),
        client
          .prepare(
            "UPDATE control_accounts SET health=?,updated_at=? WHERE id=? AND org_id=? AND credential_version=? AND EXISTS(SELECT 1 FROM control_credentials c WHERE c.account_id=control_accounts.id AND c.version=? AND c.refresh_unusable=1)",
          )
          .bind(
            error instanceof ControlError && error.code === "account_revoked"
              ? "revoked"
              : "expired",
            now(),
            row.id,
            row.org_id,
            row.credential_version,
            row.credential_version,
          ),
      ]);
      if (error instanceof ControlError || error instanceof TransportError)
        throw error;
      accountError("credential_unavailable");
    }
  }
  const service: AccountsService = {
    validateRequirement(requirement) {
      providerFor(requirement.provider).validateRequirement(requirement);
    },
    validateSecurityMapping(scheme, requirement) {
      providerFor(requirement.provider).validateSecurityScheme(
        scheme,
        requirement,
      );
    },
    async cleanup() {
      await client
        .prepare(
          `UPDATE control_accounts SET health='expired',updated_at=${SQL_NOW} WHERE health='healthy' AND expires_at<=${SQL_NOW} AND (method!='oauth2' OR EXISTS(SELECT 1 FROM control_credentials c WHERE c.account_id=control_accounts.id AND c.refresh_unusable=1))`,
        )
        .run();
    },
    async createAccount(owner, raw) {
      const parsed = CreateAccountInput.safeParse(raw);
      if (!parsed.success)
        throw new ControlError(
          "invalid_request",
          "The Account configuration is invalid.",
          400,
        );
      const input = parsed.data,
        provider = providerFor(input.provider);
      if (!provider.methods.includes(input.method))
        accountError("account_incompatible");
      const verified = await provider.verify({
        method: input.method,
        credential: input.credential,
        expectedIdentity: input.identity,
      });
      if (!provider.coversScopes(verified.scopes, input.scopes))
        accountError("account_scope_required");
      return create(owner, { ...input, verified });
    },
    async listAccounts(owner) {
      const rows = await client
        .prepare(
          `${ACCOUNT_SQL} WHERE a.org_id=? AND (a.ownership='workspace' OR a.owner_user_id=?) ORDER BY a.created_at,a.id`,
        )
        .bind(owner.orgId, owner.userId)
        .all<AccountRow>();
      return { accounts: rows.results.map(view) };
    },
    async getAccount(owner, id) {
      return view(await owned(owner, id));
    },
    async updateAccount(owner, id, raw) {
      const parsed = PatchAccountInput.safeParse(raw);
      if (!parsed.success)
        throw new ControlError(
          "invalid_request",
          "The Account update is invalid.",
          400,
        );
      const patch = parsed.data,
        row = await owned(owner, id);
      if (patch.credential) {
        const verified = await providerFor(row.provider).verify({
          method: row.method,
          credential: patch.credential,
          expectedIdentity: JSON.parse(row.identity_json),
        });
        await replace(row, verified, undefined, patch);
      } else {
        await client
          .prepare(
            "UPDATE control_accounts SET alias=coalesce(?,alias),enabled=coalesce(?,enabled),updated_at=? WHERE id=? AND org_id=?",
          )
          .bind(
            patch.alias ?? null,
            patch.enabled === undefined ? null : Number(patch.enabled),
            now(),
            id,
            owner.orgId,
          )
          .run();
      }
      return view(await owned(owner, id));
    },
    async resolveBindings(input) {
      const selections = await service.resolveBoundIdentities(input);
      await service.verifySelections({
        orgId: input.orgId,
        principalId: input.principalId,
        requirements: input.requirements,
        selections,
      });
      return selections;
    },
    async resolveBoundIdentities(input) {
      const selections: Record<string, SelectedAccount> = Object.create(null);
      if (Object.keys(input.requirements).length > 8)
        accountError("account_incompatible");
      for (const [requirement, definition] of Object.entries(
        input.requirements,
      )) {
        const id = input.bindings[`${input.integrationSlug}.${requirement}`];
        if (!id) accountError("account_missing");
        const row = await load(input.orgId, id);
        providerFor(row.provider).validateRequirement(definition);
        assertAccountIdentityCompatibility(
          view(row),
          definition,
          input.principalId,
        );
        selections[requirement] = {
          accountId: row.id,
          identityDigest: row.identity_digest,
          alias: row.alias,
          requirement,
        };
      }
      return selections;
    },
    async verifySelections(input) {
      if (
        Object.keys(input.selections).length !==
        Object.keys(input.requirements).length
      )
        accountError("account_missing");
      for (const [requirement, definition] of Object.entries(
        input.requirements,
      )) {
        const selection = input.selections[requirement];
        if (!selection || selection.requirement !== requirement)
          accountError("account_missing");
        await compatible(
          await load(input.orgId, selection.accountId),
          definition,
          input.principalId,
          selection.identityDigest,
        );
      }
    },
    async authorize(input) {
      let row = await load(input.orgId, input.selection.accountId);
      await compatible(
        row,
        input.requirement,
        input.principalId,
        input.selection.identityDigest,
      );
      const provider = providerFor(row.provider),
        url = brokerUrl(input.url);
      if (!provider.acceptsDestination(url))
        throw new ControlError(
          "broker_forbidden",
          "This Provider credential cannot be sent to the requested destination.",
          403,
        );
      const active = await credential(row, input.beforeProviderRequest);
      const budget = provider.injectionSize(active.stored, input.headers);
      if (budget.totalBytes > 16384 || budget.maxValueBytes > 8192)
        throw new ControlError(
          "payload_too_large",
          "The credential-bearing request headers exceed their limit.",
          413,
        );
      await input.beforeCredentialUse?.(budget);
      // Re-read after the durable claim/epoch/budget callback. Rotation and
      // disable cannot activate a stale ciphertext captured before the fence.
      row = await load(input.orgId, row.id);
      await compatible(
        row,
        input.requirement,
        input.principalId,
        input.selection.identityDigest,
      );
      if (row.credential_version !== active.row.credential_version)
        accountError("credential_unavailable");
      if (row.expires_at !== null && row.expires_at <= now())
        accountError("account_expired");
      const headers = new Headers(input.headers);
      provider.inject(active.stored, headers);
      const secrets =
        active.stored.credential.kind === "bearer"
          ? [active.stored.credential.token]
          : active.stored.credential.kind === "api_key"
            ? [active.stored.credential.value]
            : [
                active.stored.credential.username,
                active.stored.credential.password,
                btoa(
                  `${active.stored.credential.username}:${active.stored.credential.password}`,
                ),
              ];
      if (active.stored.refreshToken) secrets.push(active.stored.refreshToken);
      if (provider.oauth)
        secrets.push(
          provider.oauth.clientSecret,
          btoa(`${provider.oauth.clientId}:${provider.oauth.clientSecret}`),
        );
      return {
        headers,
        redact(text) {
          for (const secret of secrets)
            if (secret) text = text.split(secret).join("[redacted]");
          return text;
        },
      };
    },
    async oauthReconnect(owner, id) {
      const row = await owned(owner, id);
      if (row.method !== "oauth2") accountError("account_incompatible");
      return { view: view(row), credentialVersion: row.credential_version };
    },
    async activateOAuth(owner, input) {
      providerFor(input.provider);
      if (!input.accountId)
        return create(owner, { ...input, method: "oauth2" });
      const row = await owned(owner, input.accountId);
      if (
        row.method !== "oauth2" ||
        row.provider !== input.provider ||
        row.ownership !== input.ownership ||
        row.credential_version !== input.expectedVersion
      )
        accountError("account_incompatible");
      await replace(row, input.verified);
      return view(await owned(owner, row.id));
    },
    async describeRemoteAuthentication(owner, accountId, endpoint) {
      if (!accountId) return null;
      const row = await owned(owner, accountId),
        provider = providerFor(row.provider);
      const url = brokerUrl(endpoint);
      if (!provider.acceptsRemoteEndpoint(url))
        throw new ControlError(
          "broker_forbidden",
          "The Provider does not support credentials at this MCP endpoint.",
          403,
        );
      const identity = JSON.parse(row.identity_json) as AccountIdentity;
      const definition: Requirement = {
        provider: row.provider,
        methods: [row.method],
        scopes: [],
        ...(identity.issuer === undefined ? {} : { issuer: identity.issuer }),
        ...(identity.audience === undefined
          ? {}
          : { audience: identity.audience }),
        ...(identity.tenant === undefined ? {} : { tenant: identity.tenant }),
        ...(identity.application === undefined
          ? {}
          : { application: identity.application }),
      };
      await compatible(row, definition, owner.userId);
      return { requirement: "remote", definition };
    },
    async createOwnerTransport(owner, accountId) {
      const row = await owned(owner, accountId),
        provider = providerFor(row.provider);
      const redactors: ((text: string) => string)[] = [];
      return {
        async request(input) {
          const url = brokerUrl(input.url);
          // Discovery capability is deliberately not a general business transport.
          if (
            !provider.acceptsRemoteEndpoint(url) ||
            !["POST", "DELETE"].includes(input.method) ||
            input.maxResponseBytes < 0 ||
            // MCP's 1 MiB JSON payload plus bounded SSE framing overhead.
            input.maxResponseBytes > 1048576 + 65536 ||
            (input.body?.byteLength ?? 0) > 1048576
          )
            throw new ControlError(
              "broker_forbidden",
              "Only trusted MCP discovery traffic is permitted by this capability.",
              403,
            );
          const permittedHeaders = [
            "accept",
            "content-type",
            "accept-encoding",
            "mcp-session-id",
            "mcp-protocol-version",
            "last-event-id",
          ];
          for (const [name, value] of input.headers)
            if (
              !permittedHeaders.includes(name) ||
              (name === "accept-encoding" && value !== "identity") ||
              hasCodeUnitInRange(value, 0, 31) ||
              value.includes("\x7f") ||
              value.length > 8192
            )
              throw new ControlError(
                "broker_forbidden",
                "The discovery headers are not permitted.",
                403,
              );
          if (input.method === "POST") {
            let message: unknown;
            try {
              message = parseStrictJson(
                new TextDecoder("utf-8", { fatal: true }).decode(input.body),
              );
            } catch {
              throw new ControlError(
                "invalid_request",
                "The discovery protocol request is invalid.",
                400,
              );
            }
            if (
              jsonProblem(message) ||
              !message ||
              typeof message !== "object" ||
              Array.isArray(message)
            )
              throw new ControlError(
                "invalid_request",
                "The discovery protocol request is invalid.",
                400,
              );
            const rpc = message as Record<string, unknown>;
            const method = rpc.method;
            if (
              method !== undefined
                ? ![
                    "initialize",
                    "tools/list",
                    "notifications/initialized",
                    "notifications/cancelled",
                  ].includes(String(method))
                : !Object.hasOwn(rpc, "id") || !Object.hasOwn(rpc, "error")
            )
              throw new ControlError(
                "broker_forbidden",
                "Business dispatch is unavailable through the discovery capability.",
                403,
              );
          } else if (input.body !== undefined)
            throw new ControlError(
              "broker_forbidden",
              "Discovery session cleanup cannot have a body.",
              403,
            );
          const identity = JSON.parse(row.identity_json) as AccountIdentity;
          const requirement: Requirement = {
            provider: row.provider,
            methods: [row.method],
            scopes: [],
            issuer: identity.issuer,
            audience: identity.audience,
            application: identity.application,
          };
          const authorized = await service.authorize({
            orgId: owner.orgId,
            principalId: owner.userId,
            requirement,
            selection: {
              accountId,
              identityDigest: row.identity_digest,
              alias: row.alias,
              requirement: "remote",
            },
            url: input.url,
            headers: input.headers,
          });
          redactors.push(authorized.redact);
          const session = input.headers.get("mcp-session-id");
          if (session)
            redactors.push((text) => text.split(session).join("[redacted]"));
          return provider.transport.request({
            ...input,
            headers: authorized.headers,
          });
        },
        redact(text) {
          for (const redact of redactors) text = redact(text);
          return text;
        },
      };
    },
  };
  return service;
}
