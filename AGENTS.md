# Agent instructions

- Keep changes small and focused.
- Update `README.md` when adding setup or run commands.
- Do not commit secrets, generated files, or local caches.
- Run relevant checks before finishing when the project has them.

## Public repository safety

- This repository is public. Treat source, documentation, examples, fixtures, screenshots, logs, and every Git commit as publicly readable.
- Never commit real API tokens, passwords, auth/session secrets or cookies, private keys, credential-bearing URLs, private client configurations, customer data, or database dumps/backups.
- Keep real credentials in approved secret stores or ignored files outside tracked source. Secret files must have restrictive permissions (mode `0600`). Local `.env`, `.dev.vars`, `*.secrets.json`, `.state/`, `.wrangler/`, and `.omp/` files must remain untracked.
- Never put secret values in `cloudflare-app.json` `vars`, frontend bundles, tests, documentation, tool arguments, or printed output. Load private credentials locally or use the platform's secret handoff/binding mechanism.
- Examples and fixtures may contain only clearly public, non-production development values or obvious placeholders. Never copy production credentials into tests or reuse public example values in production.
- Before committing or pushing, review the exact staged paths and diff, verify sensitive files are ignored **and untracked**, and run a redacted secret scan of the changes and available Git history (for example, Gitleaks). Stage only explicitly reviewed paths; never force-add ignored private files.
- `.gitignore` does not protect already tracked files or remove secrets from history. If a potential exposure is found, stop publication, report only the file/location and credential type without repeating its value, and arrange revocation/rotation. Removing the current file alone is insufficient; history rewriting requires explicit approval.
- Public service URLs and resource IDs are not credentials, but review deployment metadata and avoid unnecessary personal paths or internal infrastructure details.
