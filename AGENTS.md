# Agent instructions

- Keep changes small and focused.
- Update `README.md` when adding setup or run commands.
- Do not commit secrets, generated files, or local caches.
- Validate every change locally before finishing; preserve the production deployment path.

## Architecture blueprint and decision approval

- Read [ARCHITECTURE.md](ARCHITECTURE.md) before planning or implementing substantive changes. It is the canonical blueprint for the intended codebase and system, not merely a description of the current implementation.
- Validate technical decisions and proposed work against the blueprint's component boundaries, contracts, security constraints, and local/production lifecycle. Include the relevant blueprint sections in the Linear issue and explain how the approach fits.
- If the blueprint does not work, does not fit the requirements, conflicts with another requirement, or leaves a consequential decision unresolved, pause the affected work and validate it with a human before implementing a workaround or deviation. Present the conflict, evidence, options, tradeoffs, and a recommendation; record the human's explicit decision in the issue. Continue only unaffected work while waiting.
- Do not silently change the blueprint to justify an implementation, assume approval, or treat existing code drift as the intended design. An architectural deviation requires explicit human approval before proceeding.
- Maintain `ARCHITECTURE.md` as a separate, current document. Update it when an approved decision changes the intended design, including rationale and the approving issue/decision reference; keep related README guidance and tickets aligned. Distinguish intended design, known implementation gaps, and unresolved questions.

## Linear task management

- Use the [McpOne Linear project](https://linear.app/detzel/project/mcpone-093e9308edc9/overview) as the source of truth for project tasks and work. Project: `P-DET-6` (`796b98e4-efc3-4859-b25a-489ad18d21cc`); team: `DET` (Detzel).
- Before starting substantive work, find the relevant issue in this project and reuse it; create a project-linked issue if none exists. Avoid duplicate tickets and keep all new project work associated with McpOne.
- Keep tickets structured: clear action-oriented title, problem/context, scope and non-goals, acceptance criteria, and verification plan. Use sub-issues for independently deliverable work; record dependencies and blockers.
- Use the team's actual workflow: `Backlog` for unprioritized work, `Todo` for ready work, `In Progress` when implementation starts, and `In Review` only when the work is ready and awaiting review. Re-read available statuses if the workflow changes.
- Keep the issue current with meaningful progress, decisions, blockers, and relevant code/PR links. For blocked work, document the missing prerequisite and next action; do not mark it complete or invent a blocked status.
- Close tickets promptly as `Done` only after their scope and acceptance criteria are satisfied and required verification has passed. Add a completion comment recording the changes and observed verification results; disclose any checks that could not run and leave unfinished work open.
- Use `Canceled` for work explicitly abandoned and `Duplicate` for confirmed duplicates, linking the canonical issue. Do not close unrelated tickets or change the overall project status merely because one issue is finished.

## Local development and deployment goal

- The application must remain runnable and testable by an agent from a fresh checkout using the documented Node/pnpm versions, public development bindings, and local Workers/D1. Local validation must not require Docker, a Cloudflare login, production credentials, or access to production data.
- For every change, run `pnpm check`, then start the real local application and run `pnpm smoke` against it. Exercise the changed behavior directly; for UI changes, inspect the rendered page and relevant interactions in a browser. Add or update behavior tests when needed.
- Follow the setup and validation sequence in `README.md`. Finish builds before starting Wrangler; restart it after any frontend rebuild so its asset manifest stays current. If port 3000 is occupied, use the documented alternate-port command with matching auth/trusted origins and `SMOKE_BASE_URL`. Ensure agent-launched shells use the supported Node version.
- Keep the Cloudflare Workers/D1 production bundle, assets, migrations, and bindings deployable. Run `pnpm cf:check` with the documented local lifecycle checkout and private binding files; it validates without uploading or deploying. Local startup and deployment validation must exercise the same application logic, not local-only substitutes.
- Run mutating smoke checks only against disposable local or isolated preview databases, never production. Do not upload or deploy merely to validate a change.
- Keep setup/run/validation documentation current when workflows change. Report the commands and observed results; if a prerequisite prevents a check, name it explicitly and do not claim that check passed or deployability was verified.

## Public repository safety

- This repository is public. Treat source, documentation, examples, fixtures, screenshots, logs, and every Git commit as publicly readable.
- Never commit real API tokens, passwords, auth/session secrets or cookies, private keys, credential-bearing URLs, private client configurations, customer data, or database dumps/backups.
- Keep real credentials in approved secret stores or ignored files outside tracked source. Secret files must have restrictive permissions (mode `0600`). Local `.env`, `.dev.vars`, `*.secrets.json`, `.state/`, `.wrangler/`, and `.omp/` files must remain untracked.
- Never put secret values in `cloudflare-app.json` `vars`, frontend bundles, tests, documentation, tool arguments, or printed output. Load private credentials locally or use the platform's secret handoff/binding mechanism.
- Examples and fixtures may contain only clearly public, non-production development values or obvious placeholders. Never copy production credentials into tests or reuse public example values in production.
- Before committing or pushing, review the exact staged paths and diff, verify sensitive files are ignored **and untracked**, and run a redacted secret scan of the changes and available Git history (for example, Gitleaks). Stage only explicitly reviewed paths; never force-add ignored private files.
- `.gitignore` does not protect already tracked files or remove secrets from history. If a potential exposure is found, stop publication, report only the file/location and credential type without repeating its value, and arrange revocation/rotation. Removing the current file alone is insufficient; history rewriting requires explicit approval.
- Public service URLs and resource IDs are not credentials, but review deployment metadata and avoid unnecessary personal paths or internal infrastructure details.
