# McpOne architecture blueprint

## Purpose and authority

This document defines the canonical intended state of the McpOne codebase and system. It is the blueprint used to evaluate technical decisions, not an assertion that every intended behavior is already implemented. The initial baseline preserves the architecture and constraints already documented in this repository; it does not introduce new product requirements.

- This document owns system design, component boundaries, and architectural invariants.
- [README.md](README.md) owns setup, run, validation, and deployment procedures and observed deployment results.
- [AGENTS.md](AGENTS.md) owns agent workflow, decision approval, and repository safety rules.
- The [McpOne Linear project](https://linear.app/detzel/project/mcpone-093e9308edc9/overview) owns work tracking, acceptance criteria, blockers, and human decision records.

If these sources conflict, ask a human to resolve the conflict before implementing the affected change. Do not silently pick one or redefine the blueprint to match existing code.

## System shape

McpOne is a Tool Control Plane dashboard running on Cloudflare Workers and D1, using a React Router SPA, Hono RPC/OpenAPI, Drizzle, Zod, Better Auth, and organization-scoped authorization. Frontend assets and the API share one origin. Preserve the pnpm workspace; internal package names remain `@scaffold/*`.

Request flow: browser → Worker entrypoint → shared Hono application → authentication/authorization and domain routes → D1 through the database package. The Worker also serves built frontend assets and SPA navigation; API/auth requests must never fall through to SPA HTML.

Background flow: a platform scheduler → shared execution drain → atomic D1/SQLite eligibility, claim, effect and recovery transitions. Direct Node uses its recurring timer; Workers use a persistent SQLite-backed Durable Object alarm. The Durable Object stores only platform alarm metadata, never a second Run/job queue or customer replay payload.

## Component boundaries

| Location | Responsibility | Boundary |
| --- | --- | --- |
| `apps/worker/` | Cloudflare binding setup, `fetch` entrypoint, asset/SPA delivery and persistent native alarm scheduling | No business logic, auth rules, alternate queue, or request/startup migrations. |
| `apps/local/` | Approved direct Node listener, local SQLite binding, asset delivery and restart recovery scheduling | Shares the Hono application; no alternate domain/auth behavior. |
| `apps/web/` | React Router SPA (`ssr: false`), dashboard, typed same-origin API client | Consume shared API contracts; keep server-side authorization on the server. |
| `packages/core/` | Reusable Hono application, routes, authentication, authorization, feature flags, request middleware, structured logging | Explicit dependencies; no Cloudflare bindings, filesystem access, or process-global configuration. New domain behavior belongs here or in shared libraries, not the platform entrypoint. |
| `packages/database/` | D1/Drizzle connection, schema readiness checks, ordered SQL migrations | Keep persistence and migration concerns separate from Worker delivery. |
| `packages/schema/` | Shared Zod API contracts and SQLite table definitions | Application-generated UUIDs; epoch-millisecond date storage with Dates/ISO strings at the API boundary. |
| `packages/config/` | Zod validation of explicit runtime bindings | Validate configuration at the boundary rather than introducing implicit global configuration. |
| `scripts/` | Local setup, bundling, private auth-binding creation, lifecycle artifact upload | Operational tooling, not a second implementation of application behavior. |

## Runtime and API invariants

- Local development and deployed Workers execute the same shared application logic. No local-only substitutes for real API, auth, or persistence paths.
- Preserve Zod contracts, typed Hono RPC, and OpenAPI for registered API routes.
- Preserve structured request/error logging, echoed request IDs, and bodyless HEAD responses.
- Serve frontend and API from one origin. Hashed assets are immutable; HTML is uncached.
- Workers require the `CONTROL_SCHEDULER` binding to the exported `ControlScheduler` SQLite-backed Durable Object. A deterministic app-scoped instance acknowledges durable arming before the HTTP application handles a request; it does not drain over that RPC. Native alarms rearm a bounded recurring interval and invoke the same shared execution drain without caller polling. Missing bindings or scheduler failures must not silently fall back to HTTP/manual driving or process-local timers. Namespace reconciliation belongs to lifecycle publication, not request handling.
- `/healthz` checks every required table and column. An unmigrated or stale schema is not healthy and returns 503; `/db` and `/api/dashboard` use the same readiness check.

## Data and migration lifecycle

- Cloudflare D1/SQLite is the persistence target; use Drizzle and the shared schema definitions.
- Commit ordered SQL migrations under `packages/database/migrations/`. The lifecycle controller applies them before publication, never during Worker requests or startup.
- Never edit an applied migration; its name and hash are recorded. Review generated candidates and promote additive changes into a new committed migration compatible with currently running production code.
- Generated SQL is not automatically a safe delta. The controller provides no automatic database rollback or backup/restore; do not design changes assuming either exists.
- Preview databases are separate and empty, never seeded with production rows for routine validation.

## Authentication, authorization, and secrets

- Better Auth provides authentication; enforce organization-scoped authorization in shared server logic, not only in the UI.
- Production rejects missing, default, or short auth secrets and absent or mismatched trusted origins. Auth/trusted-origin bindings must match the exact served origin.
- Production and previews use distinct secrets and database bindings. Never fall back to production secrets or data in previews.
- Keep credentials out of source, documentation, frontend assets, logs, fixtures, and tool arguments. Use private bindings and ignored mode-0600 files as described in README and AGENTS.

## Development and deployment invariants

- A fresh checkout must run and be testable with the documented Node/pnpm versions, public development bindings, and local Workers/D1. Local validation must not require Docker, a Cloudflare login, production credentials, or production data.
- Wrangler remains the local Workers/D1 development runtime; `cloudflare-app.json` is the production lifecycle configuration. M1 also has an approved direct Node/SQLite adapter sharing the same core. PostgreSQL startup migrations, Docker/Compose and DeployMill remain superseded.
- Build a self-contained Worker module and SPA assets within the application checkout. No dependencies may escape the artifact boundary through external workspace or private pnpm paths.
- Preserve the Cloudflare lifecycle deployment path. Local validation must not upload or deploy merely to prove a change works.
- Build-producing checks finish before Wrangler starts; frontend rebuilds require a Worker restart to refresh its asset manifest. Follow the exact check, smoke, and lifecycle-validation sequence in README and AGENTS.
- Run mutating validation only on disposable local or isolated preview databases. A pending deployment is not successful, and a failed operation does not imply rollback; use the documented operation and live-health verification process.

## Product scope and known gaps

The approved [M1 execution brief](https://app.notion.com/p/3f32eecf0b3f8125b521d2d7b8673a1f) and [PRD v1.1](https://app.notion.com/p/3f32eecf0b3f81d58d2ec4e24d740d1f) now define product behavior. M1 proves a fixture Tool, stable Profile, separately labeled Grant, deterministic Allow/Ask/Block, owner approval, durable frozen Runs, dispatch-time restriction checks, seven-day idempotency and uncertain-write safety on direct SQLite and hosted Cloudflare. Domain logic remains shared; platform adapters only provide persistence, delivery and scheduling. M2–M4 authoring, external integrations/accounts, richer UI/notifications and launch-client certification are outside M1.

Keep implementation gaps separate from design decisions: record a mismatch and its evidence in a Linear issue rather than rewriting the intended architecture to make the mismatch appear compliant. Add approved target behavior here when requirements become available; do not claim it is implemented until verified.

Observed M1 implementation and acceptance are recorded separately in [M1-EVIDENCE.md](docs/M1-EVIDENCE.md): identical direct SQLite and isolated hosted suites passed with real restart/deadline proof. The explicitly authorized shared-controller dependency is implemented; McpOne production rollout and deferred M2–M4/retention/client-certification scope remain unperformed.

## Decision and maintenance process

1. Before planning or implementing substantive work, read this blueprint and identify the relevant sections in the Linear issue. Check the proposed approach against boundaries, contracts, security, data lifecycle, and local/production operation.
2. If the design does not work or fit, requirements conflict, or a consequential decision is unresolved, pause the affected work. Present a human with the evidence, options, tradeoffs, and a recommended resolution. Do not implement a workaround or deviation first; unrelated work may continue.
3. Record the human's explicit decision in the issue. No response is not approval. Follow the approved choice; do not infer approval from current code, a ticket status, or an agent's recommendation.
4. When approval changes the intended design, update this document with the new target, rationale, and approving issue/decision reference before implementing the deviation. Keep README procedures and acceptance criteria aligned.
5. Verify implementation against both the approved blueprint and issue acceptance criteria. Record observed results and outstanding gaps; close the issue only under the completion rules in AGENTS.

### Decision records

- Baseline: extracted the existing README architecture and constraints into this canonical document. Tracking: [DET-1375](https://linear.app/detzel/issue/DET-1375). The user requested a separate canonical architecture document and human validation whenever the blueprint does not work or fit; no stack or product-scope change was made.
- M1 local/hosted proof: the user explicitly approved a direct Node/SQLite adapter alongside Workers/D1 and mutating verification on an isolated Cloudflare preview with separate empty database/secrets. Preserve the existing production lifecycle; no production tests/deployment or new paid services are authorized. Rationale: satisfy the PRD's direct-local runtime and actual hosted parity requirements without changing shared domain semantics. Tracking: [DET-1376](https://linear.app/detzel/issue/DET-1376). This records intended behavior, not completed acceptance.
- M1 hosted native alarms: after repeated real no-HTTP approval failures despite installed Cron, an active exported handler/version, live D1 eligibility and a bare classic Cron probe, the user explicitly approved replacing Worker Cron scheduling with persistent Durable Object alarms. Keep authoritative Run/job state and execution logic in shared core/D1, preserve the direct Node timer and production lifecycle path, and prove the same full black-box suite. The existing lifecycle schema supports `durableObjects` plus declarative SQLite exports; the account already has SQLite namespaces and the feature is available on both Workers Free/Paid. No new paid service/tier or shared-controller change is authorized; stop and ask if either becomes necessary. Root cause of Cron non-execution remains unproven; this is an approved target, not a claim of hosted acceptance. Tracking: [DET-1376](https://linear.app/detzel/issue/DET-1376), explicit approval comment `7d3935c7-24a9-42bb-b2b7-1339a3aed277`.
- M1 established-application migration: preflight found the lifecycle controller's immutable-layout guard rejects adding the alarm binding to an existing app. The user explicitly approved an **add-only**, expected-layout-checked namespace migration and the narrow shared-controller update/deployment if needed. Retain all existing bindings/classes and D1 identity/data, reject destructive or stale changes, and recheck queued publication before provider mutations. Preserve the controller's own namespace/journal/credentials on self-update. This supersedes the prior prohibition on shared-controller changes only for this scoped dependency; McpOne production deployment/data mutation and paid upgrades remain unauthorized. Tracking: [DET-1381](https://linear.app/detzel/issue/DET-1381), parent approval comment `6b5c970a-d467-4c89-91c5-c0966290510c`.
