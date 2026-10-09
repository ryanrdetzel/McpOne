# M2 execution contract — 0.2.2-m2

## 1. Authority, review status and scope

**Status: normative `0.2.2-m2` contract and conformance expectations frozen, 2026-10-08, with the explicit human-approved derived-metadata budget recorded below.** The integration owner reviewed the complete interfaces, schema/HTTP/error/numerical matrix and executable expected-case corpus. SolM2Conformance confirmed alignment for `0.2.0-m2` and explicitly acknowledged the parent-approved `0.2.1-m2` correction, updating executable fixture version and expected limits. That correction added missing HTTP carriers for already-required dialect, body-required and per-status response semantics, plus explicit bounded validator work ceilings; it did not broaden scope or weaken validation. Executable fixture completion/execution, isolation/TLS/artifact proofs, real OAuth consent and all six actual source/runtime cells remain independently required. DET-1383 closure and D12 product completion remain the parent's evidence-backed decisions; no deployment/test/M2 acceptance is asserted by freeze.

Follow-up expectation alignment: SolM2Conformance acknowledged the final composed-direction rules and added executable cases for mixed-anyOf required behavior, annotation collection before direction rejection, guaranteed allOf exemptions and conflicting flags. It also acknowledged valid concatenated-gzip positive cases, aggregate wire/decoded limits across members, malformed/truncated/checksum negatives and single-zlib-stream rules. Encoder-generated data vectors are not product-decoder or runtime-pass evidence.

SolM2Conformance also acknowledged current user/membership authority for non-null-principal Grants with legacy-null preservation, the 32-module closure including its entry, and the exact nonblocking `ReviewReport.diagnostics` carrier/digest rules. Observed fixture source and expected-case alignment do not establish that those fixtures or runtime paths have executed successfully.

