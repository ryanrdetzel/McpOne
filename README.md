# McpOne

Tool Control Plane with a shared Hono execution core on Cloudflare Workers/D1 and direct Node/SQLite, a React Router status dashboard, Drizzle, Better Auth, and organization-scoped authorization. M1 provides a deterministic fixture Tool, stable Profiles, labeled Grants, Allow/Ask/Block, owner approvals, durable Runs, and safe duplicate/restart handling. Internal workspace names remain `@scaffold/*`.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the canonical system blueprint, package boundaries, invariants, and architecture decision process. Validate proposed changes against it; deviations or design conflicts require human approval before implementation. This README covers setup, validation, and deployment operations.

The old PostgreSQL listener, startup migrations, Docker image, Compose setup, and DeployMill configuration are superseded. The approved direct Node adapter uses SQLite and the same application core as Workers; it is not the old PostgreSQL server. Existing `.env` files and PostgreSQL data are not imported. Wrangler configuration is for **local development**; `cloudflare-app.json` remains the production lifecycle configuration.

## Local startup

Requirements: Node 22.18 or newer within Node 22, and pnpm 11.20.0. Docker and a Cloudflare login are not required for local development.

```sh
corepack enable
corepack prepare pnpm@11.20.0 --activate
pnpm install --frozen-lockfile
pnpm run setup
pnpm dev
```

Open **http://localhost:3000**. Setup creates `apps/worker/.dev.vars` from its public development example without replacing an existing file. `dev` builds the SPA, applies committed migrations to local D1, and starts the actual Workers runtime. Worker/library source changes reload automatically; after rebuilding `@scaffold/web`, restart the Worker dev server and refresh so its asset manifest matches the new output.

If port 3000 is occupied, use matching auth/origin bindings on another port:

```sh
pnpm --filter @scaffold/web build
pnpm db:migrate
pnpm --filter @scaffold/worker exec wrangler dev --ip 127.0.0.1 --port 3030 --var BETTER_AUTH_URL:http://localhost:3030 --var TRUSTED_ORIGINS:http://localhost:3030
```

Open **http://localhost:3030**. Smoke checks create synthetic users, organizations, and feature flags; run them only against a disposable local/isolated preview database, never production:

```sh
SMOKE_BASE_URL=http://localhost:3030 pnpm smoke
```

Useful commands:

```sh
pnpm check         # Biome, all typechecks, library tests (including real D1), builds
pnpm build         # built SPA and self-contained Worker module
pnpm db:migrate    # apply ordered migrations to local D1 only
pnpm db:generate   # generate SQL candidates; never applies/deploys migrations
```

Wrangler persists local D1 under ignored `apps/worker/.wrangler/`. `/healthz` verifies every current table and column; a reachable but unmigrated/stale database returns 503. `/db` and `/api/dashboard` use the same readiness check. `/openapi.json` describes registered API routes. Real API/auth routes are never replaced by SPA HTML; hashed assets are immutable and HTML is uncached.

### Direct Node/SQLite

After installing the supported Node/pnpm versions and dependencies:

```sh
pnpm check
PORT=3030 BETTER_AUTH_URL=http://localhost:3030 TRUSTED_ORIGINS=http://localhost:3030 pnpm local
```

`local` builds the SPA, applies the same ordered committed migrations, then listens on loopback at **http://localhost:3030**. SQLite persists in ignored `.state/local/mcpone.sqlite`; `SQLITE_PATH` selects another disposable database. No Docker, Cloudflare login, or private production bindings are needed. Public development bindings are intentionally insecure outside local development; production validation still rejects default/short secrets.

The listener does not watch source. Stop and restart it after server edits, retaining the same SQLite path and secret when proving recovery. It drains durable work at startup and on a recurring timer. Workers use the same drain from a persistent SQLite-backed `CONTROL_SCHEDULER` Durable Object alarm: the first fetch acknowledges durable arming, then native alarms rearm every 60 seconds without constructing the HTTP application. Only platform alarm metadata lives in that object; authoritative Run/job state stays in D1. Do not confuse caller polling or an explicit `/drain` request with autonomous recovery. The interval is nominal, not a Cloudflare latency guarantee.

Use `PORT`, `BETTER_AUTH_URL`, and `TRUSTED_ORIGINS` with the same exact localhost origin if changing ports. Optional private bindings load from `LOCAL_CONFIG=/path/to/local.secrets.json` (ignored, mode `0600`); process environment overrides those bindings. Keep real credentials out of shell arguments and logs; `.env` is not implicitly loaded.


### Agent validation workflow

