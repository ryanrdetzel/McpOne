import {
  type AccountIdentity,
  type Credential,
  jsonProblem,
  type Requirement,
} from "@scaffold/schema/integrations";
import { canonicalJson } from "../../execution/canonical";
import { ControlError } from "../../execution/service";
import { parseStrictJson } from "../../strict-json";
import type {
  OAuthRegistration,
  ProviderAdapter,
  ProviderBeforeRequest,
  StoredCredential,
  VerifiedCredential,
} from "../provider";
import {
  type HttpTransport,
  readBoundedBody,
  TransportError,
} from "../transport";

const API = "https://api.github.com";
const ISSUER = "https://github.com";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const MCP_ORIGIN = "https://api.githubcopilot.com";
const encoder = new TextEncoder();
// Explicit documented inclusions only; preserve actual normalized grants unchanged.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
const SCOPE_INCLUSIONS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    user: ["read:user", "user:email", "user:follow"],
    repo: [
      "repo:status",
      "repo_deployment",
      "public_repo",
      "repo:invite",
      "security_events",
      "admin:repo_hook",
      "write:repo_hook",
      "read:repo_hook",
    ],
    "admin:repo_hook": ["write:repo_hook", "read:repo_hook"],
    "write:repo_hook": ["read:repo_hook"],
    "admin:org": ["write:org", "read:org"],
    "write:org": ["read:org"],
    "admin:public_key": ["write:public_key", "read:public_key"],
    "write:public_key": ["read:public_key"],
    "admin:gpg_key": ["write:gpg_key", "read:gpg_key"],
    "write:gpg_key": ["read:gpg_key"],
    project: ["read:project"],
  });
