-- Native Provider custody; encrypted purpose-v2 blobs do not alter M1 payloads.
CREATE TABLE control_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id TEXT,
  ownership TEXT NOT NULL CHECK(ownership IN ('user','workspace')),
  provider TEXT NOT NULL, method TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
  identity_digest TEXT NOT NULL, scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
  alias TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  health TEXT NOT NULL CHECK(health IN ('unverified','healthy','expired','revoked','error')),
  expires_at INTEGER, credential_version INTEGER NOT NULL DEFAULT 1 CHECK(credential_version > 0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK((ownership='user' AND owner_user_id IS NOT NULL) OR (ownership='workspace' AND owner_user_id IS NULL))
);
CREATE INDEX control_accounts_org ON control_accounts(org_id, created_at);
CREATE TRIGGER control_account_identity_immutable BEFORE UPDATE OF org_id, owner_user_id, ownership, provider, method, identity_json, identity_digest, created_at ON control_accounts BEGIN
  SELECT RAISE(ABORT, 'Account identity is immutable');
END;
CREATE TABLE control_credentials (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES control_accounts(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0), cipher TEXT NOT NULL,
  refresh_lease_id TEXT, refresh_lease_until INTEGER,
  refresh_unusable INTEGER NOT NULL DEFAULT 0 CHECK(refresh_unusable IN (0,1)),
  CHECK((refresh_lease_id IS NULL) = (refresh_lease_until IS NULL))
);
CREATE TRIGGER control_credential_identity_immutable BEFORE UPDATE OF account_id, org_id ON control_credentials BEGIN
  SELECT RAISE(ABORT, 'Credential ownership is immutable');
END;
CREATE TRIGGER control_credential_version BEFORE UPDATE OF version, cipher ON control_credentials
WHEN NEW.version != OLD.version + 1 BEGIN
  SELECT RAISE(ABORT, 'Credential replacement requires next version');
END;
CREATE TRIGGER control_credential_account_version AFTER UPDATE OF version ON control_credentials BEGIN
  UPDATE control_accounts SET credential_version=NEW.version WHERE id=NEW.account_id AND org_id=NEW.org_id;
END;
CREATE TABLE control_run_accounts (
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  requirement TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES control_accounts(id),
  identity_digest TEXT NOT NULL, alias TEXT NOT NULL,
  requirement_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(requirement_json)),
  PRIMARY KEY(run_id, requirement)
);
CREATE INDEX control_run_accounts_account ON control_run_accounts(account_id, run_id);
CREATE TRIGGER control_run_account_immutable BEFORE UPDATE ON control_run_accounts BEGIN
  SELECT RAISE(ABORT, 'Selected Run Accounts are immutable');
END;
-- Only a loss of authority changes the epoch. Alias/refresh/scope additions preserve approval.
CREATE TRIGGER control_account_restrictions AFTER UPDATE OF enabled, health, scopes_json ON control_accounts
WHEN (OLD.enabled=1 AND NEW.enabled=0)
  OR (OLD.health NOT IN ('revoked','error','expired') AND NEW.health IN ('revoked','error','expired'))
  OR EXISTS(SELECT 1 FROM json_each(OLD.scopes_json) old_scope WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.scopes_json) new_scope WHERE new_scope.value=old_scope.value))
BEGIN
  UPDATE control_workspaces SET epoch=epoch+1 WHERE org_id=NEW.org_id;
  UPDATE control_runs SET status='canceled', error_code=CASE WHEN NEW.enabled=0 THEN 'account_disabled' WHEN NEW.health='revoked' THEN 'account_revoked' WHEN NEW.health='error' THEN 'credential_unavailable' WHEN NEW.health='expired' THEN 'account_expired' ELSE 'account_scope_required' END,
    error_message='The fixed Account no longer satisfies current restrictions.', error_retryable=0,
    finished_at=cast((julianday('now') - 2440587.5)*86400000 as integer), updated_at=cast((julianday('now') - 2440587.5)*86400000 as integer)
  WHERE org_id=NEW.org_id AND status IN ('pending_approval','queued') AND EXISTS(
    SELECT 1 FROM control_run_accounts selected WHERE selected.run_id=control_runs.id AND selected.account_id=NEW.id AND (
      NEW.enabled=0 OR NEW.health IN ('revoked','error','expired') OR selected.requirement_json='{}' OR EXISTS(
        SELECT 1 FROM json_each(selected.requirement_json, '$.scopes') required_scope WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.scopes_json) granted_scope WHERE granted_scope.value=required_scope.value)
      )
    )
  );
END;
CREATE TABLE control_oauth_states (
  state_digest TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, session_digest TEXT NOT NULL,
  provider TEXT NOT NULL, registration_id TEXT NOT NULL,
  intent_cipher TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX control_oauth_state_expiry ON control_oauth_states(expires_at);