Local run/test support and continued Cloudflare deployability are required for every change (see `AGENTS.md`). Complete build-producing checks **before** starting the local server; rebuilding the frontend while Wrangler is running invalidates its asset manifest until restart.

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm check
# Requires the built lifecycle checkout and private binding files described below.
CFL_CLIENT_HOME=/path/to/cloudflare-lifecycle-mcp pnpm cf:check
pnpm dev
```

In a second terminal, run `pnpm smoke` against that local server and exercise the changed behavior. For UI changes, inspect the rendered page and relevant interactions in a browser. If port 3000 is occupied, use the port-3030 startup and `SMOKE_BASE_URL` commands above. Agent-launched shells must use the supported Node version, not a different system default.

Local startup and tests need no production credentials or Cloudflare login. `cf:check` validates the bundled artifact, production/preview private binding files, and hosted artifact size locally; it does not need `CFL_REMOTE_CONFIG`, upload, or deploy. If its separate lifecycle-checkout/binding prerequisites are unavailable, report deployment validation as blocked rather than treating a successful local run as proof of deployability.

## D1 migrations

Committed production migrations live in `packages/database/migrations/` and are applied by the lifecycle controller **before publication**, not by the Worker at request/startup time. Use nonempty ordered names such as `0001_add_field.sql`. Never edit an applied migration: its name and hash are recorded.

`db:generate` writes only to ignored `packages/database/generated/`. Review candidates against committed migrations and promote only additive changes into a **new** committed migration. On a fresh checkout, generation produces a full-schema candidate, not an automatically safe delta. Do not blindly deploy that candidate to an existing database. Keep schema changes compatible with currently running production code; this controller does not provide automatic database rollback or backup/restore.

## Production build and upload

The lifecycle package is private and local, not a published npm dependency. Use a built `cloudflare-lifecycle-mcp` checkout with the upgraded chunked snapshot storage. The hosted snapshot limit is 24 MiB; both artifact data and operation snapshots are stored in bounded SQLite chunks, not oversized Durable Object values/rows. The HTTP envelope limit remains 32 MiB.

```sh
export CFL_CLIENT_HOME=/Users/ryandetzel/Documents/Projects/cloudflare-lifecycle-mcp
export CFL_REMOTE_CONFIG="$CFL_CLIENT_HOME/.state/hosted/client.json"
pnpm cf:secrets
pnpm cf:check
pnpm cf:upload
```

`cf:secrets` creates distinct production/preview Better Auth secrets in ignored mode-0600 JSON files; it never prints values or overwrites existing secrets. `cf:check` builds and validates without uploading or deploying. `cf:upload` builds and uploads through authenticated HTTPS, returning an artifact ID. Neither command provisions an application.

The Worker is fully bundled inside the application checkout before lifecycle snapshotting. This avoids dependencies escaping the project boundary or imports through pnpm's private `.pnpm` paths. React Router's build-only `.vite` manifest is removed after prerendering; only public assets enter the snapshot.

Keep the controller client file outside Git and mode 0600. The controller already holds the Cloudflare credential; this application needs only its private MCP/client credential. Do not commit credentials, use real secrets in `vars`, or pass secrets as tool arguments. Ordinary `.env` files are not loaded by the Worker or artifact builder.

## Deployment and verification

Use the authenticated remote lifecycle MCP at `https://cfl-lifecycle-controller-65ec5d0bab.ryandetzel3409.workers.dev/mcp`. Consult `INIT_PROJECT.md` in the lifecycle checkout for connection details. Never put the real bearer header in committed MCP configuration.

1. Call `list_apps` and reuse an existing McpOne application rather than creating duplicates.
2. Set production `BETTER_AUTH_URL` and `TRUSTED_ORIGINS` to the exact served HTTPS origin in `cloudflare-app.json`; bind the private production secret.
3. Upload and call `create_app` (initial deployment) or `deploy` (subsequent releases) with the artifact ID and a stable request key.
4. Preserve the operation ID and poll `get_operation` until `ready` or `failed`; pending/running is not success.
5. Require `get_app` to confirm provider existence and live health. Exercise uncached public `/healthz`, `/api/dashboard`, and the rendered dashboard.
6. Record the application ID, URL, operation ID, and verified result in deployment notes here.

Reuse the same artifact and request key when recovering a lost submission response. Changed code, SQL, or bindings require a new upload/key. Failure can leave code live; inspect operation recovery guidance rather than assuming rollback or creating a replacement app.