const RESOURCE_SCOPES: Readonly<Record<string, true>> = Object.freeze({
  repo: true,
  "repo:status": true,
  repo_deployment: true,
  public_repo: true,
  "repo:invite": true,
  security_events: true,
  "admin:repo_hook": true,
  "write:repo_hook": true,
  "read:repo_hook": true,
  "admin:org": true,
  "write:org": true,
  "read:org": true,
  "admin:public_key": true,
  "write:public_key": true,
  "read:public_key": true,
  "admin:org_hook": true,
  gist: true,
  notifications: true,
  user: true,
  "read:user": true,
  "user:email": true,
  "user:follow": true,
  project: true,
  "read:project": true,
  delete_repo: true,
  "write:packages": true,
  "read:packages": true,
  "delete:packages": true,
  "admin:gpg_key": true,
  "write:gpg_key": true,
  "read:gpg_key": true,
  codespace: true,
  workflow: true,
  "read:audit_log": true,
});
function coversScopes(
  granted: readonly string[],
  required: readonly string[],
): boolean {
  for (const scope of required) {
    let covered = false;
    for (const grant of granted)
      if (
        grant === scope ||
        (Object.hasOwn(SCOPE_INCLUSIONS, grant) &&
          SCOPE_INCLUSIONS[grant]!.includes(scope))
      ) {
        covered = true;
        break;
      }
    if (!covered) return false;
  }
  return true;
}
function actualScopes(scopes: string | unknown[]): string[] {
  const values =
    typeof scopes === "string"
      ? scopes
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean)
      : scopes;
  if (
    values.length > 256 ||
    values.some(
      (scope) =>
        typeof scope !== "string" || !/^[a-zA-Z0-9_:.-]{1,128}$/.test(scope),
    ) ||
    new Set(values).size !== values.length
  )
    rejected();
  return (values as string[])
    .filter((scope) => scope !== "offline_access")
    .sort();
}
function unavailable(): never {
  throw Object.assign(
    new ControlError(
      "oauth_unavailable",
      "Configure a registered GitHub OAuth App or GitHub App with expiring user tokens and the exact callback.",
      503,
    ),
    { mayHaveDispatched: false },
  );
}
function rejected(
  code:
    | "credential_unavailable"
    | "account_identity_changed"
    | "account_scope_required"
    | "account_revoked" = "credential_unavailable",
): never {
  throw new ControlError(
    code,
    code === "account_identity_changed"
      ? "The verified identity differs. Create a separate Account."
      : "Reconnect or rotate this Account with the required verified permissions.",
    409,
  );
}
function identityMatches(
  expected: AccountIdentity | undefined,
  actual: AccountIdentity,
): boolean {
  return (
    !expected ||
    (["subject", "issuer", "audience", "tenant", "application"] as const).every(
      (k) => expected[k] === undefined || expected[k] === actual[k],
    )
  );
}
/** Only native fixed GitHub endpoints are allowed; no caller-selected credential destination. */
export function createGithubProvider(options: {
  transport: HttpTransport;
  oauth?: OAuthRegistration;
  now?: () => number;
}): ProviderAdapter {
  const now = options.now ?? Date.now;
  const registration = options.oauth ? { ...options.oauth } : undefined;
  if (registration) {
    const keys = Object.keys(registration);
    if (
      keys.some(
        (k) =>
          ![
            "kind",
            "clientId",
            "clientSecret",
            "callbackUrl",
            "controlOrigin",
            "custody",
          ].includes(k),
      ) ||
      !["oauth_app", "github_app"].includes(registration.kind) ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(registration.clientId) ||
      !/^[\x21-\x7e]{1,4096}$/.test(registration.clientSecret) ||
      !["local", "hosted"].includes(registration.custody)
    )
      unavailable();
    let callback: URL, origin: URL;
    try {
      callback = new URL(registration.callbackUrl);
      origin = new URL(registration.controlOrigin);
    } catch {
      unavailable();
    }
    const local =
      registration.custody === "local" &&
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (
      (!local && origin.protocol !== "https:") ||
      origin.origin !== registration.controlOrigin ||
      origin.username ||
      origin.password ||
      callback.origin !== origin.origin ||
      callback.pathname !== "/api/control/accounts/oauth/callback" ||
      callback.search ||
      callback.hash ||
      callback.username ||
      callback.password ||
      callback.href !== registration.callbackUrl
    )
      unavailable();
    Object.freeze(registration);
  }
  // Public registration changes invalidate pending intents; secret rotation does not.
  const registrationId = registration
    ? canonicalJson({
        provider: "github",
        kind: registration.kind,
        clientId: registration.clientId,
        callbackUrl: registration.callbackUrl,
        custody: registration.custody,
      })
    : undefined;
  function assertStoredRegistration(stored: StoredCredential): void {
    if (
      stored.registrationId !== undefined &&
      (!registration || stored.registrationId !== registrationId)
    )
      unavailable();
  }
  async function jsonRequest(
    url: string,
    method: "GET" | "POST",
    headers: Headers,
    body?: Uint8Array,
    beforeRequest?: ProviderBeforeRequest,
  ): Promise<{ data: Record<string, unknown>; headers: Headers }> {
    const signal = AbortSignal.timeout(10000);
    try {
      await beforeRequest?.({ url, method, controlTraffic: true });
    } catch (error) {
      const failure =
        error instanceof ControlError
          ? error
          : new ControlError(
              "credential_unavailable",
              "The credential request is not currently permitted.",
              409,
            );
      throw Object.assign(failure, { mayHaveDispatched: false });
    }
    let response: Response;
    try {
      response = await options.transport.request({
        url,
        method,
        headers,
        body,
        signal,
        maxResponseBytes: 65536,
      });
    } catch (error) {
      if (error instanceof TransportError) throw error;
      rejected();
    }
    if (response.status === 401 || response.status === 404) {
      await response.body?.cancel();
      rejected("account_revoked");
    }
    if (
      !response.ok ||
      response.status >= 300 ||
      !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel();
      rejected();
    }
    let data: unknown;
    try {
      data = parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedBody(response.body, 65536, signal),
        ),
      );
    } catch {
      rejected();
    }
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      jsonProblem(data, 65536)
    )
      rejected();
    return { data: data as Record<string, unknown>, headers: response.headers };
  }
  function apiHeaders(token: string) {
    if (!/^[\x21-\x7e]{1,8185}$/.test(token)) rejected();
    return new Headers({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2026-03-10",
      "user-agent": "McpOne",
      "accept-encoding": "identity",
    });
  }
  async function verify(input: {
    method: string;
    credential?: Credential;
    expectedIdentity?: AccountIdentity;
    beforeRequest?: ProviderBeforeRequest;
  }): Promise<VerifiedCredential> {
    if (
      !["bearer", "oauth2"].includes(input.method) ||
      input.credential?.kind !== "bearer"
    )
      rejected();
    if (input.method === "oauth2" && !registration) unavailable();
    const token = input.credential.token;
    const result = await jsonRequest(
      `${API}/user`,
      "GET",
      apiHeaders(token),
      undefined,
      input.beforeRequest,
    );
    if (
      !Number.isSafeInteger(result.data.id) ||
      Number(result.data.id) <= 0 ||
      typeof result.data.login !== "string"
    )
      rejected();
    const identity: AccountIdentity = {
      subject: String(result.data.id),
      issuer: ISSUER,
      audience: API,
    };
    let scopes: string[] = [];
    let expiresAt: number | null = null;
    if (input.method === "oauth2") {
      if (!registration) unavailable();
      const basic = btoa(
        `${registration.clientId}:${registration.clientSecret}`,
      );
      const introspected = await jsonRequest(
        `${API}/applications/${encodeURIComponent(registration.clientId)}/token`,
        "POST",
        new Headers({
          accept: "application/vnd.github+json",
          authorization: `Basic ${basic}`,
          "content-type": "application/json",
          "user-agent": "McpOne",
          "accept-encoding": "identity",
        }),
        encoder.encode(JSON.stringify({ access_token: token })),
        input.beforeRequest,
      );
      const app = introspected.data.app as Record<string, unknown> | undefined;
      const user = introspected.data.user as
        | Record<string, unknown>
        | undefined;
      if (
        !app ||
        app.client_id !== registration.clientId ||
        !user ||
        user.id !== result.data.id ||
        !Array.isArray(introspected.data.scopes)
      )
        rejected("account_identity_changed");
      scopes = actualScopes(introspected.data.scopes);
      const header = result.headers.get("x-oauth-scopes");
      if (
        registration.kind === "github_app"
          ? scopes.length !== 0
          : header === null ||
            canonicalJson(actualScopes(header)) !== canonicalJson(scopes)
      )
        rejected("account_scope_required");
      identity.application = registration.clientId;
      if (
        introspected.data.expires_at !== null &&
        introspected.data.expires_at !== undefined
      ) {
        if (
          typeof introspected.data.expires_at !== "string" ||
          !Number.isFinite(Date.parse(introspected.data.expires_at))
        )
          rejected();
        expiresAt = Date.parse(introspected.data.expires_at);
      }
    } else {
      // X-OAuth-Scopes is authoritative for classic PAT/OAuth tokens. Absent
      // evidence proves no OAuth scopes, not asserted fine-grained permissions.
      const header = result.headers.get("x-oauth-scopes");
      if (header !== null) scopes = actualScopes(header);
      const expiration = result.headers.get(
        "github-authentication-token-expiration",
      );
      if (expiration) {
        expiresAt = Date.parse(expiration);
        if (!Number.isFinite(expiresAt)) rejected();
      }
    }
    if (!identityMatches(input.expectedIdentity, identity))
      rejected("account_identity_changed");
    return {
      identity,
      scopes,
      expiresAt,
      stored: {
        credential: { kind: "bearer", token },
        ...(registrationId && input.method === "oauth2"
          ? { registrationId }
          : {}),
      },
    };
  }
  async function tokenExchange(
    parameters: Record<string, string>,
    beforeRequest?: ProviderBeforeRequest,
  ): Promise<VerifiedCredential> {
    if (!registration) unavailable();
    const requestedAt = now();
    let tokenReturned = false;
    try {
      const response = await jsonRequest(
        TOKEN_URL,
        "POST",
        new Headers({
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "accept-encoding": "identity",
          "user-agent": "McpOne",
        }),
        encoder.encode(
          new URLSearchParams({
            client_id: registration.clientId,
            client_secret: registration.clientSecret,
            ...parameters,
          }).toString(),
        ),
        beforeRequest,
      );
      tokenReturned = true;
      if (response.data.error) {
        if (
          ["bad_refresh_token", "invalid_grant"].includes(
            String(response.data.error),
          )
        )
          rejected("account_revoked");
        if (response.data.error === "access_denied")
          throw new ControlError(
            "oauth_consent_denied",
            "Authorization consent was denied. Restart the connection flow.",
            400,
          );
        rejected();
      }
      const {
        access_token,
        token_type,
        scope,
        expires_in,
        refresh_token,
        refresh_token_expires_in,
      } = response.data;
      if (
        typeof access_token !== "string" ||
        !/^[\x21-\x7e]{1,8185}$/.test(access_token) ||
        token_type !== "bearer" ||
        typeof scope !== "string" ||
        !Number.isInteger(expires_in) ||
        Number(expires_in) <= 0 ||
        Number(expires_in) > 28800 ||
        typeof refresh_token !== "string" ||
        !/^[\x21-\x7e]{1,65536}$/.test(refresh_token) ||
        !Number.isInteger(refresh_token_expires_in) ||
        Number(refresh_token_expires_in) <= 0 ||
        Number(refresh_token_expires_in) > 15897600
      )
        rejected();
      const verified = await verify({
        method: "oauth2",
        credential: { kind: "bearer", token: access_token },
        beforeRequest,
      });
      const granted = actualScopes(scope);
      if (
        canonicalJson(granted) !== canonicalJson(verified.scopes) ||
        (registration.kind === "github_app" && granted.length !== 0)
      )
        rejected("account_scope_required");
      const expiresAt = requestedAt + Number(expires_in) * 1000;
      if (verified.expiresAt !== null && verified.expiresAt > expiresAt + 60000)
        rejected();
      return {
        ...verified,
        expiresAt:
          verified.expiresAt === null
            ? expiresAt
            : Math.min(expiresAt, verified.expiresAt),
        stored: {
          ...verified.stored,
          refreshToken: refresh_token,
          refreshExpiresAt:
            requestedAt + Number(refresh_token_expires_in) * 1000,
          registrationId,
        },
      };
    } catch (error) {
      // A later no-send failure cannot erase the earlier rotating-token POST.
      if (
        tokenReturned &&
        error instanceof TransportError &&
        !error.mayHaveDispatched
      )
        throw new TransportError(error.code, true);
      if (
        tokenReturned &&
        error instanceof ControlError &&
        "mayHaveDispatched" in error
      )
        Object.assign(error, { mayHaveDispatched: true });
      throw error;
    }
  }
  const adapter: ProviderAdapter = {
    provider: "github",
    methods: Object.freeze(["bearer", "oauth2"] as const),
    oauth: registration,
    registrationId,
    transport: options.transport,
    verify,
    coversScopes,
    acceptsDestination: (url) =>
      url.origin === API ||
      (url.origin === MCP_ORIGIN && /^\/mcp(?:\/|$)/.test(url.pathname)),
    acceptsRemoteEndpoint: (url) =>
      url.origin === MCP_ORIGIN &&
      ["/mcp", "/mcp/"].includes(url.pathname) &&
      !url.search,
    injectionSize(stored, headers) {
      assertStoredRegistration(stored);
      if (
        stored.credential.kind !== "bearer" ||
        headers.has("authorization") ||
        !/^[\x21-\x7e]{1,65536}$/.test(stored.credential.token)
      )
        throw new ControlError(
          "broker_forbidden",
          "Credential injection is not permitted for this request.",
          403,
        );
      const authorizationBytes = 7 + stored.credential.token.length;
      let totalBytes = "authorization".length + authorizationBytes + 4;
      let maxValueBytes = authorizationBytes;
      for (const [name, value] of headers) {
        const valueBytes = encoder.encode(value).length;
        totalBytes += encoder.encode(name).length + valueBytes + 4;
        maxValueBytes = Math.max(maxValueBytes, valueBytes);
      }
      if (!headers.has("user-agent")) {
        totalBytes += "user-agent: McpOne\r\n".length;
        maxValueBytes = Math.max(maxValueBytes, 6);
      }
      return { totalBytes, maxValueBytes };
    },
    inject(stored, headers) {
      assertStoredRegistration(stored);
      if (
        stored.credential.kind !== "bearer" ||
        headers.has("authorization") ||
        !/^[\x21-\x7e]{1,65536}$/.test(stored.credential.token)
      )
        throw new ControlError(
          "broker_forbidden",
          "Credential injection is not permitted for this request.",
          403,
        );
      headers.set("authorization", `Bearer ${stored.credential.token}`);
      if (!headers.has("user-agent")) headers.set("user-agent", "McpOne");
    },
    validateRequirement(requirement: Requirement) {
      if (
        requirement.provider !== "github" ||
        requirement.methods.length === 0 ||
        requirement.methods.some(
          (method) => !["bearer", "oauth2"].includes(method),
        ) ||
        (requirement.issuer !== undefined && requirement.issuer !== ISSUER) ||
        (requirement.audience !== undefined && requirement.audience !== API) ||
        requirement.tenant !== undefined
      )
        throw new ControlError(
          "account_incompatible",
          "This requirement is not supported by the trusted GitHub Provider.",
          409,
        );
    },
    validateSecurityScheme(scheme, requirement) {
      adapter.validateRequirement(requirement);
      if (
        scheme.type === "http" &&
        typeof scheme.scheme === "string" &&
        scheme.scheme.toLowerCase() === "bearer"
      )
        return;
      if (
        scheme.type === "oauth2" &&
        requirement.methods.every((method) => method === "oauth2") &&
        typeof scheme.flows === "object" &&
        scheme.flows !== null &&
        !Array.isArray(scheme.flows)
      ) {
        const flows = scheme.flows as Record<string, unknown>;
        const flow = flows.authorizationCode;
        if (
          Object.keys(flows).length === 1 &&
          typeof flow === "object" &&
          flow !== null &&
          !Array.isArray(flow)
        ) {
          const authorization = flow as Record<string, unknown>;
          const scopes = authorization.scopes;
          if (
            authorization.authorizationUrl ===
              "https://github.com/login/oauth/authorize" &&
            authorization.tokenUrl === TOKEN_URL &&
            (authorization.refreshUrl === undefined ||
              authorization.refreshUrl === TOKEN_URL) &&
            typeof scopes === "object" &&
            scopes !== null &&
            !Array.isArray(scopes) &&
            Object.keys(scopes).every(
              (scope) =>
                scope === "offline_access" ||
                (registration?.kind === "oauth_app" &&
                  Object.hasOwn(RESOURCE_SCOPES, scope)),
            ) &&
            Object.values(scopes).every(
              (description) => typeof description === "string",
            )
          )
            return;
        }
      }
      throw new ControlError(
        "unsupported_feature",
        "The security scheme does not match the trusted GitHub Provider's native wire semantics.",
        400,
      );
    },
    authorizationUrl({ state, challenge, scopes }) {
      if (!registration) unavailable();
      if (
        scopes.some(
          (scope) =>
            scope !== "offline_access" &&
            (registration.kind !== "oauth_app" ||
              !Object.hasOwn(RESOURCE_SCOPES, scope)),
        )
      )
        rejected("account_scope_required");
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: registration.clientId,
        redirect_uri: registration.callbackUrl,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: [
          ...new Set([
            ...scopes.filter((scope) => scope !== "offline_access"),
            "offline_access",
          ]),
        ]
          .sort()
          .join(" "),
        prompt: "select_account",
      }).toString();
      return url.href;
    },
    async exchange({ code, verifier, scopes, beforeRequest }) {
      if (!registration) unavailable();
      if (
        scopes.some(
          (scope) =>
            scope !== "offline_access" &&
            (registration.kind !== "oauth_app" ||
              !Object.hasOwn(RESOURCE_SCOPES, scope)),
        )
      )
        rejected("account_scope_required");
      return tokenExchange(
        {
          code,
          redirect_uri: registration.callbackUrl,
          code_verifier: verifier,
        },
        beforeRequest,
      );
    },
    async refresh({ stored, expectedIdentity, expectedScopes, beforeRequest }) {
      if (!registration || stored.registrationId !== registrationId)
        unavailable();
      if (
        !stored.refreshToken ||
        !stored.refreshExpiresAt ||
        stored.refreshExpiresAt <= now()
      )
        rejected("account_revoked");
      const result = await tokenExchange(
        { grant_type: "refresh_token", refresh_token: stored.refreshToken },
        beforeRequest,
      );
      if (
        result.stored.refreshToken === stored.refreshToken ||
        result.stored.credential.kind !== "bearer" ||
        (stored.credential.kind === "bearer" &&
          result.stored.credential.token === stored.credential.token)
      )
        rejected();
      if (canonicalJson(result.identity) !== canonicalJson(expectedIdentity))
        rejected("account_identity_changed");
      if (
        canonicalJson(result.scopes) !==
        canonicalJson(actualScopes([...expectedScopes]))
      )
        rejected("account_scope_required");
      return result;
    },
  };
  return Object.freeze(adapter);
}
