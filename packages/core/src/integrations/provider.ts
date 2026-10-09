import type {
  AccountIdentity,
  AuthMethod,
  Credential,
  Requirement,
} from "@scaffold/schema/integrations";
import type { HttpTransport } from "./transport";

export interface OAuthRegistration {
  kind: "oauth_app" | "github_app";
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  controlOrigin: string;
  custody: "local" | "hosted";
}
export interface StoredCredential {
  credential: Credential;
  refreshToken?: string;
  refreshExpiresAt?: number;
  registrationId?: string;
}
export interface VerifiedCredential {
  identity: AccountIdentity;
  scopes: string[];
  expiresAt: number | null;
  stored: StoredCredential;
}
export interface CredentialHeaderBudget {
  totalBytes: number;
  maxValueBytes: number;
}
/** Trusted callback invoked once for each credential/identity/refresh HTTP attempt. */
export type ProviderBeforeRequest = (input: {
  url: string;
  method: "GET" | "POST";
  controlTraffic: true;
}) => Promise<void>;
export type ScopeCoverage = (
  granted: readonly string[],
  required: readonly string[],
) => boolean;
export interface ProviderAdapter {
  readonly provider: string;
  readonly methods: readonly AuthMethod[];
  readonly oauth?: OAuthRegistration;
  readonly registrationId?: string;
  verify(input: {
    method: AuthMethod;
    credential?: Credential;
    expectedIdentity?: AccountIdentity;
    beforeRequest?: ProviderBeforeRequest;
  }): Promise<VerifiedCredential>;
  acceptsDestination(url: URL): boolean;
  acceptsRemoteEndpoint(url: URL): boolean;
  inject(stored: StoredCredential, headers: Headers): void;
  injectionSize(
    stored: StoredCredential,
    headers: Headers,
  ): CredentialHeaderBudget;
  validateRequirement(requirement: Requirement): void;
  coversScopes: ScopeCoverage;
  validateSecurityScheme(
    scheme: Record<string, unknown>,
    requirement: Requirement,
  ): void;
  authorizationUrl(input: {
    state: string;
    challenge: string;
    scopes: string[];
  }): string;
  exchange(input: {
    code: string;
    verifier: string;
    scopes: string[];
    beforeRequest?: ProviderBeforeRequest;
  }): Promise<VerifiedCredential>;
  refresh(input: {
    stored: StoredCredential;
    expectedIdentity: AccountIdentity;
    expectedScopes: readonly string[];
    beforeRequest?: ProviderBeforeRequest;
  }): Promise<VerifiedCredential>;
  transport: HttpTransport;
}
