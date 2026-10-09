import type { Database } from "@scaffold/database";
import type { ExecutionErrorCode } from "@scaffold/schema/execution";
import {
  hasCodeUnitInRange,
  jsonProblem,
  type OAuthScopeImpact,
  OAuthStartInput,
  OAuthStartResult,
} from "@scaffold/schema/integrations";
import { sha256 } from "../execution/canonical";
import { ControlError } from "../execution/service";
import type { AccountOwner, AccountsService, OAuthReconnect } from "./accounts";
import { createCredentialProtection } from "./credential-protection";
import type { ProviderAdapter, ScopeCoverage } from "./provider";

export interface OAuthOwner extends AccountOwner {
  sessionId: string;
}
export interface OAuthImpactPreview {
  accountId: string | null;
  provider: string;
  currentScopes: string[];
  requestedScopes: string[];
  review?: OAuthStartInput["review"];
  coversScopes: ScopeCoverage;
}
export type OAuthImpactPreviewer = (
  owner: AccountOwner,
  input: OAuthImpactPreview,
) => Promise<Pick<OAuthScopeImpact, "published" | "proposed">>;
interface OAuthIntent {
  verifier: string;
  provider: string;
  alias: string;
  ownership: "user" | "workspace";
  accountId?: string;
  expectedVersion?: number;
  expectedIdentityDigest?: string;
  scopes: string[];
  returnPath: string;
  callbackUrl: string;
  registrationId: string;
}
interface OAuthStateRow {
  state_digest: string;
  org_id: string;
  user_id: string;
  session_digest: string;
  provider: string;
  registration_id: string;
  intent_cipher: string;
  expires_at: number;
  consumed_at: number | null;
}
export interface OAuthService {
  startOAuth(owner: OAuthOwner, input: unknown): Promise<OAuthStartResult>;
  callback(
    owner: OAuthOwner,
    input: { code?: string; state?: string; error?: string },
    callbackUrl: string,
  ): Promise<{ returnPath: string; error?: ExecutionErrorCode }>;
  cleanup(): Promise<void>;
}
const SQL_NOW = "cast((julianday('now') - 2440587.5)*86400000 as integer)";
const OWNER_SESSION_SQL = `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id JOIN members m ON m.user_id=u.id WHERE s.id=? AND s.user_id=? AND s.active_organization_id=? AND s.expires_at>${SQL_NOW} AND m.organization_id=s.active_organization_id AND m.role='owner')`;
const SAFE_FAILURE = "/api/control/accounts?oauth_error=oauth_state_invalid";
export function safeOAuthReturnPath(input: string): string {
  if (
    !input.startsWith("/api/control/") ||
    input.includes("\\") ||
    hasCodeUnitInRange(input, 0, 32) ||
    input.includes("\x7f") ||
    input.includes("#") ||
    /%(?:2f|5c|00|2e)/i.test(input) ||
    /%(?![a-f0-9]{2})/i.test(input)
  )
    throw new ControlError(
      "invalid_request",
      "Use a relative control-plane return path.",
      400,
    );
  const url = new URL(input, "https://control.invalid");
  if (
    url.origin !== "https://control.invalid" ||
    url.pathname !== input.split("?")[0] ||
    [...url.searchParams.keys()].some((key) =>
      /^(?:code|state|token|access_token|refresh_token|client_secret)$/i.test(
        key,
      ),
    )
  )
    throw new ControlError(
      "invalid_request",
      "Use a relative control-plane return path.",
      400,
    );
  return input;
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function createOAuthService(options: {
  db: Database;
  secret: string;
  accounts: AccountsService;
  providers: readonly ProviderAdapter[];
  previewImpact: OAuthImpactPreviewer;
  now?: () => number;
}): OAuthService {
  const client = options.db.$client,
    protection = createCredentialProtection(options.secret),
    now = options.now ?? Date.now;
  const providers: Record<string, ProviderAdapter> = Object.create(null);
  for (const provider of options.providers)
    providers[provider.provider] = provider;
  function providerFor(name: string): ProviderAdapter {
    const provider = providers[name];
    if (!provider?.oauth || !provider.registrationId)
      throw new ControlError(
        "oauth_unavailable",
        "Configure a native Provider registration for this deployment and exact callback.",
        503,
      );
    return provider;
  }
  async function assertOwnerSession(owner: OAuthOwner): Promise<void> {
    if (
      !(await client
        .prepare(`SELECT 1 AS authorized WHERE ${OWNER_SESSION_SQL}`)
        .bind(owner.sessionId, owner.userId, owner.orgId)
        .first())
    )
      throw new ControlError(
        "oauth_state_invalid",
        "Restart the connection flow from a current owner session.",
        400,
      );
  }
  return {
    async startOAuth(owner, raw) {
      if (!owner.orgId || !owner.userId || !owner.sessionId)
        throw new ControlError(
          "unauthenticated",
          "An active owner session is required.",
          401,
        );
      const parsed = OAuthStartInput.safeParse(raw);
      if (!parsed.success)
        throw new ControlError(
          "invalid_request",
          "The OAuth connection intent is invalid.",
          400,
        );
      const input = parsed.data,
        provider = providerFor(input.provider);
      const returnPath = safeOAuthReturnPath(input.returnPath);
      await assertOwnerSession(owner);
      let reconnect: OAuthReconnect | undefined;
      if (input.accountId) {
        reconnect = await options.accounts.oauthReconnect(
          owner,
          input.accountId,
        );
        if (
          reconnect.view.provider !== input.provider ||
          reconnect.view.ownership !== input.ownership
        )
          throw new ControlError(
            "account_incompatible",
            "Reconnect must preserve Account Provider and ownership.",
            409,
          );
        if (reconnect.view.identity.application !== provider.oauth!.clientId)
          throw new ControlError(
            "account_identity_changed",
            "A different registered application requires a separate Account.",
            409,
          );
      }
      const currentScopes = (reconnect?.view.scopes ?? []).filter(
        (scope) => scope !== "offline_access",
      );
      const requestedScopes = [
        ...new Set([
          ...currentScopes,
          ...input.scopes.filter((scope) => scope !== "offline_access"),
        ]),
      ].sort();
      const scopes = [...requestedScopes, "offline_access"];
      const preview = await options.previewImpact(owner, {
        accountId: input.accountId ?? null,
        provider: input.provider,
        currentScopes,
        requestedScopes,
        review: input.review,
        coversScopes: provider.coversScopes,
      });
      const state = base64url(crypto.getRandomValues(new Uint8Array(32))),
        verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(verifier),
          ),
        ),
      );
      const authorizationUrl = provider.authorizationUrl({
        state,
        challenge,
        scopes,
      });
      const digest = await sha256(state),
        expiresAt = now() + 600000;
      const candidate = {
        authorizationUrl,
        expiresAt: new Date(expiresAt).toISOString(),
        impact: {
          accountId: input.accountId ?? null,
          currentScopes,
          requestedScopes,
          published: preview.published,
          ...(preview.proposed ? { proposed: preview.proposed } : {}),
        },
      };
      if (jsonProblem(candidate))
        throw new ControlError(
          "payload_too_large",
          "The OAuth scope-impact response exceeds the supported JSON limit.",
          413,
        );
      const result = OAuthStartResult.safeParse(candidate);
      if (!result.success)
        throw new ControlError(
          "internal_error",
          "The OAuth scope-impact response is invalid.",
          500,
        );
      const intent: OAuthIntent = {
        verifier,
        provider: input.provider,
        alias: input.alias,
        ownership: input.ownership,
        scopes,
        returnPath,
        callbackUrl: provider.oauth!.callbackUrl,
        registrationId: provider.registrationId!,
        ...(reconnect
          ? {
              accountId: input.accountId,
              expectedVersion: reconnect.credentialVersion,
              expectedIdentityDigest: await sha256(
                JSON.stringify(reconnect.view.identity),
              ),
            }
          : {}),
      };
      const cipher = await protection.encrypt(
        owner.orgId,
        digest,
        1,
        "oauth_intent",
        intent,
      );
      await client
        .prepare(
          "INSERT INTO control_oauth_states(state_digest,org_id,user_id,session_digest,provider,registration_id,intent_cipher,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          digest,
          owner.orgId,
          owner.userId,
          await sha256(owner.sessionId),
          input.provider,
          provider.registrationId!,
          cipher,
          expiresAt,
          now(),
        )
        .run();
      return result.data;
    },
    async callback(owner, input, callbackUrl) {
      // No untrusted state/code/error string is ever interpolated into a response.
      if (
        !owner.orgId ||
        !owner.userId ||
        !owner.sessionId ||
        typeof input.state !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(input.state)
      )
        return { returnPath: SAFE_FAILURE, error: "oauth_state_invalid" };
      const digest = await sha256(input.state),
        sessionDigest = await sha256(owner.sessionId);
      const state = await client
        .prepare(
          `UPDATE control_oauth_states SET consumed_at=${SQL_NOW} WHERE state_digest=? AND org_id=? AND user_id=? AND session_digest=? AND consumed_at IS NULL AND expires_at>${SQL_NOW} AND ${OWNER_SESSION_SQL} RETURNING *`,
        )
        .bind(
          digest,
          owner.orgId,
          owner.userId,
          sessionDigest,
          owner.sessionId,
          owner.userId,
          owner.orgId,
        )
        .first<OAuthStateRow>();
      if (!state)
        return { returnPath: SAFE_FAILURE, error: "oauth_state_invalid" };
      let returnPath = "/api/control/accounts";
      try {
        const provider = providerFor(state.provider);
        const intent = await protection.decrypt<OAuthIntent>(
          owner.orgId,
          digest,
          1,
          "oauth_intent",
          state.intent_cipher,
        );
        returnPath = safeOAuthReturnPath(intent.returnPath);
        if (
          state.registration_id !== provider.registrationId ||
          intent.registrationId !== provider.registrationId ||
          intent.provider !== state.provider ||
          intent.callbackUrl !== provider.oauth!.callbackUrl ||
          callbackUrl !== provider.oauth!.callbackUrl ||
          state.expires_at <= now()
        )
          throw new ControlError(
            "oauth_state_invalid",
            "Restart the explicit connection flow.",
            400,
          );
        if (input.error !== undefined)
          throw new ControlError(
            "oauth_consent_denied",
            "Authorization consent was denied. Restart the connection flow.",
            400,
          );
        if (
          typeof input.code !== "string" ||
          input.code.length < 1 ||
          input.code.length > 65536 ||
          hasCodeUnitInRange(input.code, 0, 32) ||
          input.code.includes("\x7f")
        )
          throw new ControlError(
            "oauth_state_invalid",
            "Restart the explicit connection flow.",
            400,
          );
        if (intent.accountId) {
          const current = await options.accounts.oauthReconnect(
            owner,
            intent.accountId,
          );
          if (
            current.credentialVersion !== intent.expectedVersion ||
            (await sha256(JSON.stringify(current.view.identity))) !==
              intent.expectedIdentityDigest
          )
            throw new ControlError(
              "account_identity_changed",
              "The Account changed during consent. Restart the explicit connection flow.",
              409,
            );
        }
        const verified = await provider.exchange({
          code: input.code,
          verifier: intent.verifier,
          scopes: intent.scopes,
        });
        // offline_access requests refresh custody, never an invented API scope.
        if (
          !provider.coversScopes(
            verified.scopes,
            intent.scopes.filter((scope) => scope !== "offline_access"),
          )
        )
          throw new ControlError(
            "account_scope_required",
            "The Provider did not grant the required permissions.",
            409,
          );
        if (
          intent.scopes.includes("offline_access") &&
          !verified.stored.refreshToken
        )
          throw new ControlError(
            "credential_unavailable",
            "Reconnect with expiring user tokens enabled.",
            409,
          );
        await assertOwnerSession(owner);
        await options.accounts.activateOAuth(owner, { ...intent, verified });
        return { returnPath };
      } catch (error) {
        const allowed: ExecutionErrorCode[] = [
          "oauth_unavailable",
          "oauth_state_invalid",
          "oauth_consent_denied",
          "account_scope_required",
          "account_identity_changed",
          "account_incompatible",
          "account_revoked",
          "credential_unavailable",
        ];
        const code: ExecutionErrorCode =
          error instanceof ControlError && allowed.includes(error.code)
            ? error.code
            : "oauth_state_invalid";
        const url = new URL(returnPath, "https://control.invalid");
        url.searchParams.set("oauth_error", code);
        return { returnPath: url.pathname + url.search, error: code };
      } finally {
        // Remove the protected verifier/code intent after consuming it, retaining
        // only the one-use digest fence until the ordinary expiry cleanup.
        await client
          .prepare(
            "UPDATE control_oauth_states SET intent_cipher='' WHERE state_digest=? AND consumed_at IS NOT NULL",
          )
          .bind(digest)
          .run();
      }
    },
    async cleanup() {
      await client
        .prepare(
          `DELETE FROM control_oauth_states WHERE expires_at<=${SQL_NOW}`,
        )
        .run();
    },
  };
}
