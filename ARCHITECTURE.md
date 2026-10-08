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

## Component boundaries

| Location | Responsibility | Boundary |
| --- | --- | --- |
| `apps/worker/` | Cloudflare binding setup, `fetch` entrypoint, asset and SPA delivery | No business logic, auth rules, or request/startup migrations. |
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
- Wrangler configuration is for local development; `cloudflare-app.json` is the production lifecycle configuration. The Node listener, PostgreSQL startup migrations, Docker/Compose, and DeployMill paths are superseded and must not be reintroduced as parallel runtimes without human approval.
- Build a self-contained Worker module and SPA assets within the application checkout. No dependencies may escape the artifact boundary through external workspace or private pnpm paths.
- Preserve the Cloudflare lifecycle deployment path. Local validation must not upload or deploy merely to prove a change works.
- Build-producing checks finish before Wrangler starts; frontend rebuilds require a Worker restart to refresh its asset manifest. Follow the exact check, smoke, and lifecycle-validation sequence in README and AGENTS.
- Run mutating validation only on disposable local or isolated preview databases. A pending deployment is not successful, and a failed operation does not imply rollback; use the documented operation and live-health verification process.

## Product scope and known gaps

The existing README describes a dashboard shell with real infrastructure. It records that the supplied Notion PRD was inaccessible during scaffolding. This blueprint therefore does not define unconfirmed product integrations, permission models, or domain workflows. Obtain accessible requirements and human validation before extending that scope.

Keep implementation gaps separate from design decisions: record a mismatch and its evidence in a Linear issue rather than rewriting the intended architecture to make the mismatch appear compliant. Add approved target behavior here when requirements become available; do not claim it is implemented until verified.

## Decision and maintenance process

1. Before planning or implementing substantive work, read this blueprint and identify the relevant sections in the Linear issue. Check the proposed approach against boundaries, contracts, security, data lifecycle, and local/production operation.
2. If the design does not work or fit, requirements conflict, or a consequential decision is unresolved, pause the affected work. Present a human with the evidence, options, tradeoffs, and a recommended resolution. Do not implement a workaround or deviation first; unrelated work may continue.
3. Record the human's explicit decision in the issue. No response is not approval. Follow the approved choice; do not infer approval from current code, a ticket status, or an agent's recommendation.
4. When approval changes the intended design, update this document with the new target, rationale, and approving issue/decision reference before implementing the deviation. Keep README procedures and acceptance criteria aligned.
5. Verify implementation against both the approved blueprint and issue acceptance criteria. Record observed results and outstanding gaps; close the issue only under the completion rules in AGENTS.

### Decision records

- Baseline: extracted the existing README architecture and constraints into this canonical document. Tracking: [DET-1375](https://linear.app/detzel/issue/DET-1375). The user requested a separate canonical architecture document and human validation whenever the blueprint does not work or fit; no stack or product-scope change was made.
