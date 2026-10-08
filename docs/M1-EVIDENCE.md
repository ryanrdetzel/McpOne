# M1 acceptance evidence — 2026-10-08

Tracking: [DET-1376](https://linear.app/detzel/issue/DET-1376), with contract/runtime/core/proof work in DET-1377–DET-1380 and the explicitly approved additive lifecycle dependency in [DET-1381](https://linear.app/detzel/issue/DET-1381). Contract: [0.1.1-m1](M1-CONTRACT.md). Design and human decision records: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Result and scope

**The identical black-box HTTP suite passed completely on direct Node/SQLite and real isolated Cloudflare Workers/D1**, including actual restart/redeploy, autonomous scheduling without application HTTP, and both real 15-minute expiry cases. Prepare's exit 2/pending was not treated as completion; resume exited 0/pass with every gate satisfied.

Implemented: deterministic fixture Tool/revision, stable Profile, separately labeled scoped Grants, Allow/Ask/Block, owner-only frozen approval/denial, protected replay, durable Runs, current-authority checks at dispatch, seven-day JCS/SHA-256 idempotency, bounded safe retries and conservative uncertain-write recovery. The owner CLI/API is the approved minimal interface; the dashboard exposes infrastructure health only.

This is a working-tree delivery, not a committed release or McpOne production deployment. Sol implemented/tested; Astra resolved/reviewed technical design within the recorded human approvals.

## Exercised acceptance

| Behavior | Direct SQLite | Hosted D1 |
| --- | --- | --- |
| Real Better Auth owner/workspace setup; UTC ISO owner dates | Pass | Pass |
| Stable Profile MCP initialization/discovery and invocation | Pass | Pass |
| Strict JSON/metadata, bounded correlation IDs and response handling | Pass | Pass |
| Labeled Grants, expiration and cross-Grant/workspace isolation | Pass | Pass |
| Allow: one effect; repeated retrieval does not replay | Pass | Pass |
| Block/owner denial: audited durable outcome, no effect | Pass | Pass |
| Ask: waits; approval replays frozen arguments with protected display | Pass | Pass |
| Autonomous approved execution during zero application HTTP | Pass | Pass |
| Concurrent same-key canonical duplicates; conflicting fingerprint | Pass | Pass |
| Idempotent membership denials, exact/wildcard/tie/outer-Block policy | Pass | Pass |
| Later Block, membership removal, disabled Profile, revocation, cancellation | Pass | Pass |
| Queued dispatch rechecks current workspace restrictions | Pass | Pass |
| Concurrent queue redelivery commits one effect | Pass | Pass |
| Positive no-effect evidence permits bounded safe retry | Pass | Pass |
| After-effect uncertainty and stale claim never blindly redispatch | Pass | Pass |
| Actual restart preserves approved queued work and running claim | Pass | Pass |
| Post-restart scheduler resolves stale claim to `outcome_unknown` | Pass | Pass |
| Post-restart duplicate invocation/retrieval does not replay | Pass | Pass |
| Real pending-approval deadline and approved-queue dispatch expiry | Pass | Pass |

Controlled boundary/cipher/transaction tests complement these real-time HTTP checks; they are not substitutes for the actual restart or elapsed-deadline evidence.

## Runtime, client and commands

- Node **22.18.0**, pnpm **11.20.0**, Vitest **4.1.10**; local Wrangler **4.148.0**.
- Direct adapter uses actual `node:sqlite`, real listener/auth, ordered hash-journaled migrations and the shared execution core. Node's SQLite experimental warning remains visible.
- Workers use the same core/D1 logic and a persistent SQLite-backed `CONTROL_SCHEDULER` / `ControlScheduler` Durable Object. Only native alarm metadata is stored there; no second job queue or customer replay payload.
- HTTP harness client: `m1-http-conformance` **1.0.0**, MCP protocol **2025-06-18**, execution contract **0.1.1-m1**. Generic HTTP conformance is not ChatGPT/OMP client certification.

Commands exercised with the supported Node on `PATH`:

```sh
pnpm check
CFL_CLIENT_HOME=/path/to/built/cloudflare-lifecycle-mcp pnpm cf:check
SMOKE_BASE_URL=http://localhost:3030 pnpm smoke
SMOKE_BASE_URL=http://localhost:3040 pnpm smoke
SMOKE_BASE_URL="$M1_BASE_URL" pnpm smoke
M1_ALLOW_MUTATION=yes pnpm m1:conformance --phase=prepare
# Actual Node process replacement or owned Worker redeployment occurs here.
M1_ALLOW_MUTATION=yes M1_RESTART_CONFIRMED=yes M1_EXPIRY_WAIT=yes pnpm m1:conformance --phase=resume
pnpm m1:hosted migrate
pnpm m1:hosted redeploy
pnpm m1:hosted delete
```

Use separate ignored `M1_STATE_FILE` handoffs and exact disposable `M1_BASE_URL` origins as documented in [README](../README.md#m1-workflow-and-conformance). Do not use the production origin. Auth smoke sign-ups can legitimately rate-limit immediate conformance setup; the observed 429 was not suppressed or treated as a product pass.

Observed checks:

- `pnpm check`: all seven workspace typechecks/builds and **68 tests** passed (24 configuration, 1 real D1 database, 34 core, 9 direct-local). Biome reported **28 warnings**, no errors.
- Actual Node and Wrangler smoke: **14 tests each passed**, including after the final frontend rebuild/Worker restart. Hosted smoke: **14 passed**.
- `pnpm cf:check`: final no-upload validation passed; serialized production artifact **2,392,887 bytes**, SHA-256 `14be80dbd5d679e64816efa9d32c6c35395bf6ae5e512821c819978d20fb0b5c`. The earlier pre-evidence snapshot was 2,392,863 bytes / `b8f48d5a93c6c92683cc4fa3721ffd2408d86e864a860877047dad9f7c3c1337`; neither check uploaded or deployed.
- Separate lifecycle checkout: `npm run build && npm test` passed **68 tests**, including six migration regression groups covering retained bindings/data, invalid/destructive/stale intent, immutable replay/lease takeover, queued old layouts and rejected/ambiguous/failed publication.
- Actual managed Chromium rendered the rebuilt dashboard at localhost:3040, showed **Online / Connected**, exercised Refresh status, captured the full rendered page and reported zero console errors. Native host screenshot capture timed out; the independent Chromium capture succeeded.

## Direct SQLite restart and local native-alarm proof

The actual Node producer **PID 33364** was stopped 15 ms after a fresh running claim; the replacement **PID 33814** used the same SQLite database and secret. The full resume passed autonomous queue recovery, one frozen value-61 effect, post-claim `outcome_unknown` at attempt 1, no duplicate/retrieval replay, and both actual 15-minute expiry cases. A stale earlier diagnostic attempt was not counted as the successful restart proof.

An additional real Wrangler/Miniflare native-alarm check approved a paused value-43 Run, unpaused it, then made **no application HTTP for 70,036 ms**. Run `84592e11-fde8-4a62-9d0b-ac2e3f117468` finished `succeeded`, attempt 1, writes **3→4**, total delta **43**. No Cron/manual drain was used. This local alarm observation supplements, not replaces, the hosted proof.

## Actual hosted identity and recovery

The dedicated disposable proof used application `fea6415a-0b89-47e8-9ce9-58ed770db76c`, Worker `cfl-mcpone-m1-proof-dda0eff52d` / native ID `a28c8eeb9f1c4b7baab8d0744abe1b63`, and D1 `cb337b86-e25b-4863-8a7d-aa3b391825ee`. Fresh proof credentials stayed in ignored mode-0600 files and were never passed as tool arguments or printed.

Approved additive migration operation **`ca97b8ee-1835-4b95-bcd9-33111e870e98`** reached ready, adding only SQLite namespace **`4b539c978b894e10bf715def4304531c`** for `ControlScheduler`. Worker/D1 IDs were unchanged. Before/after observed counts remained **81 Runs / 24 effects / 12 Grants**. Native metadata confirmed SQLite storage; the proof's Cron schedule list was empty.

Full hosted prepare passed its executable gates in **168,115 ms**, leaving the intentionally pending actual restart/deadline gates. The real redeploy operation **`bfd08022-2c67-4ac3-a1fe-9a9186ebf8a4`** reached ready in **14,214 ms**, before the fresh 60-second claim lease expired. It published a new native version **`4da30a7b-c6ec-4591-8d34-10a26feb5b33`**, active at **100%**, deployment **`0baec339-50f2-4819-9215-9f4590c50be3`**. Scheduler namespace and D1 remained identical. Hosted artifact digest: `b886216270e6abeb3cd56a1499018c59838b9f8c97e6a05b309a004d0550db95`.

Resume passed every gate in **726,026 ms**, including **113,621 ms without application HTTP** before observing autonomous stale-claim uncertainty and approved-queue completion. The pending and approved-queued expiry fixtures used the real 15-minute minimum, not shortened clocks. Total prepare/redeploy/resume runner time: **908.51 seconds**. The successful private handoff was removed by the harness.

## Approved controller change and cleanup

The scoped controller self-update operation **`53a3c3b9-812e-4d05-8d88-3e5c01782c6f`** reached ready, native version **`d9d8d4f2-7096-49b6-9a20-25399ba56dfd`**. Controller Worker ID **`3ed777007292417e82eb84b10ece2e54`** and SQLite journal namespace **`2520a7b73d6848f18a85a70fc9c4208a`** were unchanged before/after. No bootstrap/journal replacement or credential rotation occurred.

Both owned diagnostic Cron schedules were cleared. The exact owned bare Cron probe was deleted without force. Verified proof deletion operation **`c2fb596e-c074-4d98-8e59-fbfc33b5464a`** reached ready through the lifecycle controller, deleting the disposable Worker and D1. McpOne production was not deployed, mutated or used for smoke/conformance. No paid-tier upgrade was performed.

Cleanup exposed a real client-state bug: immediately provisioning again after deleting the proof failed with `Proof environment isolation/read-back failed`, because the deleted cached ID was still treated as authoritative. The client now trusts live owned-app discovery and clears its target/isolated secret after successful deletion. Actual repro failed before the fix; afterward `provision` created fresh app `e122485c-4c23-4f04-8c56-5aa29ba6c689` with distinct D1 `fedd0e74-6c2d-4c25-ae2a-63e6b2d7a121`, ready operation `fd0a8230-5f2a-41cc-9942-5f16ecc1a513`. Cleanup operation `1037aa0b-7548-4ea8-b95e-c218cac292ff` then reached ready; the cached state was observed empty and its secret absent. The completed temporary restart runner and owned failed older Node handoff were removed. Both Node and Wrangler CLI demo Grants were explicitly revoked successfully.

## Limits and deferred work

- Previous Cron autonomy failures remain recorded; their platform root cause is **unproven**. Installed schedules/exported handlers/read-back were not counted as execution evidence.
- Native 60-second alarms are nominal scheduling, not a Cloudflare latency/SLA promise. Provider availability, CPU/storage quotas and valid credentials still apply.
- No production M1 rollout was authorized. An existing production layout needs a separately authorized explicit additive migration; ordinary deploy does not silently add it.
- External Accounts/providers, Tool authoring/import/federation, richer owner UI/notifications, native MCP Tasks, full D12/M2 contracts, full configurable D13 retention/export/restore and required-client launch certification remain outside M1. None is reported complete here.
- No Git commit/push or release certification was performed.
