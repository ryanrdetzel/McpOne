# M1 execution contract — 0.1.1-m1

## Authority and scope

This document freezes the **M1 execution subset**, not the full D12 contract or an MVP launch certification. Its machine-readable companion is `packages/schema/src/execution.ts`, exposed as `@scaffold/schema/execution`. The approved [M1 brief](https://app.notion.com/p/3f32eecf0b3f8125b521d2d7b8673a1f), [PRD v1.1](https://app.notion.com/p/3f32eecf0b3f81d58d2ec4e24d740d1f), [D12 draft](https://app.notion.com/p/3f32eecf0b3f81ab874fd78566db1797), and repository [architecture](../ARCHITECTURE.md) remain authoritative. Work is tracked by [DET-1376](https://linear.app/detzel/issue/DET-1376).

M1 proves a deterministic fixture, stable Profile, separately labeled Grant, Allow/Ask/Block, owner approval, immutable replay, durable execution and duplicate/uncertain-write safety on direct Node/SQLite and Workers/D1. OpenAPI schema/import matrices, external Accounts/providers, federation, authoring, artifacts, OAuth client certification, notifications and the full D12 freeze remain later-milestone work. M1 specifies compatible seams without claiming those features exist.

The following requirements are normative; they are not test results. Observed acceptance evidence must separately identify the exact revision, runtime, isolated database, client build, protocol version and conformance results. Parent integration owns verification; authoring this contract does not prove either adapter passes it.

### Revision record

- **0.1.1-m1:** bound string JSON-RPC correlation IDs to 1–128 characters and enforce the complete serialized UTF-8 response limit. Review reproduced a sub-limit request whose echoed ID pushed discovery above 1 MiB. Oversized IDs now fail before dispatch with a compact null-ID error; oversized receipts preserve their authoritative Run and prohibit effect replay. Migration: use a short correlation ID or a safe integer; business idempotency keys remain unchanged. No required-client certification existed for the earlier M1 subset. Decision and regression proof: [DET-1376](https://linear.app/detzel/issue/DET-1376).
- **0.1.0-m1:** initial frozen execution subset.


## Wire subset

- Endpoint: **`/mcp/:profileId`**, stable across Tool/policy changes and ordinary client restarts. Authenticate every request with a Profile-scoped bearer Grant; the Profile URL is not a credential. A separately authorized connection gets its own owner-confirmed label and Grant. Copied credentials remain the same Grant, not a newly identifiable device.
- Transport: [MCP Streamable HTTP, protocol `2025-06-18`](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). The supported M1 version window contains this one version. No legacy HTTP+SSE, stdio, native Tasks, server-push notification, resumable SSE, or MCP transport-session capability is claimed.
- POST accepts one UTF-8 JSON-RPC 2.0 request or supported notification, not a batch. Clients send `Content-Type: application/json` and `Accept: application/json, text/event-stream`. Responses to requests are JSON, never streamed. IDs are safe integers or strings of 1–128 characters; `null` and out-of-bound strings are not M1 request IDs. Invalid IDs are rejected with a null-ID transport error, never echoed. JSON-RPC IDs correlate transport responses and **do not** deduplicate business work.
- `initialize` accepts MCP `protocolVersion`, `capabilities`, and `clientInfo`. It returns supported version `2025-06-18`, server identity and `capabilities: {"tools":{"listChanged":false}}`. If a requested version differs, the returned supported version is an explicit negotiation offer, not a compatibility claim. A client unable to use it must disconnect.
- Post-initialization requests carry `MCP-Protocol-Version: 2025-06-18`. Unsupported values return HTTP 400. A missing header outside initialization also returns 400: the stateless subset cannot infer a negotiated session, and the transport's older `2025-03-26` fallback is outside this explicitly bounded M1 window.
- `notifications/initialized` is accepted with HTTP 202 and no response body. `ping` may return an empty result. Unknown request methods return JSON-RPC `-32601`; unsupported notifications are not treated as invocation requests and cannot dispatch work. Never respond to a notification with a fabricated request ID.
- GET and DELETE on the MCP endpoint return HTTP 405, `Allow: POST`: no SSE stream or transport session to delete. No `Mcp-Session-Id` is issued. Disconnecting, dropping HTTP responses or ending a transport session **never cancels durable approved work**.
- Check any supplied `Origin` against the exact trusted origin. Reject a foreign or `null` origin. A non-browser bearer client may omit Origin. Local direct-server delivery binds loopback by default. Never use a permissive CORS response to bypass origin checks; apply origin validation before all MCP method dispatch.
- Bound input and direct output to 1 MiB. Return a safe explicit size error. An oversized or lost result after a possible effect does not prove failure or authorize retry.

### Discovery and invocation

`tools/list` returns only currently visible Tools from the active Grant's Profile plus the non-business `runs.get` retrieval Tool. Visibility is not policy: a visible Tool can still Block or Ask. Guessed names are rechecked at invocation and cannot bypass membership, organization or Grant restrictions. M1 does not paginate its bounded fixture catalog; cursor fields are unsupported rather than silently ignored.

Business Tool name: **`fixture.counter.increment`**. Its strict business arguments are:

```json
{"value":1,"note":"public fixture"}
```

`value` is a safe JSON integer, defaulting to `1`; `note` is an optional string. The optional `fault` enum is `safe_before_effect`, `after_effect`, or `crash_after_claim`. These are openly advertised deterministic **fixture semantics**, not hidden authentication headers, special credentials, arbitrary sleeps, or a test-only permission bypass. They run through precisely the same membership, policy, approval and durable claim path as an ordinary fixture invocation. Never copy this failure-control surface into production external integrations.

An observable fixture effect ledger has one unique row per Run. Its committed counter delta is the invocation's frozen `value`; the independently observable **write count** is the number of committed effect rows, not the delta sum. A zero or negative delta cannot conceal duplicate effects. The fixture has no external Account, so omit `accounts` from result metadata.

`tools/call` uses standard MCP params (`name`, `arguments`, optional `_meta`):

```json
{
  "jsonrpc":"2.0",
  "id":"call-1",
  "method":"tools/call",
  "params":{
    "name":"fixture.counter.increment",
    "arguments":{"value":1,"note":"public fixture"},
    "_meta":{"com.toolcontrolplane/execution":{"idempotency_key":"example-call-1","trace_id":"example-trace"}}
  }
}
```

Every well-formed authenticated business invocation is durably tracked, including denial, a guessed Tool name, and changed restrictions. A duplicate refers to its existing logical Run rather than creating another effect. Idempotency conflicts retain correlation to that Run and an auditable denial; they never dispatch a second Run. Malformed transport or unauthenticated requests receive safe errors and security/request correlation without inventing an organization, assigning somebody else's Run, or exposing foreign Run data. Infrastructure failure to persist a Run fails closed before dispatch; never imply that an unpersisted invocation was accepted.

### Reserved metadata

The gateway exclusively owns **`_meta["com.toolcontrolplane/execution"]`**.

- Request: exactly optional `idempotency_key` and `trace_id`; each, when present, is a string of **1–128 printable ASCII characters, U+0020 through U+007E**. Preserve spaces and case exactly. Reject empty strings, controls, non-ASCII values, invalid types and unknown namespace fields. Absence is valid. Do not move these fields into business arguments or add legacy `_idempotency_key` aliases.
- Result: exactly `run_id`, canonical `tool`, and optional `accounts`, mapping Account Requirement name to authorized friendly alias. No `status`, revision, schema version, Profile/Grant IDs, policy details, timing, internal Account IDs, credentials or trace IDs in this namespace. Omit `accounts` when no Account was selected.
- Other owners' `_meta` keys are separate and must not be overwritten. An upstream response claiming the gateway-owned namespace is a collision, not permission to merge untrusted provenance; reject or explicitly map it before use. M1 has no upstream federation.

### Results and fallback

Keep MCP `content`, optional `structuredContent`, and `isError`. Business `structuredContent` retains the Tool's own result shape; do not wrap it in a gateway-specific structure or invent extra top-level MCP fields. Every attributable Tool result carries validated result metadata and a **separate final text content block** with this exact prefix:

```text
Tool Control Plane execution: 
```

Append compact JSON conforming to `RunControl`: `run_id`, `tool`, optional `accounts`, `status`, optional `approval_url` and optional `error`. This fallback is always emitted in M1, so clients that hide metadata can still retrieve the Run. Do not mix it into the upstream business text or claim that clients without request-metadata carriage support can supply idempotency keys.

Pending example (identifiers are public examples):

```json
{
  "jsonrpc":"2.0",
  "id":"call-1",
  "result":{
    "content":[{"type":"text","text":"Tool Control Plane execution: {\"run_id\":\"example-run\",\"tool\":\"fixture.counter.increment\",\"status\":\"pending_approval\",\"approval_url\":\"/api/control/runs/example-run\"}"}],
    "isError":false,
    "_meta":{"com.toolcontrolplane/execution":{"run_id":"example-run","tool":"fixture.counter.increment"}}
  }
}
```

`approval_url` is a same-origin authenticated owner inspection link. It contains no bearer token and a GET never approves. A waiting result is not success of the business action; `isError:false` only means the durable waiting request is accepted. `queued` and `running` likewise do not claim completion. `succeeded` includes business output. `denied`, `blocked`, `expired`, `canceled`, `failed` and `outcome_unknown` return `isError:true` with safe error information; uncertain outcomes explicitly warn that an effect may already exist.

Invoke retrieval through normal MCP discovery:

```json
{"jsonrpc":"2.0","id":"poll-1","method":"tools/call","params":{"name":"runs.get","arguments":{"run_id":"example-run"}}}
```

`runs.get` returns the stored status/result and original business Tool provenance; it does not acquire an execution claim, refresh an approval deadline, create a business Run, invoke the Tool, or advance a retry. Access requires the **same active Grant**, organization and Profile as the Run, including after completion. A different Grant on the same Profile cannot read it. Unknown and inaccessible IDs have the same safe not-found response. Revocation or Grant expiry prevents all later retrieval; the organization owner retains historical inspection. A retained audit record with an expired payload returns `content_expired`, not a fabricated empty result. No conversation auto-resumption is promised.

## Idempotency and canonical fingerprint

The deduplication index is unique on `(organization, Grant, Profile, canonical Tool, caller key)`, retained for **seven days from first reservation**, without extending it on polling or redelivery. The Tool revision belongs in the fingerprint, **not** in the unique key: changing revision under a live key conflicts rather than allocating a fresh Run. No caller key means a new logical invocation; retrying a non-keyed call is not guaranteed safe. After expiry, key reuse can produce a new effect and must not be recommended as a safe retry.

The first reservation is the winning atomic SQL admission, not an earlier pre-crypto or pre-I/O application timestamp. Freeze creation, payload expiry, deduplication expiry and any Ask deadline from that admission clock, with a database-clock floor. Slow reads, encryption or epoch retries cannot shorten the seven-day window.

Known Tool identity is independent of current membership eligibility. Disabled or removed membership must not discard a valid scoped key: retain the original denial/Run on matching redelivery and reject differing fingerprints, including after membership is restored. Active Grant/Profile read authorization still applies.

Resolve current execution identity and validate the request before comparing an existing key. Canonicalize the following exact `FingerprintPayload` frame using [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785), hash its UTF-8 bytes with SHA-256, store **64 lowercase hex characters**:

```json
{
  "version":"m1",
  "organization_id":"org-example",
  "grant_id":"grant-example",
  "profile_id":"profile-example",
  "tool":"fixture.counter.increment",
  "tool_revision":"fixture-v1",
  "accounts":{},
  "options":{},
  "arguments":{"value":1,"note":"public fixture"}
}
```

`accounts` is the selected requirement-to-internal-Account-identity map, not mutable friendly aliases. M1 has no Accounts or caller execution options, so these two fields are `{}`; do not omit them. `arguments` is the original JSON business argument object (omitted arguments means `{}`), before schema defaults are applied. Freeze executable validated arguments separately. Thus `{}` and `{"value":1}` may behave alike but deliberately have different fingerprints. Include server-owned execution-affecting options when they exist; do not let clients smuggle them into the request namespace. `trace_id`, caller key, request ID, mutable alias, creation time and approval deadline are excluded.

Canonical bytes of the example, with no trailing newline:

```text
{"accounts":{},"arguments":{"note":"public fixture","value":1},"grant_id":"grant-example","options":{},"organization_id":"org-example","profile_id":"profile-example","tool":"fixture.counter.increment","tool_revision":"fixture-v1","version":"m1"}
```

Expected SHA-256:

```text
8cd9a3ce89fd376830423a084000fa13e1062c3fb8d590e228794b4c0562f8fe
```

Object ordering and whitespace do not matter; array order, JSON types, identity, selected binding, options, revision and argument values do. Use ECMAScript-compatible JCS number serialization and UTF-16 property ordering, not locale sorting or a homegrown vaguely sorted JSON convention. Reject nonfinite numbers and lone Unicode surrogates in keys or values. The JSON parser must also reject duplicate property names before object construction; a Zod schema cannot recover duplicates already discarded by `JSON.parse`. JCS normalizes legal numeric representations, including negative zero, as specified; it does not normalize Unicode text. The shared `JcsValue` and `FingerprintPayload` schemas validate representability, not canonical serialization or hashing.

A live scoped key with matching fingerprint returns its original Run, with current read authorization. A differing fingerprint gives `idempotency_conflict`, never dispatch. Concurrent first insertions must converge through a database uniqueness constraint, not a read-before-insert check or a process-local mutex. Resolve publication/revision races using one consistent configuration snapshot or an epoch compare-and-swap; returning an old Run for changed current revision is not a match. Index expiry and replacement must be atomic so two callers cannot concurrently reclaim the same key. Seven-day deduplication is not a promise of seven-day authorization or indefinite retention of sensitive payloads.

## Policy and state model

Policy rules use canonical exact names or a trailing descendant wildcard such as `fixture.*`. The wildcard matches `fixture.counter.increment`, not bare `fixture`. No arbitrary glob, regex or substring matching. Within a policy layer, exact wins, then longest matching namespace prefix; tied matches resolve **Block > Ask > Allow**. Mandatory outer Blocks remain effective regardless of inner specificity. No matching rule defaults to Ask for a Tool that is otherwise authorized and visible. Profile visibility, Grant scope, policy and approval are separate controls.

Run states are exactly:

| State | Meaning |
| --- | --- |
| `pending_approval` | Frozen invocation awaits owner; no effect and no execution slot. |
| `queued` | Allow or authoritative approval permits a later dispatch attempt, still subject to current restrictions. |
| `running` | Persistent dispatch claim exists; an effect may become possible. |
| `succeeded` | Effect and protected final result recorded. |
| `denied` | Owner denied the pending approval; no effect. |
| `blocked` | Policy or current authorization/membership restriction prevented dispatch. |
| `expired` | Frozen approval deadline reached before execution start. |
| `canceled` | Explicit stop/cancellation won before the dispatch boundary. |
| `failed` | Definitive failure with no uncertain write; safe attempts exhausted or request cannot execute. |
| `outcome_unknown` | Dispatch/effect may have happened and durable evidence does not prove a final outcome; never automatically redispatch. |

Terminal states do not transition back to queued. A safe retry is an explicit bounded transition of the same logical Run with the same frozen invocation and a durable attempt number, not a newly authorized duplicate. Maximum three safe attempts; ordinary lost responses and process crashes are not proof of safety. A new manually requested invocation after an unknown outcome is a new authorization/approval decision and may duplicate effects; M1 does not provide a hidden retry bypass.

Freeze arguments, immutable Tool revision, organization/Grant/Profile identities, selected Account bindings, options, original policy decision and approval deadline before entering `pending_approval`. Default lifetime is three hours; a Profile may set 15 minutes through 24 hours. Approval and execution start require `now < deadline`, not `<=`. Approval clicks, polling, notification retries, reconnects and Profile lifetime changes never extend that deadline. If approval exists, its original deadline still bounds the queued execution start. A later Allow cannot silently bypass an already-required pending approval.

If a Run was originally allowed and queued without an approval and current policy becomes Ask before dispatch, the claim fails closed as `blocked` with `forbidden`. Do not invent a new deadline or mutate that frozen invocation into a new approval request; the caller must submit a new invocation subject to current Ask policy. This is distinct from an originally approval-required Run: changing its policy to Allow still cannot bypass its persisted pending approval. Authorization or membership restrictions use `blocked`; an explicit owner cancellation uses `canceled`. Owner inspection may expose redacted `displayArguments`, original `policyDecision`, `frozenToolRevision` and `grantLabel`; these fields remain outside caller execution provenance metadata.

## Minimum durable implementation and safety review

### Persistence and protected replay

Use shared core semantics with explicit persistence/dispatch/scheduling dependencies. Node and Worker adapters supply delivery, SQLite/D1 binding and scheduling only. Retain the existing BetterAuth, organization, Hono API and lifecycle paths; do not fork a second local authorization implementation. Existing D1 `batch` is the transaction boundary; the Node-compatible binding must match all-or-nothing batch behavior. Do not hold an assumed SQL transaction open across network calls or rely on an unsupported D1 interactive transaction.

Minimum durable records cover immutable Tool revisions, Profiles/membership, labeled Grants, policy configuration, Runs and immutable approval state, idempotency reservations, and fixture effect rows. Each Run stores enough state to recover without an HTTP connection: status, frozen identity, protected replay, redacted display, creation/deadline timestamps, attempt/claim identity and safe final error/result. Separate encrypted replay/result storage from display/audit columns; replay must never be reconstructed from redacted UI arguments.

Use authenticated encryption with a fresh nonce and a secret runtime key; bind ciphertext to organization and Run (and purpose/version) as associated data. Treat key loss, wrong associated data, damaged ciphertext or unavailable frozen revision as fail-closed, not a reason to execute display data or use a current revision. Keep sensitive `note`, full arguments, raw result, credentials and bearer tokens out of audit/logs/errors. M1 explicitly requires protected replay separation and the seven-day deduplication safety window. Payload expiration must not erase a still-live deduplication reservation or cause result retrieval to redispatch; an unknown outcome is not justification to retain protected payload indefinitely.

**Inherited full-PRD target, not a separate M1 completion claim:** D13 specifies configurable seven-day encrypted payload and 90-day payload-free audit retention defaults, plus owner export/restore. The M1 execution brief does not independently require full configurable retention, export/restore, or deletion of every Run metadata row at day 90. M1's safety tests cover its seven-day key window and expired-content handling, not certification of the entire D13 lifecycle. Expiring audit-event rows alone does not establish complete Run-metadata retention compliance. Preserve fixture effect evidence and observable write counts when designing later retention migrations; do not cascade-delete their Run/ledger chain merely to satisfy a metadata TTL. Evidence must disclose which rows expire and which remain.

### Atomic authorization and claim barrier

1. Persist the logical Run and deduplication reservation atomically before scheduling work. The returned `queued`/`pending_approval` status therefore survives disconnect.
2. Owner approval is a compare-and-swap from `pending_approval`, scoped to owner organization and strict deadline. Repeated approve/deny cannot resurrect terminal work or rewrite frozen inputs.
3. Immediately before execution, atomically claim only a currently eligible Run. **The same SQL claim/transaction** verifies active unexpired Grant, enabled Profile, current membership, availability of the frozen revision, no cancellation, any required approved state, immutable deadline and applicable current restrictions.
4. If evaluating policy in shared code before the claim, read a complete configuration snapshot with its monotonic control epoch, then condition the claim on the same epoch and current eligibility. Every restrictive configuration mutation must increment that epoch in the same transaction. A separate check followed by unconditional claim has a time-of-check/time-of-use bypass. A read replica/stale session cannot establish dispatch authority.
5. Record the durable `running` claim/attempt barrier **before** invoking an effect. Only the successful atomic claimant may execute. Claims and restrictions have a defined serialization point: a stop winning before the claim prevents dispatch; a stop after it is best-effort running cancellation, never a false guarantee of no effect.
6. Commit the fixture's unique Run effect row and observable counter delta in one transaction, guarded by the expected current claim. A uniqueness conflict means no second write. Commit protected outcome using a conditional update on that claim; stale completions cannot overwrite another final state.
7. A scheduler recovering a stale `running` claim never requeues an uncertain write. Mark `outcome_unknown` unless independent durable evidence safely proves the outcome; M1's conservative fault path intentionally leaves it unknown. Choose staleness after the execution timeout/lease, not simply any running row seen by another tick. A late completion must not turn a reclaimed or canceled attempt into apparent success.

A unique fixture effect row is additional defense and observable evidence; it is **not** a general claim of exactly-once effects for future remote APIs. Do not extend fixture ledger reasoning to external providers without their actual idempotency guarantees. Persist claim ownership/token and compare it when writing results. Safe retries require positive evidence that no write could have occurred, or a separately established provider idempotency contract; a timeout, connection reset or missing response is not that evidence.

### Recovery and deterministic fault boundaries

- Shared core exposes a bounded durable-drain/recovery operation. Workers use a persistent SQLite-backed `CONTROL_SCHEDULER` Durable Object alarm, durably armed by the first fetch and rearmed every 60 seconds; its only stored state is platform alarm metadata. Node wires startup recovery plus a recurring timer. All Run/job state remains in D1/SQLite. No in-memory callback, HTTP stream, caller polling, request `waitUntil`, or manual drain is the sole recovery driver.
- Multiple schedulers can inspect the same queued row; only one atomic claimant executes. Duplicate delivery neither creates a new logical Run nor repeats an effect. Avoid monopolizing a scheduler tick with unbounded draining.
- `safe_before_effect` deterministically fails the first attempt before any effect boundary, allowing a bounded safe retry of the identical Run. Persist the attempt before retry; success produces exactly one committed effect.
- `after_effect` commits the effect then simulates loss before final outcome recording. Report/recover `outcome_unknown`, with write count exactly one, and never perform an automatic second write.
- `crash_after_claim` leaves the durable running barrier without a recorded effect. Recovery conservatively reports `outcome_unknown`; absence of a response does not authorize retry. The simulated fault need not kill unrelated Worker invocations or a whole shared process.
- Actual process restart with approved queued work must resume it from persistent state. Restart after a claim must not redispatch. Both adapters run the same suite; fixture simulation alone does not prove actual restart recovery.
- Revocation, disabling, removal, new Block, expiry and cancellation prevent waiting work from dispatching. Cancel waiting rows when restrictions are applied, and independently recheck at claim, so a missed cancellation scan cannot become a bypass. Running cancellation is best effort; preserve uncertainty if an effect may exist.

## Owner control and error contract

All owner operations use **`/api/control/...`**, the existing BetterAuth session and **role `owner` in the session's active organization**. A Grant bearer, authenticated member, admin role, guessed organization ID, or possession of an approval URL does not confer owner authority. Resource lookups remain organization-scoped. Mutating owner routes validate same-origin browser intent/CSRF and never mutate via GET. Provisioning returns a fresh high-entropy token once and stores only a digest; do not expose old token values on reads. Expiring tokens default to 90 days; only an explicit owner choice makes one non-expiring.

The owner surface minimally supports Profile/fixture setup and policy/membership changes, separately labeled Grant creation/revocation, Run inspection, approve/deny, waiting cancellation and observable fixture write counts. Approval inspection uses `/api/control/runs/:runId`; action endpoints must not be caller-MCP capabilities. Route-level request/response contracts should be registered in the shared API/OpenAPI conventions; owner data never appears merely because a caller knows a Run ID.

Owner REST dates (`createdAt`, `deadline`, Grant `expiresAt`) use UTC ISO 8601 strings, nullable where appropriate, consistent with the architecture's API boundary. Domain and SQL clocks remain epoch milliseconds. A denied/blocked/failed Run can legitimately carry `error` in an HTTP 200 inspection/action response; it is not a transport failure or a JSON-RPC error envelope.

`ExecutionError` is strict: `code`, safe `message`, boolean `retryable`, optional correlated `run_id`, optional nonnegative `retry_after_ms`. These fields belong to error data or `RunControl.error`, not extra result provenance metadata. A retry hint never promises permission to bypass current authorization, TTL or unknown-write safety.

| Category / codes | Mapping and safe meaning |
| --- | --- |
| `unauthenticated` | HTTP 401 before execution; no private resource details. |
| `forbidden`, `grant_revoked`, `grant_expired` | HTTP 403 when rejecting access; do not expose retained Run content. Restriction discovered on an already recorded Run is a Tool error. |
| `not_found` | HTTP 404 for owner resources or a safe MCP retrieval error; inaccessible and absent IDs are indistinguishable. |
| `invalid_request`, `invalid_arguments` | HTTP 400 / JSON-RPC `-32600` or `-32602`; field paths may be safe, raw values must not be echoed. Bad JSON uses `-32700`. |
| `unsupported_protocol`, `unsupported_feature` | HTTP 400 for negotiation/transport constraints; unknown MCP methods use `-32601`. |
| `payload_too_large` | HTTP 413 before acceptance; after a possible effect retain unknown-outcome safety. |
| `idempotency_conflict` | Tool error correlated to original Run, or owner HTTP 409; not retryable under the same key. |
| `policy_blocked`, `approval_denied`, `approval_expired`, `profile_disabled`, `tool_unavailable`, `canceled` | Attributable invocation returns HTTP 200 with MCP `isError:true` and the recorded final Run. No automatic retry. |
| `execution_failed`, `execution_timeout`, `outcome_unknown` | Tool error; only positively safe failure can be retryable. Unknown/uncertain timeout is never automatically retryable. |
| `content_expired` | Authorized retrieval retains safe audit/status but no payload; never redispatch to refill it. |
| `rate_limited` | HTTP 429 when admission fails; a bounded `retry_after_ms`/`Retry-After` is advisory, not a write-retry guarantee. |
| `internal_error` | HTTP 500 / JSON-RPC `-32603` before safe acceptance; no stack, SQL, raw upstream response, ciphertext or secret. |

An attributable domain failure is a Tool result rather than an invented top-level MCP status. Retrieval failures without authority to reveal a Run do not fabricate provenance or attach someone else's `run_id`. Never label an uncertain side effect `failed` merely to make an error response simpler.

## Conformance and release boundary

The integration owner must run the same positive, negative and concurrency/fault scenarios on disposable local SQLite and a separately isolated hosted D1 preview. Required coverage includes:

- Transport/version/origin/content negotiation, strict metadata fields and ASCII boundaries (0, 1, 128 and 129 characters), wrong types, unknown fields, preserved spaces/case, final fallback content and omitted empty Accounts.
- Published digest vector; reordered keys/whitespace match; changed array order/type/argument/revision/binding/option conflicts; trace-only changes match; nonfinite numbers, invalid Unicode and duplicate names reject before dispatch.
- Separate labeled Grants, cross-Profile and cross-organization guesses, cross-Grant Run retrieval, revoked/expired retrieval, caller/member/admin inability to approve/administer, foreign-origin owner mutation rejection.
- Allow exactly once; Block audited with zero effects; default Ask pending with zero effects; owner denial; frozen payload/revision replay after approval; repeated approval/retrieval; owner inspection redaction versus protected replay correctness.
- Exact/longest descendant wildcard precedence, restrictive ties and outer Blocks; late Block, membership removal, disabled Profile, revoked Grant, canceled Run, unavailable frozen revision and strict deadline before dispatch. Changing Profile defaults does not mutate an already frozen deadline or invocation.
- Concurrent same-key calls (one Run/effect), different-fingerprint conflict, same key after active revision changes, queue redelivery, safe retry attempt ceiling, both crash boundaries, unknown outcome never replayed, genuine disconnect and process/runtime recovery driven by configured schedulers.
- Redacted logs/errors, no plaintext replay in display columns, authenticated encryption failure closed, seven-day key expiration, protected payload expiration versus retained audit, execution timeouts and stale-claim ownership checks.

Hosted deadline tests must honor the real minimum 15-minute approval lifetime; do not add a public bypass merely to speed a suite. A controlled local harness may manipulate its disposable database directly to exercise exact boundaries, never by enabling a hidden caller API. Report which tests use real elapsed time versus controlled local state. Hosted scheduling must be deployed and observed on the isolated preview, not merely present as an unused exported function.

For an independent native-alarm proof, use a dedicated disposable lifecycle-managed Worker with a separate initially empty D1 database, fresh auth/replay secrets and an exact trusted origin. Native version previews cannot isolate this scheduler namespace. Publish the declared SQLite Durable Object binding, verify that no binding or secret points at production, and exercise a period with no application HTTP requests between approval and alarm-driven execution. Do not substitute owner-triggered drain calls for autonomous recovery. Record this as an isolated hosted proof environment, not a production release. Existing namespace layouts require an explicitly approved additive lifecycle migration; never replace/adopt a namespace or drop retained bindings. Preflight existing quotas without changing paid tiers; clean up only the owned disposable resources.

The acceptance report must distinguish proposed behavior, exercised automated assertions, actual restart/scheduling observations, client builds tested and remaining limits. Required ChatGPT/OMP CLI launch certification and full M2/D12 contract/fixtures remain deferred; neither a generic HTTP harness nor this frozen M1 subset closes that launch gate.