Explicit human-approved `0.2.2-m2` resource correction ([DET-1384](https://linear.app/detzel/issue/DET-1384)): normalized Tool definitions and review metadata have an aggregate **8 MiB canonical-JSON budget**, independent of retained raw documents and unchanged input limits. Shared compact OpenAPI references otherwise permit hundreds of MiB of derived metadata. Reject the whole oversized derived revision before publication with a precise diagnostic; never silently accept a subset or drop constraints/annotations. Keep current owner API shapes and scoped discovery pagination. This decision does not establish actual 128 MiB Worker or current-tier D1 feasibility; those acceptance checks remain outstanding.

Revision policy: `0.2.0-m2` adds the source/Account/import/artifact contract while preserving `0.1.1-m1` wire behavior and existing fingerprint records. Fixing prose without semantic change may use a patch revision; changing fields, accepted schemas, limits, identity/digest framing, authority, retry or transport semantics requires an explicitly reviewed version and migration/conformance updates. Implementation feasibility findings cannot silently weaken the frozen security contract. Source conflicts and later M3/M4 gates below remain visible, not declared resolved by engineering freeze.

Sources: [M2 brief](https://linear.app/detzel/document/m2-execution-brief-tool-sources-and-accounts-2b01065d9c97), [PRD v1.1](https://app.notion.com/p/3f32eecf0b3f81d58d2ec4e24d740d1f) D3/D4/D6/D8/D12/D14, [D12 draft](https://app.notion.com/p/3f32eecf0b3f81ab874fd78566db1797), [frozen M1 0.1.1-m1](M1-CONTRACT.md), [architecture](../ARCHITECTURE.md). Read the PRD Integration/import/result sections, Account/route/credential model, authentication/custody, publication/authoring, deployment, D14 acceptance, durable execution, retention and operational limits together. D12's draft label remains authoritative; engineering detail here does not silently edit the PRD.

M2 adds real TypeScript, HTTP/OpenAPI and remote MCP sources, named external Accounts, explicit compatibility/bindings, hosted OAuth/local custody, reviewed immutable publication and protected artifacts. It preserves the single authoritative Run/claim/recovery engine, direct SQLite, Worker/D1, stable Profile URL and all M1 safety/wire behavior. The owner API/CLI is sufficient; rich Profile/route UI, live playground, notifications, Guards and Activity search remain M3. Docker, full configurable retention/export/restore and ChatGPT/OMP launch certification remain M4. An omitted M3 UI is not permission to omit M2 authorization.

**Approved gateway extension — [DET-1393](https://linear.app/detzel/issue/DET-1393), 2026-10-09:** a limited authenticated owner UI connects HTTPS no-auth/bearer MCP servers, reviews/publishes namespaced Tools into stable Profiles, issues/revokes Grants, and inspects/decides Runs. It does not establish full M3 or M2 acceptance. `connectionCredentialId` is an optional immutable generic Workspace transport-credential reference in remote sources and retained remote implementations, separate from verified Provider Accounts; source `accountId` and `connectionCredentialId` are mutually exclusive. It changes neither execution metadata nor the Account identity/scope verification contract. Generic OAuth remains an unresolved architecture gate.

### Source inconsistencies, explicitly retained

1. D12 draft §§4/5 still call namespace selection pending; D12.20 and frozen M1 already choose `com.toolcontrolplane/execution`. Preserve that exact spelling.
2. PRD “Gateway Inputs and Result Metadata” and “Open Implementation Questions” still name `_idempotency_key`. D12.18–22 and M1 supersede that carriage: only request `_meta["com.toolcontrolplane/execution"].idempotency_key`. Do not add a legacy alias.
3. PRD Authoring Playground permits testing an unpublished draft in an explicit test context, while PRD D12.5 and D12 draft §7 require published live Tools. M2 supports draft schema/code validation only; every real invocation uses a published Profile Tool and normal Run/Policy/Approval. Resolving live-draft UX is an explicit M3 source-conflict gate, not an implicit permission or PRD rewrite.
4. PRD's older “Idempotency Record Retention” paragraph says 90-day recognition; D12.11, D14 clarification and M1 explicitly guarantee seven days. Preserve the frozen seven-day window; retained audit is not a longer deduplication promise.
5. `_account` is a specifically authorized D6 selector, unlike arbitrary execution metadata. M2 fixed bindings expose no selector and reject supplied `_account`. Future M3 controlled routes may add only the D6 single/keyed selector to a discovery projection, strip it before business validation/invocation and reject upstream collision until explicitly mapped. Do not add Account selectors to D12's two-field execution metadata namespace. This records the narrow D6 exception rather than silently changing every business schema now.

## 2. Common representations and limits

All REST configuration objects are strict: reject unknown members. Arbitrary business JSON and JSON Schema objects are exceptions only where explicitly typed. JSON parsing rejects duplicate object keys, lone UTF-16 surrogates and nonfinite numbers; do not first lose duplicates through `JSON.parse`. JSON strings are UTF-8 on the wire. MiB means 1,048,576 bytes. IDs are server-generated UUIDs, except canonical Tool/Provider/requirement names. Store clocks in epoch milliseconds; expose REST dates as UTC ISO 8601. Hashes are SHA-256, lowercase 64-character hex. Display names/aliases are not identity or authorization.

| Resource | Hard bound / default |
| --- | --- |
| MCP inbound request and complete serialized response | 1 MiB each, including IDs, fallback and metadata, unchanged from M1 |
| Business arguments / decoded inline upstream payload | 1 MiB each; full outbound MCP envelope must also fit |
| OpenAPI root or individual external reference document | 5 MiB UTF-8, counted during reading |
| OpenAPI operations | 500 across all paths, counting unsupported methods too |
| Resolved reference graph | 10 dereferences on a path, 1,000 `$ref` occurrences, 16 distinct documents including root, 20 MiB aggregate source bytes |
| Derived normalized Tool definitions and review metadata | 8 MiB aggregate canonical JSON, definitions counted once within review; excludes retained raw source/reference documents; reject oversized expansion before publication |
| Reference fetch | 10 seconds per attempt, 30 seconds entire resolution, 3 redirects per document, no retry; every hop reauthorized |
| Schema depth / nodes | 32 nested schema edges; 10,000 distinct schema nodes per import or authored manifest |
| Schema properties / enum / composition | 256 properties per object, 256 enum entries, 8 branches per composition keyword, 4 nested composition levels |
| Validation budget | 100,000 schema-node/instance-pair visits per validation, including all composition branches; budget exhaustion rejects, never means valid |
| Bounded validator processing | At most 65,536 expanded NFA states per pattern; at most 10,000,000 processing-work steps per validation, including regex/string/structural uniqueness work; `schema_limit` on exhaustion, checked before unbounded expansion/work |
| Account Requirements | At most 8 per Tool; cardinality exactly one per declared requirement |
| Published Tool count | 500 per Integration revision; Profile discovery paginates rather than exceeding wire limit |
| Binary artifact | 25 MiB decoded bytes each |
| Multipart invocation | 25 MiB aggregate decoded file bytes, 10 file parts, plus at most 1 MiB inline fields and 64 KiB MIME overhead; total at most 27,328,512 bytes |
| TypeScript | 256 KiB entry source, 1 MiB full source module closure, 32 modules including entry (at most 31 additional `modules` entries); immutable compiled artifact at most 1 MiB |
| Tool wall clock / attempts / outbound requests | 60 seconds default, maximum 300 seconds; 3 safe attempts total; 30 broker requests across the logical Run, not per attempt |
| Workspace executing Runs | 5; waiting approval consumes none; adapter resource admission may queue below this ceiling but never silently raise it |
| Approval / key retention | M1 three-hour default, 15-minute–24-hour configurable immutable deadline; seven-day key window |
| Credential/OAuth exchange | 10 seconds per request; JSON response at most 64 KiB; no secrets in errors/logs |

Configuration may lower bounds, not raise maxima without a contract revision and validated platform capability. Runtime options are server-owned reviewed configuration, not new request metadata. `Content-Length` is advisory; count actual decoded bytes and cancel readers at limit+1. HTTP chunked transfer framing is not itself streaming business semantics: a finite bounded body may be collected internally. SSE/NDJSON live results, indefinite bodies, resumable upload and client-visible incremental Tool results are unsupported. HEAD remains bodyless.

## 3. Normalized source and invocation interfaces

These are exact logical JSON interfaces, not instructions to duplicate definitions between packages. Shared schemas belong in `packages/schema`; shared interpretation, routing, broker and Run integration belong in `packages/core`. Platform adapters provide only storage, sandbox engine loading, safe network transport and existing scheduling. No direct filesystem/config globals in core.

```ts
type OperationClass = "read" | "write" | "destructive" | "unknown";
type AuthMethod = "none" | "bearer" | "api_key" | "basic" | "oauth2";
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
type Requirement = {
  provider: string; methods: AuthMethod[]; scopes: string[];
  issuer?: string; audience?: string; tenant?: string; application?: string;
};
type Permission = {
  requirement: string | null; origin: string; methods: HttpMethod[];
  path: string; match: "exact" | "prefix";
};
type ToolDefinition = {
  name: string; upstreamName?: string; description: string;
  inputSchema: JSONSchema; outputSchema?: JSONSchema;
  operationClass: OperationClass;
  requirements: Record<string, Requirement>; permissions: Permission[];
  implementation: Implementation;
};
type HttpParameter = {
  name: string; in: "path" | "query" | "header"; required: boolean;
  schema: JSONSchema; style: "simple" | "form"; explode: boolean;
};
type Implementation =
  | { kind: "typescript"; source: string; entrypoint: string;
      modules: Record<string, string> }
  | { kind: "http"; method: HttpMethod; url: string;
      dialect?: "3.0" | "3.1"; parameters: HttpParameter[];
      requestBody?: { mediaType: string; schema: JSONSchema; required?: boolean };
      response: { mediaType: string; schema?: JSONSchema;
        statuses?: Record<string, { mediaType: string; schema?: JSONSchema }> } }
  | { kind: "remote_mcp"; endpoint: string;
      protocolVersion: "2025-06-18"; toolName: string;
      connectionCredentialId?: string };
type BusinessMcpResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, JSONValue>;
  isError?: boolean; _meta?: Record<string, JSONValue>;
};
type FrozenTool = {
  toolId: string; name: string; toolRevision: string;
  integrationId: string; integrationRevision: string;
  artifactDigest: string; definition: ToolDefinition;
};
type Invocation = {
  runId: string; claimId: string; tool: FrozenTool;
  arguments: Record<string, JSONValue>; deadlineMs: number; broker: Broker;
};
type EffectEvidence =
  | { state: "not_dispatched" }
  | { state: "verified_no_effect"; reason: string }
  | { state: "completed"; providerRequestId?: string }
  | { state: "possible"; providerRequestId?: string }
  | { state: "provider_idempotent"; provider: string;
      key: string; expiresAt: string };
// resolveTools(source, ownerContext) -> ReviewReport
// invokeTool(invocation) -> { result: BusinessMcpResult, effect: EffectEvidence }
```

`JSONSchema` is the exact bounded matrix in §7, not any JSON Schema dialect. `JSONValue` is JCS-representable JSON. Tool input root and MCP output schema root are objects; nested body/HTTP response schemas may be scalar. Names match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`, at most 128 ASCII characters, and start with the Integration slug. Slugs match `^[a-z][a-z0-9_]{0,63}$`; `runs.*` is reserved. Requirement names use the same single-segment grammar. Requirements/method/scope arrays contain unique entries, methods are nonempty. Scopes are case-sensitive Provider identifiers. Descriptions are at most 4,096 Unicode scalar values. Aliases are nonempty, at most 128 scalar values, reject controls, and are unique within Workspace/Provider/ownership for unambiguous display; authority always uses IDs.

HTTP `dialect` defaults to `3.1` for manually authored operations; import preserves the actual source dialect explicitly. `requestBody.required` defaults false; absent body and JSON null remain distinct. `response.statuses` keys are exact three-digit statuses 100–599 or `default`; range patterns reject. When the map is present it is nonempty and selects exact status, then `default`, otherwise fails closed as an unreviewed result; no fallback to the top-level media/schema. Without a map the top-level response is the manually reviewed generic successful-response contract. Imports preserve all selected explicit/default response contracts, not only the first success. Ordinary HTTP failure mapping and HEAD/204 empty-body rules still apply.

Tool/MCP roots may be effectively object-only through references/composition without an explicit sibling `type:"object"`. Preserve original constraints. Conservative structural proof permits a direct object restriction, an `allOf` with at least one object-only conjunct, or `anyOf`/`oneOf` whose viable branches are all object-only; statically false branches may be ignored. Reject uncertain mixed-root semantics rather than injecting an unreviewed restriction or approximating arbitrary satisfiability.

`upstreamName` is retained verbatim for invocation; normalization collisions require explicit owner `nameMapping` or exclusion, never suffixing an already approved name silently. The four operation classes are distinct. Imported hints only suggest a class; unknown stays unknown until reviewed. A read label, HTTP verb or guest return value is not retry evidence.

Protected M2 results use explicit storage framing `{format:"mcp",result:BusinessMcpResult}`. A durable format/version column distinguishes legacy M1 JSON; never guess framing by inspecting a business object's keys. `RunView.businessResult` supplies the normalized transport result. Existing owner `RunView.result` remains its M1 business JSON projection for the fixture; this is a read projection, not a second execution path. Fixture dispatch also normalizes once into `BusinessMcpResult`. The MCP renderer appends gateway fallback to a copy, preserves business content/structured content/third-party metadata, and sets `isError` if either upstream `isError` is true or the gateway status is an error. It must not JSON-stringify an entire upstream MCP result as if that were its business value.

Only trusted adapters/broker supply effect evidence. Guest assertions, upstream `isError`, HTTP 4xx/5xx and a missing response do not prove no write. If an effect was definitely acknowledged but result processing fails, retain that effect fact in safe audit and return `unsupported_result`/`payload_too_large` without retry; where final effect cannot be established, Run status is `outcome_unknown` regardless of the response-format error that caused it.

## 4. Owner API, drafts and publication

Every path below is under `/api/control`, uses BetterAuth, role `owner` in the active organization, organization-scoped lookups, same-origin mutation protection and existing request/error/OpenAPI registration. Grant bearer, member/admin, guessed IDs and an approval URL confer no administration. Errors are `{error:ExecutionError}`. Success shapes below have no additional `data` envelope. Owner GETs do not dispatch. Credential-bearing POST/PATCH bodies are permitted through the authenticated private application channel but never copied into agent tool arguments, command lines or issue attachments.

```ts
type Source =
  | { kind: "typescript" | "http"; tools: ToolDefinition[] }
  | { kind: "openapi"; document: string; approvedRefOrigins: string[];
      serverUrl?: string; nameMapping: Record<string, string>;
      securityMappings: Record<string, {
        requirement: string; requirementDefinition: Requirement;
      }>;
      operationOptions: Record<string, {
        requestMediaType?: string; responseMediaType?: string;
        securityAlternative?: number;
      }> }
  | { kind: "remote_mcp"; endpoint: string; accountId?: string;
      connectionCredentialId?: string;
      namespace: string; nameMapping: Record<string, string> };
type RevisionSummary = {
  revisionId: string; createdAt: string;
  status: "draft" | "published" | "superseded";
  digest: string; available: boolean;
};
type ReviewDiagnostic = {
  upstreamName: string; path: string;
  code: "excluded_media" | "schema_warning"; message: string;
};
type ReviewReport = {
  integrationId: string; draftRevisionId: string; reportDigest: string;
  accepted: ToolDefinition[];
  rejected: { upstreamName: string; path: string; code: string; message: string }[];
  diagnostics?: ReviewDiagnostic[];
  changes: { tool: string; kind: "new" | "unchanged" | "changed" | "removed" }[];
  affectedProfiles: {
    profileId: string; revision: number; grantCount: number; tools: string[];
  }[];
};
type ProfilePublication = {
  profileId: string; expectedRevision: number; tools: string[];
  bindings: Record<string, string>;
  policies: { pattern: string; decision: "allow" | "ask" | "block" }[];
};
```

For TypeScript/HTTP sources, implementation kinds must match `Source.kind`. Remote `namespace` equals Integration slug; discovery `accountId` is owner-selected, compatible discovery credential only, never an implicit runtime Profile binding. OpenAPI `document` is JSON or safe YAML, not a URL fetched through unrestricted networking. YAML custom tags, aliases, merge keys, duplicate keys and non-JSON scalar values reject. `nameMapping`/`operationOptions` keys are stable `<UPPER_METHOD> <path>`; upstream `operationId`, if present, is retained. Remote mappings use upstream Tool name. All mapping destinations are full canonical names.

The gateway extension's `connectionCredentialId` is owner-created, organization-scoped, encrypted at rest, and bound to one canonical HTTPS endpoint. It is not an Account alias or proof of verified identity/scopes. Owner publication explicitly shares the frozen credential reference with selected Workspace Profile Tools. Trusted discovery/invocation reloads custody and rechecks exact endpoint; invocation additionally checks the current enabled, published Profile/Integration selection after the durable dispatch fence. Refuse credential-bearing redirects, foreign organizations/endpoints, caller/guest credential selection, and credential/session contamination in reviewed metadata or decoded result keys. Tokens never enter source/review/Run plaintext or owner inventory responses. Existing Provider-backed `accountId` semantics remain unchanged.

Additional same-origin owner API endpoints: `GET /gateway` returns persisted Profile/policy/Grant inventory and remote connection metadata without tokens; `POST /gateway/profiles` creates an empty real Profile from `{label}`; `POST /gateway/connections` creates an unpublished remote source from `{slug,displayName,endpoint,bearerToken?}`. Discovery and publication still use the immutable review/CAS routes below; no connection setup operation invokes a business Tool. Exact schemas are exported from `@scaffold/schema/gateway` and registered in OpenAPI. Generic OAuth, `stdio`, production rollout and hosted transport compatibility are not implied by this extension.

| Method/path | Request | Success |
| --- | --- | --- |
| POST `/integrations` | `{slug,displayName,source}` | 201 `{integrationId,draftRevisionId}` |
| GET `/integrations/:id` | None | 200 `{integrationId,slug,displayName,enabled,currentRevisionId,drafts:RevisionSummary[],revisions:RevisionSummary[]}`; current may be null |
| POST `/integrations/:id/validate` | `{draftRevisionId}` | 200 `ReviewReport`; validation/discovery is not business invocation |
| POST `/integrations/:id/refresh` | `{source?:Source}` | 201 `{integrationId,draftRevisionId}`; absent source refreshes stored source |
| POST `/integrations/:id/publish` | `{draftRevisionId,reportDigest,expectedCurrentRevisionId,profiles:ProfilePublication[]}` | 200 `{integrationId,revisionId,profiles:[{profileId,revision}]}` |
| POST `/integrations/:id/rollback` | `{revisionId,reportDigest,expectedCurrentRevisionId,profiles:ProfilePublication[]}` | Same as publish; validate accepts retained revision ID as `draftRevisionId` to produce fresh rollback report |
| PATCH `/integrations/:id` | `{enabled?:boolean,displayName?:string}` | 200 `{integrationId,enabled,displayName}` |
| GET `/profiles/:id` | None | 200 `{profileId,label,revision,enabled,tools:string[],bindings:Record<string,string>}`; current owned Profile for observed CAS |
| POST `/profiles/:id/bindings` | `{expectedRevision,bindings:Record<string,string>}` | 200 `{profileId,revision}` |

Bindings keys are `<integration-slug>.<requirement>`; values are owner-only Account IDs. Fixed binding updates explicitly confirm the submitted target bindings and increment Profile/control revisions atomically. Publication `tools` replaces only this Integration's selected membership, never unrelated Integration membership. `policies` replaces only this Integration's explicitly targeted patterns; a cross-Integration/global pattern rejects. Empty `profiles` publishes a catalog revision without granting visibility. Reject foreign/repeated Profile IDs, rejected Tools, unmet bindings, stale revisions and stale reports before any publication writes.

Report digest covers immutable draft contents, normalized schemas, resolved references, code/module hashes, namespaces, reviewed classes, requirements, outbound permissions and the impact snapshot. Publication transaction compares expected Integration/current Profile revisions and monotonic control epoch. It atomically activates all selected definitions/membership/bindings/policy updates; calls cannot observe mixed versions. One stale target causes all-or-nothing `publication_conflict`, not partial authority changes. Run admission uses a consistent revision snapshot or epoch CAS.

`diagnostics` is the nonblocking owner-review carrier for already-required excluded-media alternatives and schema/default/example warnings. Absence means an empty array. Accepted operations with warnings remain in `accepted`; never mislabel their alternatives as rejected operations. Each diagnostic names the upstream operation and source JSON Pointer, uses the exact code above, and has a static safe message of at most 512 Unicode scalar values without source snippets, business values or credentials. No arbitrary 500-diagnostic ceiling applies; existing byte/work budgets still do. All emitted diagnostics and excluded/selected choices participate in `reportDigest`, so publication confirms what the owner actually reviewed rather than hiding warnings only in an internal manifest.

Drafts are never discoverable/callable. All changed definitions, including descriptions, schema-compatible changes, endpoint/auth/permission changes, remain unpublished until reviewed. New Tools do not inherit visibility from a namespace wildcard. Health-only updates cannot change authority. Retain approved immutable local code/configuration while available and authorized; confirmed unavailable/unsafe approved remote definitions suspend affected Tools rather than substituting new ones. Retain active artifacts and revisions required by still-actionable Runs. Namespace change is explicit removal/new mapping with policy impact preview, not a display rename.

Rollback restores only an available retained artifact/configuration; it does not revert remote server code, Provider state or effects. A cached remote manifest is not implementation pinning. Unversioned upstream behavior can change behind an unchanged URL; this limitation must be disclosed, not disguised as a frozen remote executable.

## 5. Accounts, compatibility, credentials and OAuth

```ts
type Credential =
  | { kind: "bearer"; token: string }
  | { kind: "api_key"; value: string }
  | { kind: "basic"; username: string; password: string };
type AccountIdentity = {
  subject: string; issuer?: string; audience?: string;
  tenant?: string; application?: string;
};
type AccountView = {
  accountId: string; provider: string; alias: string;
  ownership: "user" | "workspace"; ownerUserId: string | null;
  method: AuthMethod; identity: AccountIdentity; scopes: string[];
  enabled: boolean; health: "unverified" | "healthy" | "expired" | "revoked" | "error";
  expiresAt: string | null; createdAt: string;
};
```

| Method/path | Request | Success |
| --- | --- | --- |
| POST `/accounts` | `{provider,alias,ownership,method,identity,scopes,credential?}` | 201 `AccountView`; OAuth Accounts are created only through callback |
| GET `/accounts` | None | 200 `{accounts:AccountView[]}` |
| GET `/accounts/:id` | None | 200 `AccountView` |
| PATCH `/accounts/:id` | `{alias?,enabled?,credential?}` | 200 `AccountView`; rotation cannot replace identity |
| POST `/accounts/oauth/start` | `{provider,alias,ownership,accountId?,scopes,returnPath,review?:{integrationId,draftRevisionId,profileIds:string[]}}` | 200 `OAuthStartResult`, including required owner-visible `impact` below |
| GET `/accounts/oauth/callback` | Provider `code` and one-use `state` | 303 same-origin safe return path, no credential-bearing query string |

Account ownership is explicit. A User Account belongs to authenticated actor, not an arbitrary submitted owner ID; invocation requires that same principal. A Workspace Account is shared only through explicit eligible Profile binding, disclosed in owner review. Matching Provider alone is insufficient: method, issuer, audience/resource, tenant, application, actual granted scopes, owner eligibility, enabled/revoked/expiry state must all satisfy the requirement. Unspecified constraints mean no restriction on that dimension only where the trusted Provider configuration permits it; omission is not permission to accept an unverified issuer/audience. Unknown Provider or unsupported method fails before credential storage.

Grant principal migration is explicit: newly issued Grants store server-owned `principal_id` from the authenticated issuing owner's session user ID; no caller-supplied principal override. Existing M1 Grants backfill null and preserve all fixture/M1 behavior, but cannot use a User Account until the owner explicitly issues a replacement labeled Grant. Never silently attribute existing organization Grants to the current owner. Workspace Accounts remain independently controlled by exact eligible Profile binding. A User Account can execute only when its immutable owner ID equals the Run's server-established Grant principal; organization membership alone is insufficient.

Current principal authority is independent of immutable identity equality. Every non-null-principal Grant requires that user to still exist and have current membership in the Grant's organization; any membership role suffices, with no new owner/admin threshold. Enforce this at Grant authentication, caller content inspection, admission, claims and broker dispatch. User Account eligibility additionally requires its immutable owner to equal that currently authorized principal. Removing the user or membership blocks waiting work before dispatch, even if a previously valid Approval exists. This follows the PRD's current principal/Workspace checks, not an implicit reassignment of authority.

The final atomic before-send boundary must test current user and membership existence in the same authoritative claim/epoch/budget transition, not rely solely on a prior read or control-epoch bump: a BetterAuth membership mutation may not increment that epoch. Removal after an already-won dispatch boundary follows existing best-effort cancellation/uncertain-effect rules. Legacy null-principal M1 Grants remain eligible for frozen fixture behavior and explicitly authorized Workspace Accounts; no new membership check may fabricate a principal or grant access to User Accounts. Owner-session inspection continues through existing owner authorization, not an unrelated caller Grant.

A trusted Provider adapter owns permitted auth methods, allowed resource origins, header/key injection, identity verification, actual permission interpretation and OAuth endpoints. Tool authors cannot declare that arbitrary credentials are compatible. Manual identity/scopes are explicitly owner assertions until a supported verification request establishes them; do not label a manually asserted privilege verified. A manual connection that cannot prove a required claim remains unavailable for that requirement. Provider-specific authoritative permission evidence may come from token introspection, token response or documented permission endpoint; an HTTP success alone does not prove all scopes.

Credentials are AES-GCM encrypted at rest with fresh 96-bit nonces; derive separate purpose keys from the secret root and bind organization, Account ID, credential version and purpose in AAD. Account ciphertext/credential refs/refresh tokens never appear in `AccountView`, Run displays, MCP, schema, logs or guest context. Maintain the existing M1 payload decryption format; a new credential-purpose derivation must not strand M1 Runs. Changing a refresh token is not changing Account identity. A patched credential must reverify the same subject/issuer/audience/tenant/application before activation; otherwise reject and require a separately created Account. Alias-only changes do not invalidate pending approval or alter frozen provenance.

The frozen Account identity digest is SHA-256 of JCS `{provider,ownership,owner_user_id,method,subject,issuer,audience,tenant,application}`, using explicit null for absent optional identity fields and null owner for Workspace Accounts. Secrets, token revision, alias, health and scopes are excluded. Scopes are current restrictions and frozen approved capability is bounded separately. User/Workspace ownership and immutable subject cannot be patched.

Disabling/revoking an Account or Integration increments the control epoch in the same transaction as the change and prevents/cancels affected waiting work. Recheck compatibility/scopes/identity at dispatch and before broker credential use. Missing scopes disable affected operations only; valid unrelated reads remain usable. No implicit fallback, including substitution of a Workspace Account for a missing User Account. Fixed routes reject `_account` even when it names the fixed Account.

### OAuth and scope upgrade

```ts
type OAuthScopeImpact = {
  accountId: string | null; currentScopes: string[]; requestedScopes: string[];
  published: {
    profileId: string; label: string;
    tools: {
      name: string; requirement: string;
      currentScopesSatisfied: boolean; requestedScopesSufficient: boolean;
    }[];
  }[];
  proposed?: {
    integrationId: string; draftRevisionId: string; callable: false;
    profiles: OAuthScopeImpact["published"];
  };
};
type OAuthStartResult = {
  authorizationUrl: string; expiresAt: string; impact: OAuthScopeImpact;
};
```

The owner sees `impact` before following the consent URL. Existing Account upgrades request the union of current actual resource grants and explicitly requested additional scopes; denied or insufficient consent must preserve still-valid unrelated operations. `currentScopesSatisfied` and `requestedScopesSufficient` are strictly scope-coverage booleans using trusted Provider semantics, not verified overall Account compatibility or callable availability. The latter assumes those requested scopes are actually granted and the immutable identity remains unchanged; it never authorizes a call before callback verification. Acquisition flags such as `offline_access` are not manufactured resource grants.

`published` describes currently published Tools bound to the selected Account through exact current Profile bindings. New Accounts have `accountId:null` and empty current scopes/published impact. Optional `review` explicitly selects an owned, validated immutable draft and owned target Profiles; return its proposed impact separately with `callable:false`. Do not scan unselected/unreviewed drafts, infer future Profile targets, silently mutate membership/bindings/permissions, or imply proposed Tools are published. The preview and its authorization URL together must fit the existing 1 MiB owner JSON limit; measure serialized bytes and fail before writing OAuth intent state if oversized. No arbitrary Profile-count cap substitutes for that byte bound.

When `review` is supplied, `profileIds` must be a nonempty unique list of explicitly selected owned Profile IDs. Omitting `review` is different from selecting an empty target list. No arbitrary maximum Profile count is introduced; the complete serialized preview bound remains authoritative.

Use native trusted Provider adapters, not a mandatory third-party broker. Hosted app registration is managed per deployment; local supports BYO registration and encrypted local token/refresh custody without a hosted McpOne account. No shared service refreshes local credentials or proxies local business traffic.

Authorization state is 256-bit random, single-use, expires in 10 minutes, bound to owner/session/organization/Provider/registration, exact callback, requested scopes and any reconnect Account identity. Store only state digest plus protected PKCE verifier/intent; use S256 PKCE where the selected Provider supports it. No downgrade to an unsupported/misleading PKCE claim: lack of required Provider support is an explicit method prerequisite. Validate `returnPath` as a relative same-origin control-plane path; reject protocol-relative, encoded separators and arbitrary callback destinations. Callback rechecks current owner/session authority and consumes state atomically before code exchange. Browser-supplied issuer/token endpoints are not trusted.

Validate actual token response, scope grant and remote subject/tenant/application before creating or updating an Account. On reconnect/scope upgrade, changed identity is `account_identity_changed`, never replacement of the old binding. Denied consent or missing scopes leaves the requested operation unavailable but does not deliberately revoke valid existing operations. Token refresh is serialized with durable credential-version compare-and-swap and a bounded lease; stale refresh completion cannot overwrite newer rotated credentials. Persist replacement access/refresh credentials atomically; ambiguous refresh-token rotation requires reconnect, not concurrent retries with old rotating secrets. Redact OAuth code/state/token bodies and callback query strings from logs.

Refresh sends only Provider-defined parameters to pinned trusted token endpoint, uses the same identity/registration and revalidates any returned claims. `invalid_grant` marks refresh unusable, not every unrelated Provider Account. Provider scope upgrades cannot expand Profile membership, Account routes, Tool permission manifests or Allow/Ask/Block.

## 6. Broker-only egress and runtime plan

```ts
type Broker = {
  request(input: {
    accountRequirement: string | null; method: HttpMethod; url: string;
    headers?: Record<string, string>; body?: JSONValue | string;
    mediaType?: string;
  }): Promise<{
    status: number; headers: Record<string, string>;
    body: JSONValue | string | { artifact: ArtifactRef };
  }>;
};
```

Every request, authenticated or not, is bound to current Run, claim, immutable Tool/Integration revision, declared requirement, selected Account identity and remaining budget. `null` requirement means explicit unauthenticated permission, not unrestricted fetch. Never accept an Account ID, credential reference or alternate requirement from guest code as new authority. Before each outbound attempt, verify current restrictions, consume durable request budget and record a conservative possible-effect boundary before network transmission. Unknown recovery never starts from a new in-memory request counter.

A permission origin is canonical HTTPS origin, no credentials/path/query/fragment/wildcard, default port 443 only. Path is canonical absolute URL pathname; `exact` is exact equality, `prefix` matches descendants on a segment boundary, not substring (`/v1/a` cannot match `/v1/admin`). Reject backslashes, invalid escapes, encoded path separators/NUL and dot-segment ambiguity before checking final URL. URL builder encodes user data once; it cannot let arguments replace authority/host. Header names are case-insensitive. Always reject `host`, `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `connection`, `content-length`, `transfer-encoding`, `forwarded`, and `x-forwarded-*` from guest/Tool input. A reviewed allow-list governs remaining request headers. Trusted adapters attach credentials only after all destination/method/path/requirement checks.

DNS/network invariant: block loopback, RFC1918/ULA, link-local, unspecified, multicast, carrier-grade NAT, documentation/benchmark/reserved ranges, IPv4-mapped forbidden IPv6 and metadata destinations. Reject noncanonical integer/octal/hex IP spellings, local names, URL userinfo and ports other than 443. Resolve both A/AAAA; any forbidden returned address rejects the destination. Revalidate every connection and redirect, not just import time. Node must bind the validated address to the actual TLS connection while retaining original hostname certificate verification. A standalone DNS lookup followed by another independently resolving `fetch` does **not** satisfy this invariant.

Redirects are manual, at most three, count against the 30-request budget and must independently satisfy exact approved origin/path/method and credential-destination rules. Do not forward credentials cross-origin automatically. 303 changes to GET only if the resulting request is separately permitted; 301/302 mutation-method rewriting is rejected; 307/308 preserve method/body only with reauthorization and no uncertain replay. External schema references never receive client/Provider auth or cookies.

Return only bounded data and allow-listed response headers (`content-type`, safe `content-length`, `etag`, `last-modified`, `retry-after`, and explicitly approved request-correlation header). Strip cookie/auth headers. Do not return raw upstream error bodies, redirect URLs containing credentials, TLS internals or diagnostic headers to guest/errors. Redaction is not a guarantee that a malicious approved upstream cannot encode a credential it received; therefore approve only trusted Provider destinations for credential injection, never an arbitrary echo endpoint. Guest logs use bounded text (64 KiB per Run) with secret-value redaction before storage and follow payload retention.

### Isolation choice and hard feasibility gate

**Selected target: QuickJS interpreter in precompiled WebAssembly, fresh guest runtime/context for each Run, static trusted engine artifact on both platforms.** Guest code runs inside the engine, not through host `eval`, `Function`, `node:vm`, a VM context masquerading as a security boundary, or a Worker with ambient deployment secrets/network. QuickJS guest `eval`/constructors cannot escape into host JS because only serialized bounded values and approved native broker calls cross the boundary. Deny guest module loads except the immutable reviewed local source closure. Do not expose `fetch`, `process`, `require`, filesystem, sockets, Worker bindings, host reflection or generic native objects. Dependencies execute inside the same guest isolation with identical restrictions.

Pin `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync` to **0.32.0**. Use the sync variant and its Cloudflare-compatible Emscripten loader, supplying the precompiled static module through `instantiateWasm`; guest async Promises are driven through explicit job pumping and the bounded broker bridge, not an Asyncify dependency with different resource behavior. Parent measured package exports; actual loader/runtime proof remains required. Approved lifecycle config is `wasmModules:[{name:"quickjs.wasm",path:"apps/worker/dist/quickjs.wasm"}]`; preserve static `./quickjs.wasm` import, at most 16 flat safe `.wasm` module names, aggregate JS+WASM at most 10 MiB. No request-time engine download/compilation.

An authored Tool exports one function named by `entrypoint` (`default` if omitted), called with `(input, ctx)`; `ctx.http.request` is the Broker interface above. Return object -> MCP structured JSON plus text representation; scalar -> JSON text block; undefined/function/symbol/BigInt/cyclic/nonfinite return -> `unsupported_result`. Promise completion and guest pending jobs are driven only within the same deadline, with bounded job steps. At most one outstanding broker call per guest simplifies cancellation and budget accounting; ordinary sequential async functions remain supported. No untrusted top-level effect during validation/publication.

TypeScript compilation is a trusted, pinned, no-network transformation to an ES module accepted by the selected QuickJS version. Resolve only relative `.ts` modules in the supplied immutable closure, reject escaping paths and unresolved dynamic imports. Pure-JS packages may be bundled into that closure with exact dependency versions/source hashes/licenses and reviewed code; no arbitrary npm install, lifecycle scripts, native addon or runtime package resolution. This supports a small package without promising every Node SDK. Unsupported syntax/dependency/API yields a specific validation report before publication; do not silently reinterpret TypeScript as a small expression DSL. Syntax diagnostics are mandatory; full type-check diagnostics are reported where the chosen pinned compiler supports them, not falsely claimed by type erasure alone. Artifact digest covers source closure, compiler/runtime versions and emitted module bytes.

Proposed resource configuration for runtime feasibility proof: guest heap 8 MiB, guest stack 256 KiB, engine linear memory maximum 32 MiB; maximum 100 ms cumulative guest CPU per Run plus the shared 60-second wall deadline and 30-request budget. The adapter must enforce/prevent allocations before exceeding its memory ceiling, and interrupt nonterminating guest work, including Promise job loops. Host serialization/bridge buffers are bounded separately; no bulk 25 MiB artifact is copied into the 8 MiB guest heap. Serialize local engine instances/large binary assembly per process when needed to fit the Worker 128 MiB limit; D1 remains Run authority and queue, not a new process-local job queue. **These CPU/memory settings are engineering targets, not measured guarantees; do not accept the runtime until proof demonstrates them under the actual account tier.** Reject unsupported settings instead of weakening them or upgrading a paid tier.

Feasibility facts inspected on 2026-10-08:

- [QuickJS upstream](https://github.com/justjake/quickjs-emscripten) documents Node and Cloudflare support, runtime heap/stack limits, interrupt handlers and controlled host functions. This establishes available APIs, not this repository's isolation proof.
- [Workers WebAssembly documentation](https://developers.cloudflare.com/workers/runtime-apis/webassembly/) requires a precompiled module; runtime byte compilation is unsupported. Workers also has no Web Worker/thread primitive. Embedding base64 WASM in `index.js` and compiling on request is not a workaround.
- Initial repository inspection found a single-JS-only lifecycle snapshot schema. The user subsequently explicitly approved the narrow static-WASM lifecycle/module dependency and necessary scoped controller deployment, recorded in [DET-1391](https://linear.app/detzel/issue/DET-1391) and the architecture decision. This removes the authorization blocker, not implementation/validation: preserve existing bindings, namespaces, database identity and additive migration safety; no unrelated controller redesign or paid upgrade.
- [JS-Interpreter](https://neil.fraser.name/software/JS-Interpreter/docs.html) supports ES5 stepping/async bridge, but documents memory-bomb detection by periodic post-allocation stack measurement and host-specific regexp DoS mitigation. Stock JS-Interpreter fails the required hard memory bound; merely counting steps is insufficient. A fork intercepting every allocation/native string/regexp operation would need its own extensive proof and must not silently narrow supported TypeScript.
- QuickJS compiled to fixed-heap JavaScript through Emscripten/Binaryen `wasm2js` is an unverified alternative, not a selected available dependency. No suitable audited no-host-eval artifact or resource proof was established. It is not accepted merely because its output is one JS file.
- [Workers Node HTTPS](https://developers.cloudflare.com/workers/runtime-apis/nodejs/https/) is a fetch wrapper with stub Agents and no underlying socket/SNI configuration. A Node DNS-pinning Agent cannot be assumed to work there. [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) block Cloudflare IPs/private addresses. The transport owner additionally reported that current edge `startTls({expectedServerHostname})` override is unavailable despite local workerd acceptance, with upstream [workerd issue 6903](https://github.com/cloudflare/workerd/issues/6903); Node TLS delegates to the same unsupported mechanism. Thus the attractive literal-IP socket plus original-hostname certificate-verification design is not currently an established hosted solution. Do not ship a fetch fallback or disable certificate verification. Connection-bound SSRF remains normative; a supported hosted mechanism or explicit material security/architecture decision is still required. This is a concrete implementation blocker, not an unresolved meaning of the contract.
- Alternative TLS research rejected unmodified [Reclaim TLS](https://github.com/reclaimprotocol/tls/blob/main/src/utils/parse-certificate.ts): inspected verifier combines CN/SAN, permits wildcard labels outside the leftmost position and wildcard-apex matches, and its [X509 wrapper](https://github.com/reclaimprotocol/tls/blob/main/src/utils/x509.ts) checks signatures without the full CA constraints needed here; default AIA fetching also uses unrestricted fetch. Its referenced license is MIT, but that does not establish safe verification. [subtls](https://github.com/jawj/subtls) explicitly declares itself non-production and incompletely compliant. Neither is a safe drop-in just because it can complete a handshake.

Selected next implementation path for hosted TLS: an established maintained TLS/X509 engine (Mbed TLS 3.6 LTS preferred, or OpenSSL 3.5 LTS if its toolchain is already available) compiled to a static WASM module, with a thin bounded memory-I/O bridge, not new cryptographic algorithms or a patched-in-homegrown certificate validator. Final exact upstream patch/build hashes must be recorded before packaging. [Mbed TLS's standard client API](https://mbed-tls.readthedocs.io/projects/api/en/v3.6.4/api/file/ssl_8h/) provides `mbedtls_ssl_set_bio`, `mbedtls_ssl_set_hostname`, `mbedtls_ssl_conf_ca_chain` and `MBEDTLS_SSL_VERIFY_REQUIRED`: use original hostname for SNI and verification while the adapter's raw socket connects only to its validated literal address. Require full trust-chain, expiry, hostname, usage and CA/path constraint verification by the established library; TLS minimum1.2, modern AEAD suites, no insecure renegotiation, no permissive callback, no 0-RTT, no implicit session sharing across identities.

Preferred source pin verified from the official release API: [Mbed TLS 3.6.7](https://github.com/Mbed-TLS/mbedtls/releases/tag/mbedtls-3.6.7), published 2026-07-07, LTS supported through at least March 2027. Official `mbedtls-3.6.7.tar.bz2` SHA-256 is `a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6`; it includes generated/submodule material absent from GitHub's automatic source archives and current security fixes including malformed basicConstraints handling. Pin compiled wrapper/toolchain/CA-bundle digests separately; old 3.6.4 API documentation is not a dependency version recommendation.

TLS bridge receives entropy only from `crypto.getRandomValues`, a pinned provenance-reviewed public CA bundle and bounded current time, never arbitrary guest capabilities. No certificate AIA/OCSP URL fetch bypass; absent required intermediate fails closed. Cap handshake bytes at256KiB, chain length10 and handshake wall clock10seconds within the enclosing deadline; plaintext/ciphertext queues remain bounded with backpressure. Retain TLS termination/verification before transmitting any credential-bearing HTTP bytes. Prove invalid host, expired/untrusted chain, non-CA issuer, chain-depth/size, corrupted record and abort failures, plus actual hosted GitHub handshake. This is a concrete dependency plan, not a claim that such a WASM wrapper/build or hosted proof already exists.

The trusted portable seam is `HttpTransport.request({url:string,method:string,headers:Headers,body?:Uint8Array,signal:AbortSignal,maxResponseBytes:number}):Promise<Response>`. Core HTTP framing uses `createPinnedHttpTransport({resolve(hostname,signal):Promise<string[]>,connect({address,hostname,port,signal}):Promise<PinnedConnection>})`, where `PinnedConnection` is `{readable:ReadableStream<Uint8Array>,writable:WritableStream<Uint8Array>,close():void}`. The connection's address is the vetted numeric peer; hostname supplies TLS identity, never a second DNS lookup. No redirects at this transport seam: the shared broker/reference resolver owns reviewed manual redirects. Connection refusal/platform limitation is `upstream_unavailable` or `unsupported_feature`, not fabricated SSRF enforcement evidence.

TLS trust/identity/policy rejection is permanent, not transient network failure. The internal transport classification `tls_validation_failed` covers certificate/CA/hostname failures, unsupported or denied TLS algorithms/options, and otherwise unclassified TLS handshake denials; it is not a new public `ExecutionError` code. Only positively identified transient operating-system network failures may retain `connection_failure`. Peer-address mismatch remains an unsafe-target denial and unsupported ALPN/protocol remains an unsupported-destination denial. A trusted pre-HTTP failure may report that this request did not dispatch, but must not clear earlier Run effects or imply automatic retry: permanent TLS rejection is never retried as connectivity recovery. A failure after possible HTTP transmission retains existing uncertain-effect rules.

No runtime deployment/probe or credential operation was performed by the contract author. Parent owns actual resource verification and implementation acceptance. The WASM lifecycle dependency is now authorized; implementation evidence and hosted safe-network capability remain separate gates. Missing runtime capability does not block freezing the normative contract or independent schema/publication/Account work, but it does block claiming real source execution readiness.

## 7. Exact schema, dialect and OpenAPI matrix

Accept `openapi` versions 3.0.0–3.0.3 and 3.1.0–3.1.1. Reject Swagger 2, unknown major/minor/dialect rather than treating it as 3.x. OpenAPI 3.0 uses its Schema Object semantics; 3.1 uses the JSON Schema 2020-12/OpenAPI 3.1 base dialect subset below. Standalone Tool schemas may declare `https://json-schema.org/draft/2020-12/schema` or omit `$schema` to select this contract's same subset. Arbitrary `$vocabulary`/custom metaschema rejects. `$id` is recorded as annotation only when it does not change reference base resolution; otherwise reject with an explicit unsupported-feature diagnostic, not a silently different base URI.

| Keywords/features | Exact behavior |
| --- | --- |
| `type` | string/number/integer/boolean/object/array/null; integer means finite integral JSON number; 3.1 unique union array of at most 8 type names. 3.0 array/null type rejects; use nullable below |
| `properties`, `required` | Own-property validation; required unique existing property names; root Tool input object; prototype names treated as data using null-prototype maps, never assignment into host prototypes |
| `additionalProperties` | boolean or schema; absent means true, never silently set false for imported upstream schemas |
| `items` | Single schema only; no tuples; absent means unrestricted JSON elements, still runtime limits |
| `enum`, `const` | JSON structural equality after JCS representation, not coercion; enum unique, nonempty, at most 256; 3.0 `const` unsupported unless explicit equivalent enum normalization recorded |
| `minimum`, `maximum`, `multipleOf` | Finite number values, positive multipleOf; compare decimal values using bounded exact decimal arithmetic derived from the JSON numeric representation; no arbitrary epsilon acceptance |
| `exclusiveMinimum`, `exclusiveMaximum` | 3.1 numeric bounds; 3.0 boolean paired with minimum/maximum; normalize without losing strictness |
| `minLength`, `maxLength` | Nonnegative integers, Unicode scalar counts, min≤max |
| `minItems`, `maxItems`, `uniqueItems` | Nonnegative integers/boolean, min≤max; structural equality for uniqueItems, cost charged to validation budget |
| `minProperties`, `maxProperties` | Nonnegative integers, min≤max; properties count own keys |
| `pattern` | At most 256 ASCII characters; safe linear subset: literals, escaped literals, `.`, bracket classes/ranges, optional start/end anchors, `?`, `*`, `+`, `{m}`, `{m,n}` with bounds≤1024. No groups, alternation, backreferences, lookaround, flags, nested quantifiers or Unicode property escapes. Evaluation must use bounded linear NFA/RE2-equivalent semantics, not host backtracking regex. Unanchored pattern retains search semantics |
| `format` | Assertion for `date`, `date-time`, `uuid`, `email`, `uri`, `hostname`, `ipv4`, `ipv6`; unknown format rejects. Date RFC3339 full-date with calendar validity; date-time RFC3339 offset required, leap seconds rejected; UUID canonical hyphenated hex; email ASCII dot-atom@DNS hostname (no quoted/local/international forms); URI absolute RFC3986 with no controls; hostname ASCII DNS labels≤63,total≤253,no underscore. IPv4 strict dotted decimal, no integer/octal/hex shorthand. IPv6 RFC4291 literal parsing: case-insensitive hex, valid compressed or expanded forms and leading-zero hex groups accepted; no mandatory RFC5952 minimal spelling, brackets or zone IDs. Embedded IPv4 tails use the same strict IPv4 rules. Security destination checks independently normalize and compare binary addresses |
| `allOf`, `oneOf`, `anyOf` | Nonempty 1–8 schemas, max nesting4; validate all branches as necessary with actual all/exactly-one/at-least-one semantics. Never flatten away constraints or take first matching oneOf |
| 3.0 `nullable` | boolean only, requires sibling explicit type; nullable true adds null to allowed type while retaining other constraints such as enum. 3.1 nullable rejects; use null type/union |
| `discriminator` | Object `{propertyName,mapping}` with explicit mapping, only alongside oneOf/anyOf object branches. Every branch requires that property and a disjoint singleton string const/enum tag; mapping resolves exactly once to each branch. Reject overlap/unmapped branch/nonstring tags. Validation still checks original composition, not discriminator alone |
| `$ref`, `$defs` | Acyclic bounded references; JSON Pointer fragments only; `$defs` accepted for 3.1/standalone. OpenAPI 3.0 references use components and permit no validation siblings; reject such siblings rather than ignoring them. 3.1 `$ref` siblings are conjunctive constraints |
| `readOnly`, `writeOnly` | boolean annotations with directional effect: request required excludes readOnly-only properties and present readOnly property rejects; response required excludes writeOnly-only and present writeOnly property rejects. Statically simultaneous both-true annotations reject at import; composed/conditional propagation is specified below. Other structural constraints remain unchanged |
| `default`, `examples`, `example`, `title`, `description`, `deprecated` | Preserve bounded JSON/display annotations; never inject defaults, coerce, strip invalid business members, or treat examples as executable code. Schema validation of defaults/examples produces review warnings, not new authority |
| `x-*` | Preserve as bounded inert annotations, never turn into executable auth or permission instructions |
| Boolean schemas | true/false for 3.1/standalone; 3.0 rejects |
| All other keywords | Unsupported validation/dialect keywords reject affected operation; no silently ignored constraints. In particular `not`, `if/then/else`, `dependent*`, `patternProperties`, `propertyNames`, `unevaluated*`, `contains`, `minContains/maxContains`, `prefixItems`, tuple/additionalItems, `$dynamicRef`, `$recursiveRef`, anchors and content encodings reject |

Budget counts include reused schema evaluation against separate array elements. Reference graph deduplication does not eliminate per-instance validation cost. Invalid schema structure is an import error, not an input that passes because validator cannot interpret it. Bound all regex/string/uniqueness processing; report safe JSON Pointer paths and keyword names without business values.

Directional composition clarification (`0.2.1-m2`, parent approved): determine structurally successful paths before applying the annotated property's presence prohibition; a direction flag must not make an otherwise matching branch disappear from annotation collection. Collect from resolved `$ref` plus conjunctive siblings and all `allOf` conjuncts, the sole successful `oneOf` branch, and every structurally successful `anyOf` branch. `true` dominates `false`; unmatched branches contribute no annotations. Then reject request presence for collected readOnly and response presence for collected writeOnly. Do not let early directional rejection select a writable anyOf fallback. This selection does not bypass nested structural constraints or consume an unbounded second validation pass.

For an absent required property there is no instance to select a conditional branch. Exempt it only when structurally proven directional-only: a direct annotation or conjunctive `$ref`/`allOf` establishes the flag, or every viable `anyOf`/`oneOf` alternative establishes it. Uncertain/mixed alternatives remain required; never insert a dummy value. Proven simultaneous readOnly/writeOnly conjunction rejects import. A conditional overlap producing both flags on successful paths fails directional instance validation rather than silently discarding an overlapping branch. All required branch evaluation counts against existing visit/processing budgets.

Examples: required `x` with `anyOf:[{type:"integer",readOnly:true},{type:"string"}]` remains required; request `x:1` rejects, `x:"a"` is allowed. Two successful integer anyOf branches, one readOnly and one unannotated, still reject request presence. Required `x` with `allOf:[{readOnly:true},{type:"integer"}]` may be absent in a request, but present `x` rejects. These rules preserve full supported composition semantics, not a blanket rejection of composed annotations.

### References and operation review

Local `#/...` references require no extra network permission. External references require exact owner-approved HTTPS origins scoped to this source, the §6 safe transport, limits in §2, strict UTF-8 and safe parser. Canonicalize URLs, resolve relative references against their snapshotted document URL, reject URL userinfo/fragments other than JSON Pointer and unapproved origin transitions. Count root + external bytes once per distinct document; count every reference occurrence; count depth along every dereference chain. Cycles reject. Snapshot source bytes/digests, redirect final URL and resolved graph into draft revision. A remote change cannot alter an already published snapshot.

Root parse/duplicate-key/unsafe YAML, over-limit document/operation graph, forbidden external fetch and structural errors that prevent safe isolation reject the entire import. Unsupported parameter/schema/media in an isolated operation yields a rejected entry and leaves other operations as unpublished accepted entries. Owner must approve the full report's accepted subset; no automatic partial publication. Report rejected method/path/upstream identifier and exact keyword/JSON Pointer plus code, not secret-bearing snippets.

OpenAPI security inheritance is exact: operation security replaces root security; empty array means explicitly unauthenticated only after owner review; alternatives are OR, schemes within an alternative are AND. Map schemes explicitly through `securityMappings`; multiple alternatives require selected `operationOptions.securityAlternative` (zero-based), never select the weakest. Supported security schemes: HTTP bearer/basic, API key in header, OAuth2 authorization-code with trusted registered Provider mapping. Cookie/query API-key injection, mutual TLS and unsupported OAuth flows reject affected operations. Scheme metadata alone cannot authorize arbitrary token endpoints. Each scoped scheme maps to a declared requirement with required operation scopes unioned and checked.

The supported AND subset requires every selected scheme to map explicitly to a distinct Account Requirement and to a noncolliding trusted credential-header injection. Reusing one Requirement for multiple selected schemes rejects the affected operation with `unsupported_feature`; aliases are not silently coalesced or reduced to one scheme. Requirements that inject credentials into the same case-insensitive header (for example Bearer plus Basic in `Authorization`, or two API keys in the same header) also reject before publication. Distinct-Requirement, distinct-header combinations remain supported. Never overwrite or concatenate credentials, degrade AND to OR, or merge requirements merely because current bindings share an Account. The broker independently rejects credential-header collisions before consuming a dispatch budget or sending bytes.

HTTP bearer specifies the wire authentication scheme, not how an Account acquired its credential. Its explicit owner-reviewed `Requirement.methods` may be any nonempty subset of `["bearer","oauth2"]` only when the trusted registered Provider validates the same Bearer-header injection for every listed method. No automatic method expansion or Account fallback is permitted; `none`, `basic` and `api_key` are not bearer alternatives. `bearerFormat` is an annotation, never proof of token identity, issuer, audience or scopes. OAuth2 authorization-code security schemes require exactly `oauth2` and proven actual granted scopes; Basic and header API-key schemes retain exact corresponding method and trusted injection compatibility. Other Account identity, scope and destination restrictions remain unchanged.

Choose one reviewed server URL, with variables replaced by explicit validated values and exact final HTTPS origin. No caller-supplied server variables/URL. Multiple servers or multiple supported request/success media types require explicit selection if they differ; importer may select the sole supported entry and reports all excluded alternatives. Supported response selection covers explicit status/default definitions; do not silently choose a different response contract at runtime.

## 8. HTTP parameter, body and result mapping

Manually authored HTTP operations use the same normalized schema/serialization/security pipeline as imports. HTTP arguments are `{path?,query?,headers?,body?}`; generated location objects admit declared fields only. Omit empty unused locations. No arbitrary URL, auth header or file path override. Parameter identity is `(in,name)` except header names case-insensitive; operation overrides matching path-level parameter. All path placeholders have one declared required path parameter; extra/missing placeholders reject import. Cookie parameters, `allowReserved:true`, `allowEmptyValue:true`, deepObject, matrix, label, spaceDelimited and pipeDelimited reject.

| Location/media | Accepted serialization |
| --- | --- |
| Path | `style:simple`; scalar, scalar array or flat scalar object. explode false array `a,b`, object `k,v,k2,v2`; explode true object `k=v,k2=v2`. Encode each scalar/key RFC3986 before inserting comma/equal separators; slash is `%2F` and rejected if permission matching would become ambiguous |
| Query | `style:form`; scalar `k=v`; array explode true repeats key, false comma-separated; flat object explode true emits property names, false `k=a,1,b,2`. Stable schema/property ordering. Reject collisions with declared query parameters or duplicate expanded keys |
| Header | `style:simple`; same primitive/array/flat-object rules as path; validate no CR/LF/NUL, total request headers≤16 KiB, each value≤8 KiB, no forbidden auth/routing headers |
| Scalars | strings verbatim before encoding; booleans `true`/`false`; finite numbers JCS form; null is unsupported in path/query/header and requires schema rejection rather than stringifying `null` |
| Omission | absent optional parameter produces no pair; empty string produces empty value. Never infer from falsy value. Missing required rejects |
| JSON | application/json or registered `application/*+json`; exact validated JSON, UTF-8, no default insertion. Body absent distinct from null; GET/HEAD requestBody rejected |
| Text | text/plain; string only, UTF-8, no implicit JSON stringify or charset conversion |
| URL-encoded | application/x-www-form-urlencoded; flat scalar fields and scalar arrays only; form explode true, arrays repeat key; UTF-8 form encoding with space `+`, literal `+` `%2B`. Null/nested objects reject |
| Multipart | multipart/form-data; broker-generated boundary, finite fully validated parts, never accept caller boundary/Content-Length. File schema uses artifact reference, scalar fields UTF-8; array of file references creates repeated parts. Only flat scalar/file properties and arrays supported; custom encoding headers reject |

For a primitive query value `a b/+`, form query percent-encoding yields `a%20b%2F%2B`; URL-encoded body yields `a+b%2F%2B`. Query array `tags:["a","b"]` with explode true yields `tags=a&tags=b`; explode false yields `tags=a,b`. Required integer `0` emits `0`. A path scalar with `../` cannot escape a reviewed prefix after encoding/normalization. Multipart names come from reviewed schema, filenames are sanitized §9 and headers are generated by broker only.

Request content encoding supports `identity` only; reject compressed uploads. Send `Accept-Encoding: identity`. Response transport supports identity, complete RFC1952 gzip including valid concatenated members, and one zlib-wrapped deflate stream. Bound aggregate compressed input and aggregate decoded output independently across all gzip members; never reset either allowance per member or silently discard a member. Every member requires valid framing, trailer and checksum. Reject other/stacked encodings, raw deflate, malformed/truncated members, checksum failure and malformed trailing bytes; zlib requires exactly one complete stream without trailing bytes. Count decoded bytes against schema/artifact limits before materializing an over-limit result. The shared decoder must verify complete consumption of the whole supported representation; platform decompressor behavior cannot waive this requirement. Remove decoded `Content-Encoding`/stale length and report total decoded length; core must never decode twice or count compressed bytes as plaintext. If decompression semantics cannot be established, fail `unsupported_result`, not unbounded buffering.

Response must have a reviewed status/media contract. HEAD/204 yields empty content (never invented JSON). JSON validates before presentation; object may populate `structuredContent` with a text JSON representation, array/scalar stays text unless declared object mapping explicitly exists. UTF-8 text yields one text block. Binary yields `{artifact:ArtifactRef}` structured content plus compact JSON text; no model-context base64. Reject malformed UTF-8/JSON, mismatched output schema, event-stream, indefinite body, unreviewed media or unsupported encoding. No silent truncation.

Preserve the complete serialized 1 MiB MCP response cap including fallback and echoed request ID: a 1 MiB raw JSON payload duplicated into text plus structuredContent may not fit and must fail safely, not claim all sub-limit raw payloads are guaranteed presentable. A post-effect limit failure never retries an uncertain write. Known effect evidence remains recorded separately from result availability. Ordinary HTTP failure becomes sanitized `upstream_rejected`/`upstream_unavailable`; do not expose raw Provider body as a gateway error.

## 9. Protected artifacts and storage plan

```ts
type ArtifactRef = {
  artifact_id: string; media_type: string; size_bytes: number;
  sha256: string; filename: string; expires_at: string;
};
// Input file reference is strictly {artifact_id:string}; never trust client metadata.
```

A reference is not a bearer credential. Never return storage paths, public URLs, signed download links, Account IDs or raw binary inline. Optional MCP text URI is `mcpone-artifact:<UUID>`; actual read uses authorized HTTP below. `size_bytes` is decoded plaintext bytes; digest is plaintext integrity hash, protected with metadata; MIME value is a normalized type/subtype without control characters. No trust/execution follows MIME or filename. Filenames are basename-only, remove path separators/control characters, at most 128 Unicode scalar values, empty -> `artifact.bin`; download headers encode safely. Do not execute, render inline, mount, import or sniff artifacts as code. Provider/Integration type allow-lists may narrow broad binary MIME support.

| Method/path | Authorization / result |
| --- | --- |
| POST `/api/control/artifacts?profileId=<id>&grantId=<id>` | Owner, exact active owned Grant/Profile; finite binary body, Content-Type and X-Artifact-Filename; 201 ArtifactRef |
| GET `/api/control/artifacts/:id` | Active organization owner; binary attachment |
| GET `/mcp/:profileId/artifacts/:id` | Same active bearer Grant, organization and Profile associated with artifact; binary attachment |

Owner-uploaded input artifact initially has no producing Run; it is scoped to chosen Grant/Profile, expires after seven days and carries no Account authority. Consumption binds it to an authorized Run and selected Account requirements only after current authority checks. A Run-produced artifact is scoped to its producing Run and frozen Account identities. Reuse in upload requires same active Grant/Profile, authorized producing Run, unexpired content, current eligible destination Accounts, explicit target permission and no cross-Account authority inference. Source Account restrictions remain effective; an Account-disabled artifact cannot become an indirect bypass. Owner inspection uses owner authority but cannot turn a read into an unapproved upload action.

Absent/foreign artifacts return indistinguishable 404 `not_found`; authorized expired content returns 410 `content_expired`; invalid/revoked Grant returns 401/403 with no bytes; malformed reference 400. Range is unsupported (416); no partial unauthenticated reads. Downloads set `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, no permissive CORS; HEAD returns the same authorized metadata without a body. Read paths never schedule/reexecute the producing Run.

**Selected storage: encrypted bounded chunks in the existing D1/SQLite database, no R2 requirement or new service binding.** [D1 maximum BLOB/row is 2,000,000 bytes](https://developers.cloudflare.com/d1/platform/limits/), so a single 25 MiB row is forbidden. Use chunks of at most 512 KiB plaintext; AES-GCM per chunk with fresh nonce and AAD containing format, organization, artifact ID, chunk index and declared total size. Metadata contains exact chunk count, total plaintext length, digest, owner/Grant/Profile/Run/Account provenance, expiry and `staging|ready` state. Chunk IDs unique `(artifact_id,index)`. Encryption key uses a separate artifact-purpose derivation, never public local development keys for real credentials/content.

Write chunks in bounded batches; do not assemble a 25 MiB base64 JSON D1 request or hold an SQL transaction across network I/O. Only atomic final manifest transition makes a complete, verified artifact readable. Interrupted upload stays staging/inaccessible and expires within one hour; scheduler cleanup deletes its chunks in bounded work. A ready artifact must have exactly the declared chunks, authenticated metadata, consistent lengths and digest. Missing/swapped/truncated/corrupted chunk fails closed, never returns partial success. Reads may transfer bounded internal chunks, but the Tool result is a completed protected reference, not streaming business output. Request assembly checks aggregate file bytes/count/overhead before external dispatch and during encoding. Physical multipart buffering must respect host memory admission; do not create five simultaneous 25 MiB buffers in one Worker isolate.

Artifacts expire seven days after completed producing Run or owner upload; active authorized Run may retain necessary input until its existing deadline without extending deduplication. Expiry checks are synchronous even if physical chunk cleanup lags. Record ready-artifact digest/size and safe expired-content audit, not plaintext. Full configurable D13 export/restore remains M4; M2 access, encryption, bounded staging cleanup and expiry cannot be deferred.

This storage plan is source-limit-backed inference, not a measured hosted 25 MiB throughput/memory/quota proof. Acceptance requires actual 25 MiB round trip, 25 MiB+1 rejection, quota/corruption/interruption behavior and multipart aggregate tests on both actual adapters. Current-tier D1 query/storage quotas must be checked before proof; no paid upgrade is authorized by choosing chunks.

## 10. Remote MCP transport and preservation

Use real HTTPS Streamable HTTP, outbound MCP protocol `2025-06-18`; negotiate explicitly and reject incompatible version. Remote endpoint is reviewed exact origin/path, not exposed to Profile callers. Perform initialize, initialized notification, bounded tools/list pagination and tools/call with Broker-selected remote Account credentials. Discovery initialization is permitted only in owner review/refresh; it is not business invocation. Maximum 500 tools and 100 list pages, aggregate manifest 5 MiB; repeated cursor or malformed page rejects. Store upstream names, schema, descriptions, selected protocol and remote session requirements in immutable reviewed snapshot.

Support application/json responses and bounded Streamable HTTP SSE response framing when the remote returns one finite JSON-RPC result: at most 1 MiB decoded event data, 64 events, 10-second discovery / remaining invocation deadline; accept only matching request result, ignore valid keepalive comments, and reject unsupported server requests rather than proxy them. This does not enable legacy HTTP+SSE transport, indefinite subscription or client-facing streaming results. Remote session IDs, if needed, are protected per invocation/discovery session, never reused across Accounts/Grants or echoed to callers. Do not reinitialize/retry a business call automatically after ambiguous session/network failure. Attempt best-effort session cleanup without treating failure as business replay permission.

M2 outbound capabilities advertise no sampling, elicitation, roots, resource subscriptions or native Tasks. Reject server-initiated requests safely with method-not-found, never forward to inbound client. Only text content and object `structuredContent` are normalized in M2; embedded image/audio/resource links/binary blocks or interactive results reject with `unsupported_result` without dropping content. Explicit HTTP artifact Tools handle binary, not an invented pass-through exception. Preserve valid upstream `isError`; preserve safe third-party `_meta` after validation/redaction. Upstream `com.toolcontrolplane/execution` collision is `metadata_collision`, never overwritten. Upstream schema/name collisions must be mapped/excluded during review; runtime output collision retains effect uncertainty.

Inbound MCP keeps M1's exact protocol/negotiation/auth/Origin/Run semantics. To support up to 500 published Tools without exceeding 1 MiB, M2 discovery may return standard `nextCursor`; cursor is opaque, integrity-protected and bound to organization/Grant/Profile/revision, expires in 10 minutes. Page at most 50 Tools and below complete response bound. Invalid/stale cursor gives `invalid_request`, not mixed-revision catalog. No cursor for the unchanged bounded fixture catalog; M1 callers without cursor continue receiving their complete fixture list. Do not claim `listChanged:true` without an implemented tested notification transport; callers may need explicit refresh/reconnect.

## 11. Frozen execution, fingerprints and retry safety

Preserve all M1 states, strict approval/deadline comparisons, current-epoch claim barriers, Grant isolation, owner decisions, terminal immutability and autonomous Node timer / Worker native alarm recovery. The Durable Object stores only alarm metadata. Generic invokers are not a second scheduler, side queue or inline request-only execution path.

Before waiting/dispatch freeze exact original and validated arguments, Tool/Integration revisions and artifact digest, selected Account immutable identities and aliases, approved outbound permissions, server-owned options/budgets, original Profile/policy revisions and immutable approval deadline. Dispatch never swaps Account or revision after default publication changes. Current restrictions additionally require enabled Integration, available frozen revision, eligible compatible Accounts/current scopes and unexpired artifacts. Secret refresh for same identity is permitted only inside frozen capability; growing Provider scopes cannot grow that capability.

For new M2 sources, canonicalize this exact frame using RFC8785 JCS and hash UTF-8 bytes without a trailing newline:

```json
{"version":"m2","organization_id":"org-example","grant_id":"grant-example","profile_id":"profile-example","tool":"github.user.get","tool_revision":"tool-v1","integration_revision":"integration-v1","accounts":{"github":{"account_id":"account-example","identity_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},"options":{},"arguments":{}}
```

Canonical bytes and reference digest (ASCII-only fixture, generated by deterministic serialization and SHA-256; this is vector construction, not implementation conformance evidence):

```text
{"accounts":{"github":{"account_id":"account-example","identity_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},"arguments":{},"grant_id":"grant-example","integration_revision":"integration-v1","options":{},"organization_id":"org-example","profile_id":"profile-example","tool":"github.user.get","tool_revision":"tool-v1","version":"m2"}
f0615d23b84e984445826029b44f40d81f7123c8b88d0902d01674dad10743c3
```

`accounts` maps requirement names to `{account_id,identity_digest}`. Mutable aliases, credential/refresh revision, current scopes/health, request ID, trace ID, timestamps, deadline and caller key are excluded. Arguments are original supplied business JSON before defaults/normalization; future D6 selector is stripped and represented by selected identities. Omitted arguments means `{}`. Options is currently `{}` unless reviewed server-owned execution-affecting options exist; exact pinned defaults are covered by revision. Tool and Integration revisions are included; changing either conflicts under a live key. Same alias on different identity conflicts; same identity with renamed alias or refreshed credential matches and returns original frozen provenance.

The unique key remains `(organization,Grant,Profile,canonical Tool,caller key)`, without revision or Account columns. Atomic initial reservation, seven-day retention and unknown-outcome protection are unchanged. `fixture.counter.increment` keeps exact `version:"m1"` frame/digest and no Accounts; do not rewrite live M1 keys into m2. Per-Run durable fingerprint version tells the comparison path. No namespace-wide reset or grandfathering changed M2 identity against old fingerprints.

Record a durable running claim before invocation and conservative effect barrier before each network send. External effects cannot share the fixture transaction. A network request may complete after cancel/disconnect/crash; stale claim results cannot overwrite final recovery. Restriction checks and current epoch serialize new claims and broker sends; stop after a won send boundary is best effort, not a promise of no effect.

Retries require positive whole-Tool safety evidence or applicable Provider idempotency for every effectful step. Stable Provider retry key is generated and persisted before first send, reused exactly, and bounded by Provider retention/payload/scope guarantees. One idempotent request does not make a multi-request custom Tool safe to rerun. Maximum three attempts share first-attempt execution deadline and 30-request budget; exponential delays 1,000 ms then 2,000 ms, capped by remaining deadline and safe `Retry-After` (maximum 60,000 ms). No retry just because status is 429/500, annotation is readOnly, socket reset, response was oversized, or process restarted. After possible uncertain write, terminal `outcome_unknown`, nonretryable, inspect/reconcile; explicit manually requested retry is a newly authorized linked invocation, not a hidden resume.

## 12. Metadata, errors and complete transport mapping

Request `_meta["com.toolcontrolplane/execution"]` remains strict optional `idempotency_key`/`trace_id`, each 1–128 printable ASCII U+0020–U+007E, no trimming/case folding. Result namespace remains exactly `{run_id,tool,accounts?}` with requirement-keyed frozen authorized aliases; omit accounts when none. No internal Account IDs, trace IDs, revisions, duration, Profile or policy data. No new version field in this envelope.

Every attributable result appends final text content with exact prefix `Tool Control Plane execution: ` and compact M1 `RunControl` JSON `{run_id,tool,accounts?,status,approval_url?,error?}`. Preserve business schema/result instead of wrapping `{data,gateway}`. `pending_approval`, `queued`, `running` use `isError:false` but do not claim business success. Approved waiting work survives disconnect and scheduler recovery. `runs.get` requires same active Grant/Profile/organization and never resolves credentials, invokes, refreshes deadline or creates another business Run. Owner read remains HTTP 200 with a Run's `error` field; that is not a transport failure.

A live-key fingerprint mismatch, including a changed published Tool or Integration revision, preserves M1's attributable `idempotency_conflict` Tool error: HTTP 200 with a normal MCP `result`, `isError:true`, no business output, and the original Run ID in both result provenance and `RunControl.error.run_id`. The receipt keeps the original Run's status and approval link; it does not persist the conflict as that Run's outcome or change its frozen revision, payload, deadline, reservation expiry or approval requirement. The owner-status table below is not a JSON-RPC transport mapping. Matching-key retrieval and explicit `runs.get` remain authoritative.

`ExecutionError` retains strict M1 fields `{code,message,retryable,run_id?,retry_after_ms?}`. `message` max512 Unicode scalar values, safe static/actionable text; `retry_after_ms` integer 0–60,000. Do not add category/remediation fields that violate existing strict clients: the stable code catalog supplies category, message supplies safe action, and authorized inspection may contain separately modeled diagnostics. Never put upstream body, raw credential, SQL, stack, ciphertext, private resource ID or foreign Run correlation in these fields.

| Codes (exact enumeration) | Category / default owner HTTP status / action |
| --- | --- |
| `unauthenticated` | Auth / 401 / authenticate |
| `forbidden`, `grant_revoked`, `grant_expired` | Access / 403 / obtain current permitted Grant; no retained content leakage |
| `not_found` | Lookup / 404 / verify owned resource; absent and inaccessible identical |
| `invalid_request`, `invalid_arguments` | Validation / 400 / correct safe indicated field/path |
| `unsupported_protocol`, `unsupported_feature`, `unsupported_schema` | Compatibility / 400 / use supported version/feature/schema; do not relax validation |
| `import_invalid`, `reference_forbidden`, `reference_limit`, `schema_limit` | Import / 400 / repair document or reviewed source settings; unsafe graph rejects whole import |
| `name_collision`, `metadata_collision` | Contract collision / 409 / explicitly map/exclude, never overwrite |
| `publication_conflict` | CAS / 409 / revalidate latest draft and review impact |
| `integration_disabled`, `tool_unavailable`, `profile_disabled` | Current restriction / 409 / owner repair/enable then new authorized invocation |
| `account_missing`, `account_disabled`, `account_incompatible`, `account_scope_required`, `account_identity_changed` | Account / 409 / select/repair exact eligible Account or explicit scope consent; no fallback |
| `account_expired`, `account_revoked`, `credential_unavailable` | Credentials / 409 / reconnect/rotate same identity; no secret details |
| `oauth_unavailable` | Setup / 503 / install supported registration, not fake token flow |
| `oauth_state_invalid`, `oauth_consent_denied` | OAuth / 400 / restart explicit owner connection flow |
| `broker_forbidden` | Egress / 403 / review denied destination/method/path; no guessed credential target |
| `payload_too_large` | Size / 413 / reduce input/output; post-effect uncertainty still recorded |
| `rate_limited`, `capacity_exceeded` | Admission / 429 / bounded advisory wait, no uncertain-write retry permission |
| `idempotency_conflict` | Dedupe / 409 / inspect original Run; do not reuse key for changed action |
| `policy_blocked`, `approval_denied`, `approval_expired`, `canceled` | Execution control / 409 for failed mutation, 200 Run inspection / no automatic retry |
| `upstream_rejected` | Provider / 502 / safe account/request remediation; not proof of no effect |
| `upstream_unavailable` | Provider / 503 / guarded retry only with independent effect safety |
| `unsupported_result` | Result / 502 / inspect Run and known effect; never silently truncate |
| `execution_failed`, `execution_timeout`, `sandbox_limit` | Runtime / 502 / safe diagnostics; uncertain writes override status to outcome_unknown |
| `outcome_unknown` | Uncertainty / 200 Run inspection / inspect/reconcile, never automatic retry |
| `content_expired` | Retention / 410 artifact retrieval, 200 Run inspection / safe audit only, never refill by execution |
| `internal_error` | Internal / 500 / safe request correlation, no implementation details |

All codes default `retryable:false`. Only independently verified safe retry or rate/capacity rejection before admission may set true; internal retry uses the same frozen Run. An attributable accepted invocation returns HTTP 200 with normal MCP `result`, `isError:true`, gateway fallback error and recorded Run, not JSON-RPC exception merely because the Provider failed. Unknown outcome is never converted to `failed` for convenience.

Transport/protocol rejection before attributable acceptance: malformed JSON HTTP400 / JSON-RPC -32700; invalid request -32600; unknown method -32601; malformed params/metadata -32602; internal -32603. Origin/auth failure HTTP401/403; media negotiation HTTP415/406; wrong method HTTP405+Allow; oversized preacceptance HTTP413; unsupported MCP version HTTP400. JSON-RPC error data carries `ExecutionError` where safe, no invented Run. If a malformed/unauthorized request cannot safely associate a Run, return no provenance. Correlation ID bounds and compact null-ID fallback remain M1. Requests rejected for current Tool/account eligibility after authenticated well-formed invocation have a durable attributed blocked/failed Run; malformed transport does not fabricate organization identity.

### Representative result examples

Success with two requirements (business output unwrapped):

```json
{"content":[{"type":"text","text":"{\"released\":true}"},{"type":"text","text":"Tool Control Plane execution: {\"run_id\":\"run-example\",\"tool\":\"release.notify\",\"accounts\":{\"source\":\"GitHub Test\",\"notify\":\"Slack Test\"},\"status\":\"succeeded\"}"}],"structuredContent":{"released":true},"isError":false,"_meta":{"com.toolcontrolplane/execution":{"run_id":"run-example","tool":"release.notify","accounts":{"source":"GitHub Test","notify":"Slack Test"}}}}
```

Pending uses no business output and the same final fallback with `status:"pending_approval"` and authenticated relative `approval_url:"/api/control/runs/run-example"`; it is not a token-bearing link. Block/denial/expiry use their M1 status plus catalog error, no invented upstream output. For uncertain writes use `status:"outcome_unknown"`, `isError:true`, `error:{code:"outcome_unknown",message:"The upstream action may have occurred. Inspect and reconcile before requesting another invocation.",retryable:false,run_id:"run-example"}`. An idempotency conflict correlates original Run, code `idempotency_conflict`, retryable false, and never substitutes a new effect. Binary success's business object is `{"artifact":{"artifact_id":"00000000-0000-4000-8000-000000000001","media_type":"application/octet-stream","size_bytes":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","filename":"artifact.bin","expires_at":"2026-10-15T00:00:00.000Z"}}`; digest is the public bytes `abc`, not private payload evidence.

## 13. Migration, first Provider and acceptance fixtures

Add ordered migrations; never edit an applied migration. Introduce Integration/revision/manifest, Account/credential, Profile binding/revision, per-Run selected identities/result-format/fingerprint-version/effect budget and artifact/chunk records with organization-scoped foreign keys/indexes. Backfill existing fixture definitions/rows with explicit source/revision values and `m1` fingerprint/result format without changing historical IDs, ciphertext AAD, Grants, deadlines, key expiry, fixture effects or policies. Keep live M1 keys and pending Runs valid. New health readiness includes all new required tables/columns; mixed old binary/new additive schema remains safe until publication cutover. No request/startup migrations. No new Run queue, external exactly-once ledger claim or database-copy restore assumption.

Sole approved unreleased-draft exception: [DET-1390](https://linear.app/detzel/issue/DET-1390) authorizes parenthesizing four `CASE` expressions in `0004_m2_artifacts.sql` for native D1 parsing, without changing guards or the atomic SQL/ledger batch. Native-applied `0000`–`0003` hashes/timestamps remain unchanged; the corrected `0004` and `0005` now apply to the same isolated native database. Retain prior disposable local databases and use fresh paths rather than rewriting their old ledgers. This decision does not authorize future edits to now-applied migrations.

Choose **GitHub** as first real Provider proof plan: a dedicated disposable test user with minimal authorization; TypeScript and HTTP GET `https://api.github.com/user`; official remote endpoint `https://api.githubcopilot.com/mcp/`, reviewed `get_me`. [GitHub's integration guide](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md) documents PAT or OAuth access token acceptance and no dynamic client registration. [Official get_me implementation](https://github.com/github/github-mcp-server/blob/main/pkg/github/context_tools.go) uses the authenticated `/user` identity and `NoScopes()`. These are real authorized operations, unlike public unauthenticated URL reads or our own fixture. A trusted GitHub adapter may explicitly verify compatibility of that supported token class for the two fixed resource origins; do not infer arbitrary remote-MCP/API token interchangeability.

Use a separately registered **GitHub OAuth App** with expiring tokens for the minimal combined OAuth/refresh/resource-scope-upgrade proof. Current [OAuth App authorization documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) explicitly supports PKCE S256 and `offline_access` (or an app setting) to obtain an eight-hour access token plus a rotating refresh token that expires after six months without use. The earlier assumption that OAuth Apps cannot refresh is obsolete; it must not force a new Provider or make resource-scope upgrade unreachable. Hosted registration and local BYO registration/callbacks/consent remain external prerequisites. Existing personal `gh` credentials, production secrets and mounted MCP OAuth connections are not disposable app credentials; no borrowing is authorized. Real six-cell reads, OAuth/refresh/upgrade, and write-uncertainty proofs remain distinct observed gates.

GitHub **App** user tokens may remain separately supported using their actual empty resource-scope claims; their fine-grained app permissions are not OAuth scopes and cannot prove incremental OAuth resource-scope consent. The selected GitHub **OAuth App** flow instead verifies actual resource scopes from its token response and trusted Provider evidence. [GitHub's scopes documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) describes normalized granted scopes, user reduction of requested scopes and reauthorization for additional permissions. Store actual grants, not requested strings; `offline_access` selects expiring-token acquisition and is not a resource permission. Do not infer method, identity, scope or refresh capability solely from a token prefix. Pin actual REST API version in implementation/evidence (current primary-doc example: `2026-03-10`).

For a minimal non-mutating upgrade, authorize `read:user` plus `offline_access`, keep an explicitly published read Tool working, then request `read:user user:email offline_access` for a separately reviewed email-read Tool. Before new consent that Tool is unavailable; denied/insufficient consent preserves the old valid credential and read operation; afterward verify the new actual scope and same remote identity/application before replacing the credential atomically. A separately reviewed `gist` operation on a dedicated disposable identity is an alternative when a write-scoped proof is specifically needed. No broad `repo` scope, new hosting, borrowed identity or new Provider is necessary for this plan; no capability is proven merely by registering the intended scopes.

Scope aliases/normalization belong to the trusted Provider: parse the actual comma-delimited OAuth scope response and authoritative `X-OAuth-Scopes` evidence, preserve normalized actual grants, and apply only explicitly documented inclusion relations when checking required permissions (for example, `user` subsumes `user:email` and `user:follow`). Never manufacture extra entries in stored granted scopes, infer arbitrary prefix/wildcard relations or map GitHub App permissions to OAuth scopes. Explicitly request the still-needed and additional resource scopes on upgrade rather than relying on omitted-scope behavior, which can reuse previously granted permissions.

Refresh uses the fixed GitHub token endpoint with `grant_type=refresh_token`, client registration and the current protected refresh token. It cannot request additional scopes: the replacement access token preserves previous scopes. Successful rotation invalidates both old tokens, so serialize refresh and atomically persist the new pair with credential-version CAS. Treat documented `bad_refresh_token` as reconnect-required, not a blind retry. Verify every newly acquired/refreshed token's immutable user identity and application binding; the trusted [application token-check endpoint](https://docs.github.com/en/rest/apps/oauth-applications#check-a-token) exposes actual scopes, user and `app.client_id`, and requires [application client-ID/secret Basic authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api#using-basic-authentication). Its credential-bearing request/response stays entirely inside native Provider custody. GitHub App and OAuth App flows must retain their distinct verified claims; a switched subject/application or missing expected scope never silently satisfies a prior binding.

### Required machine-readable/conformance cases

Sol owns executable fixtures; parent owns final verification. These IDs define minimum observable assertions, not current test files or pass claims:

| Family | Required positive and negative cases |
| --- | --- |
| M2-SCHEMA | Every supported keyword and both dialects; min/max boundaries; oneOf zero/one/two matches; anyOf true union; allOf contradiction; nullable enum interactions; readOnly/writeOnly direction; unknown keyword/format; pattern complexity; cyclic/escaped refs; depth10/11, branch8/9, composition4/5, visit100000/100001; duplicate keys/prototype names/invalid Unicode |
| M2-IMPORT | JSON and safe YAML; 5MiB/+1, operation500/501, mixed accepted/rejected report; unsafe whole graph rejection; approved/unapproved external origins; aggregate/ref/document/redirect/time boundaries; frozen reference snapshots; explicit security AND/OR selection, media/server selection, naming collisions; manual HTTP parity |
| M2-PUBLISH | Draft invisible/noncallable; validation zero business effects; stale report/epoch rejected atomically; new/changed/removed Tools staged; affected Profiles preview; no unrelated membership/policy changes; retained pending revision; unavailable revision blocks; rollback limitation; disable race before claim |
| M2-ACCOUNT | Two same-Provider identities; user vs Workspace eligibility; issuer/audience/tenant/app/method/scope mismatch; missing binding no fallback; multiple requirements; fixed override rejection; alias-only/credential refresh preserve frozen identity; identity swap blocks; concurrent refresh/version CAS; revoked/expired/disabled waiting work; scope upgrades preserve unrelated reads and control-plane authority |
| M2-OAUTH | Real registered hosted/local flow, one-use state+PKCE, owner/session/org binding, expired/foreign callback, rejected return URL, denied consent, incremental actual scopes, refresh same identity, changed subject/tenant rejects, rotated credential race, local operation without shared broker; absence of registration reported blocked, not mock pass |
| M2-HTTP | Exact path/query/header/form vectors, zero/false/empty/absent, unsupported styles/media; auth header collision; redirects and scope boundaries; JSON/text/HEAD/binary; finite chunked body; SSE/infinite/oversized/malformed result; unsupported postwrite result retains effect evidence |
| M2-ARTIFACT | Real25MiB/+1 and zero-byte artifacts on SQLite/D1; read/upload10/11 files and aggregate25MiB/+1; MIME overhead boundary; foreign org/Grant/Profile/Run/Account denial; active Grant revocation; expiry410; no public URL; attachment/no-sniff; interrupted staging hidden; chunk reorder/tamper/length/digest reject; memory/quota bounds |
| M2-SANDBOX | Valid TypeScript and bundled pure-JS module; no secrets/env/files/network/host constructors; malicious dependency/dynamic import; infinite loop/Promise storm/memory bomb/regexp; preallocation heap cap and interrupt deadline; broker-only request; ignored guest effect claim; request30/31 across retries; credential echo/log redaction; denied origins/method/path/redirect/private/DNS-rebinding targets |
| M2-MCP | Actual remote initialize/discovery/call; cursor/session isolation; result content/structuredContent/isError/third-party metadata preservation; reserved namespace collision; server sampling/elicitation refused; unknown binary/resource block rejects; no frontend client registration of upstream URL; frozen manifest vs actual remote pinning limitation |
| M2-FINGERPRINT | Published m1 digest unchanged; m2 JCS bytes/hash on both adapters; reordered keys/whitespace same; changed arrays/type/Tool/Integration/Account identity/options conflicts; alias/trace/token refresh same; original alias retained; concurrent reservations one Run; seven-day expiry warning |
| M2-SAFETY | Allow/Ask/Block each source; approve after disconnect; actual restart/native alarm resume frozen Account/revision; restrictions at claim and broker; definitive safe retry max3, provider-idempotent stable key where real guarantee exists; external after-effect loss ->unknown, no reexecute on retrieve/duplicate/restart; oversize timeout never false no-effect |
| M2-PARITY | Six real authorized cells (three source types × actual Node SQLite and isolated hosted D1); M1 full nonregression; no Wrangler/unit-only substitution; complete wire response bound with long valid ID/provenance; redacted evidence and no production mutation |

Record source/Provider identity class (not credential), contract/compiler/engine/protocol/build versions, real runtime and isolated database/resource identifiers, safe Run/effect IDs, exact assertions, pass/fail/blocked and cleanup. Mark controlled clock/fault fixtures separately from actual restart/elapsed/native-alarm/Provider observations. Parent performs `pnpm check`, real local app + `pnpm smoke`, no-upload `pnpm cf:check`, changed-path and actual hosted parity after integration. This contract author ran none of those checks and claims none.

## 14. Readiness and outstanding approval/prerequisite ledger

| Surface | Readiness represented by this document |
| --- | --- |
| Schema/HTTP mapping, Accounts/publication/fingerprint/result interfaces | Frozen normative matrix after parent review and Sol fixture-expectation alignment; executable implementation and passing conformance are separate gates |
| TypeScript mechanism | Prior QuickJS execution/resource-denial observations are not strict native 100ms CPU proof. The nominal Loader probe consumed 2.1 seconds; the hard requirement remains unchanged and deferred. Under the approved scope cut, the unaccepted Worker Loader adapter/carrier/bindings are removed and current Worker TypeScript execution explicitly returns `tool_unavailable` without guest evaluation. Direct Node QuickJS remains for local behavior. Existing native proof code/controller are unchanged; no compliant strict executor or native rollout is claimed |
| Derived metadata budget | Human-approved 8MiB canonical budget and unchanged raw input limits; actual Node and isolated native owner APIs reject the full oversized derived revision with 413 and preserve existing published authority |
| Hosted safe egress | Actual normal Node/native published TypeScript and reviewed HTTP Sources traverse the trusted broker, numeric pinned TCP and Mbed TLS and return real public results after frozen Ask approval and a 70-second interval with no owned-client application HTTP. Native expired-certificate denial is permanent, returns no business output and records one attempt/`verified_no_effect`. Fixed-DoH native transport uses supported manual redirect handling and rejects every non-200 response; no insecure business-fetch fallback. These anonymous checks do not satisfy the six authorized Provider cells or the complete owned fault/redirect security matrix |
| Artifacts | Actual Node/native APIs round-trip zero-byte, 19-byte and 25MiB artifacts and reject 25MiB+1. Owned nonce, missing-chunk, reorder, truncated-length and ready-digest negatives fail closed on both runtimes. Interrupted Node staging is protected-invisible and automatically removed after real expiry/restart; the offline +75s observer failed, so uninterrupted-online cleanup timing is not established. Confirmed-TLS native partial upload admits no observed staging row; native inside-spool cleanup remains unproved. Actual seven-day expiry is explicitly deferred and its waiting verifier stopped; no 410 pass is claimed. Inline HTTP credential redaction is being verified; authenticated raw binary/artifact output is unaccepted and retains an inspected potential disclosure risk. Remaining memory/quota and multipart acceptance are separate |
| M1/restart/current authority | Actual Node restart and isolated native redeploy resume pass all embedded M1 regression gates, real 15-minute approval/dispatch expiry and durable queue/claim recovery. Separate Node/native membership-resume proofs pass role/removal and subsequent denial assertions. Harness-local 70-second no-HTTP intervals are observed; overlapping parent harnesses do not establish globally zero application HTTP |
| Provider and OAuth | Authorized six-cell GitHub matrix, independent OAuth registration/consent and actual refresh are explicitly deferred under the approved scope cut. Tickets remain open; no healthy Account or Provider proof is fabricated and no credential handoff is pursued in this pass |
| Acceptance/freeze | Reduced-deliverable `--phase=surfaces` completes actual direct-Node protected-artifact, all eight broker denial/redirect, and multipart media/size/isolation/binary-result gates with no failed gate. Overall status remains pending (exit 2) for explicit full-M2/elapsed-retention deferral, not acceptance success. Controlled fault safety also passes on Node and prior local workerd. Current reduced-build `pnpm check` passes 927 tests plus builds; no-upload validation is 8,233,768 serialized bytes. Real local Worker M1 fixture dispatch succeeds and M2 TypeScript fails closed once/`not_dispatched`/zero outbound requests. Newly owned fault app, managed database/role, both attached domains and the two exact-owned DNS records are deleted; existing native proof/controller/production are untouched. Private fixture source repository remains as non-running provenance (mounted tools provide no repository-delete capability). Inline HTTP credential disclosure regressions pass; authenticated raw binary output remains unaccepted as noted above. Strict CPU, authorized Provider/OAuth and elapsed retention remain open in DET-1390; this is not completed M2 |

Meaningful architecture/lifecycle/security/cost/client changes require human decision. Engineering may refine internals within these reviewed contracts but cannot quietly increase authority, reduce the required source matrix, downgrade hard isolation or call a mock a real Provider proof. No M3/M4 scope expansion, production deployment, paid upgrade, commit or push follows from this contract.