Previews use separate empty D1 databases and separate secrets, never production rows or a production-secret fallback. Before uploading a preview, configure `previewVars.BETTER_AUTH_URL` and `previewVars.TRUSTED_ORIGINS` for its exact served origin; the default preview config deliberately requires those values and will not pass readiness without them. Use the actual checked-out Git ref and verify its auth/session boundary before browser/auth smoke checks.

### Verified deployment — 2026-10-08

- **URL:** [McpOne](https://cfl-mcpone-3e4b5c9dc0.ryandetzel3409.workers.dev)
- **Application ID:** `375fd22e-ecf2-4d33-b9cb-44b85f5153da`
- **Worker:** `cfl-mcpone-3e4b5c9dc0`
- **D1:** `cfl-mcpone-3e4b5c9dc0-prod` (`95a44e24-b138-4960-bc5c-a5e8cc11e607`)
- **Final operation:** `18b310a2-9063-4840-90eb-9c0429004574` — `ready`, `complete`
- **Artifact:** `4af65f5c-57b3-4429-8077-ae3bdb156a0e`; upload snapshot 2,310,328 serialized bytes
- **Release:** `workers-d1-1`; production auth/trusted-origin bindings match the served HTTPS origin

Verified provider existence and live health, uncached `/healthz` with the final `x-cfl-operation` marker, and `/api/dashboard` with `database: true`. Public session/organization/admin checks preserve anonymous access boundaries; foreign-origin auth is rejected. The rendered dashboard shows Online and Connected, refreshes successfully, and reports no browser errors. Full signup/session/organization/flag smoke checks ran against local D1, not production.

The lifecycle controller storage upgrade is deployed with its original namespace, installation, credentials, and legacy operation identities preserved. Snapshots now use chunked SQL storage and journal references under the 24 MiB hosted limit; the retained local repair publisher was released before remote application deployment.

## M1 workflow and conformance

See [the frozen M1 contract](docs/M1-CONTRACT.md) for wire, policy, approval, deduplication, and uncertainty semantics. M1 supports stateless JSON Streamable HTTP at `/mcp/:profileId`, protocol `2025-06-18`; string correlation IDs are 1–128 characters. Request metadata uses `_meta["com.toolcontrolplane/execution"]`; transport IDs are not idempotency keys. `runs.get` retrieves the original stored Run without dispatching. A Profile URL is stable and public; its separately labeled bearer Grant is the credential.

**Observed M1 acceptance:** the identical full SQLite and isolated hosted suite passed, including autonomous native alarms, actual restart/redeploy and real 15-minute expiry. See [redacted M1 evidence](docs/M1-EVIDENCE.md) for runtime/client versions, gates, operation/namespace identities, commands, warnings and limits. This is not a production release or required-client launch certification.

### Deterministic owner demo

Run against a disposable local or isolated hosted database only:

```sh
export M1_BASE_URL=http://localhost:3030
export M1_ALLOW_MUTATION=yes
pnpm m1:demo setup
pnpm m1:demo policy allow
pnpm m1:demo call 7
pnpm m1:demo policy block
pnpm m1:demo call 11
pnpm m1:demo policy ask
pnpm m1:demo call 19
# Use the public run_id returned by the Ask call:
pnpm m1:demo approve <run-id>
pnpm m1:demo run <run-id>
pnpm m1:demo call 23
pnpm m1:demo deny <second-run-id>
pnpm m1:demo revoke
```

Allow records one effect; Block and owner denial record none. Ask returns `pending_approval` and a same-origin authenticated inspection URL. Approval can return `queued`; retrieve the Run to observe completion rather than calling the business Tool again. The same stable Profile remains configured throughout. After revocation, that Grant cannot invoke or retrieve.

The demo creates a synthetic Better Auth owner/workspace and stores only its session, Grant, and public IDs in ignored `.state/m1-demo.json`, mode `0600`; it never prints passwords, cookies, or bearer tokens. `M1_DEMO_STATE_FILE` selects a separate ignored handoff for another runtime/demo. Do not overwrite an existing handoff. An optional `M1_DEMO_NOTE` is protected replay input and is never printed or retained by the client. Setup and approvals use this CLI/authenticated control API, not a rich owner portal. Owner REST timestamps are UTC ISO 8601 strings; grant `expiresAt: null` is an explicit non-expiring choice, while omission defaults to 90 days.

### Same black-box suite, actual restart, real expiry

```sh
export M1_BASE_URL=http://localhost:3030
export M1_ALLOW_MUTATION=yes
export M1_STATE_FILE=.state/m1-conformance/node.json
pnpm m1:conformance --phase=prepare
```

Prepare deliberately exits **2 / pending**, not success: it leaves an approved paused queue, a real running claim, and two frozen 15-minute approval deadlines in a separate expiry workspace. Stop the producing process promptly, **before the fresh running claim's 60-second lease expires**, then restart against the same SQLite/secret. Finish builds and arrange the restart command before prepare; leaving the old runtime alive past the lease invalidates the post-claim restart evidence:

```sh
PORT=3030 BETTER_AUTH_URL=http://localhost:3030 TRUSTED_ORIGINS=http://localhost:3030 pnpm --filter @scaffold/local start
# In a second terminal, only after observing the actual restart:
M1_RESTART_CONFIRMED=yes M1_EXPIRY_WAIT=yes pnpm m1:conformance --phase=resume
```

Resume uses a zero-HTTP interval (default 70 seconds), proves scheduler-driven queue completion and conservative post-claim uncertainty, then waits for the **real** 15-minute deadlines. Do not run another client/demo/browser against that application during the zero-HTTP interval: another invocation or approval can drain work and invalidate autonomous evidence. Exit **0 / pass** requires every gate, including both actual-restart paths and both expiry cases. The private mode-0600 handoff is removed on complete success. Suite-only mode cannot certify actual restart; simulation, pending gates, shortened deadlines, manual drains, and a successful build are not substitutes.

### Isolated hosted proof

Hosted proof requires the built private lifecycle checkout/client described above; local setup does not. Do not change production bindings or test against the production URL.

```sh
pnpm check
CFL_CLIENT_HOME=/path/to/cloudflare-lifecycle-mcp pnpm cf:check
export CFL_CLIENT_HOME=/path/to/cloudflare-lifecycle-mcp
export CFL_REMOTE_CONFIG="$CFL_CLIENT_HOME/.state/hosted/client.json"
export M1_ALLOW_MUTATION=yes
pnpm m1:hosted provision
```

Provisioning creates/reuses the dedicated disposable **`mcpone-m1-proof`** application, with its own empty D1 and fresh private secret. It uploads the normal Worker/SPA/migrations and binds the exact returned origin; it never edits the production manifest. State/secrets remain in ignored mode-0600 files. Redeploy performs live identity/database isolation checks before upload; a cached target name alone is insufficient.

Native version previews cannot independently isolate Durable Object state, so this approved proof uses a separate lifecycle-managed Worker. The normal manifest declares `CONTROL_SCHEDULER` / `ControlScheduler`; no Cron installation or manual scheduler endpoint is required. If reusing an established pre-alarm proof app, run `pnpm m1:hosted migrate` once: it explicitly adds only that binding, preserving the existing Worker, D1 and data, and rejects any other live layout. The lifecycle controller must expose the approved additive `durableObjectMigration` deploy input. Ordinary `redeploy` does not bypass the layout guard. Do not enable a new paid service/tier for validation.

Set `M1_BASE_URL` to the returned isolated origin and `M1_STATE_FILE=.state/m1-conformance/hosted.json`; run `SMOKE_BASE_URL="$M1_BASE_URL" pnpm smoke`, then the same prepare command. Let the auth rate-limit window elapse between the smoke's synthetic sign-ups and conformance setup; an immediate combined run can legitimately return 429. Immediately use `pnpm m1:hosted redeploy` for the actual restart boundary, within the fresh claim's 60-second lease; record its new ready operation/version and unchanged scheduler namespace/D1. Run the identical resume command and require all gates. `pnpm m1:hosted status` is read-only but performs a health fetch: do not run it during zero-HTTP proof. Use `pnpm m1:hosted delete` only for this owned disposable app; never delete unrelated applications. Retain only redacted evidence, not credentials/database dumps.

Successful proof deletion clears the cached target identity and removes its isolated secret file. Provisioning trusts the controller's live owned-app list, not a deleted cached ID; the next `provision` starts a fresh isolated application/database/secret.


## Conventions and product scope

Preserve the pnpm workspace, Zod contracts, Hono RPC/OpenAPI, organization-scoped authorization, structured request/error logs, echoed request IDs, bodyless HEAD responses, and one-origin SPA routing. Keep platform-only code in `apps/worker` or `apps/local`; domain behavior belongs in shared libraries. Production rejects missing/default/short auth secrets and absent/mismatched trusted origins.

The approved M1 brief/PRD now supply product requirements. The public dashboard reports infrastructure health without exposing private workspace data; the owner CLI/API demonstrates M1 execution. External integrations/Accounts, Tool authoring/imports, rich owner UI/notifications, export/restore/full configurable retention, native MCP Tasks, and required-client launch certification are not claimed by this milestone.
