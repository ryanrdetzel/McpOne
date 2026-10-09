export const CONTRACT_VERSION: "0.2.2-m2";
export const PROTOCOL_VERSION: "2025-06-18";
export const EXECUTION_NAMESPACE: "com.toolcontrolplane/execution";
export const FALLBACK_PREFIX: string;
export const LIMITS: Readonly<Record<string, number>>;
export interface ContractFixture {
  name: string;
  valid: boolean;
  value: unknown;
}
export const metadataFixtures: ContractFixture[];
export const resultMetadataFixtures: ContractFixture[];
export interface SchemaFixture {
  name: string;
  valid: boolean;
  schema: unknown;
  dialect?: "3.0" | "3.1";
  direction?: "request" | "response";
  standaloneOnly?: boolean;
  warning?: boolean;
  accepted?: unknown[];
  rejected?: unknown[];
  unchanged?: unknown;
}
export const schemaFixtures: SchemaFixture[];
export function openApiDocument(version?: string): Record<string, unknown>;
export function openApiFixtures(): Array<{
  name: string;
  valid: boolean;
  reviewOnly?: boolean;
  derivedBudget?: boolean;
  operationOptions?: Record<string, { responseMediaType: string }>;
  expectedDiagnostic?: "excluded_media" | "schema_warning";
  document: Record<string, unknown>;
}>;
export const httpSerializationFixtures: Array<Record<string, unknown>>;
export const isolationFixtures: Array<{
  name: string;
  url: string;
  allowed: boolean;
}>;
export const sandboxFixtures: Array<{ name: string; source: string }>;
export function compressionFixtures(): Array<{
  name: string;
  encoding: string;
  wire: Uint8Array;
  valid: boolean;
  decoded?: Uint8Array;
  error?: string;
}>;
export const fingerprintFixtures: Array<{
  name: string;
  frame: Record<string, unknown>;
  canonical: string;
  sha256: string;
}>;
export function controlledExternalFixture(
  origin: string,
  namespace: string,
): Record<string, unknown>;
export const GITHUB_READ_SOURCE: string;
export function githubSourceFixtures(input: {
  credential: { kind: "bearer"; token: string };
  user: { id: number; login: string };
  namespace: string;
  ownership?: "user" | "workspace";
}): Array<Record<string, unknown>>;
