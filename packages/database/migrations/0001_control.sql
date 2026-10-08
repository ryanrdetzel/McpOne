-- M1 control-plane delta. Never alter 0000 or run migrations from request handlers.
CREATE TABLE control_workspaces (
  org_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE control_tools (
  id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, active_revision TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX control_tools_org_name ON control_tools(org_id, name);
CREATE TABLE control_tool_revisions (
  id TEXT PRIMARY KEY NOT NULL, tool_id TEXT NOT NULL REFERENCES control_tools(id) ON DELETE CASCADE,
  revision TEXT NOT NULL, input_schema TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX control_tool_revisions_version ON control_tool_revisions(tool_id, revision);
CREATE TRIGGER control_tool_revision_immutable BEFORE UPDATE ON control_tool_revisions BEGIN
  SELECT RAISE(ABORT, 'Tool revisions are immutable');
END;
CREATE TABLE control_profiles (
  id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  approval_lifetime_ms INTEGER NOT NULL DEFAULT 10800000 CHECK(approval_lifetime_ms BETWEEN 900000 AND 86400000),
  dispatch_paused INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_paused IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX control_profiles_org_label ON control_profiles(org_id, label);
CREATE TABLE control_profile_tools (
  id TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL REFERENCES control_profiles(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL REFERENCES control_tools(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
CREATE UNIQUE INDEX control_profile_tools_membership ON control_profile_tools(profile_id, tool_id);
CREATE TABLE control_grants (
  id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES control_profiles(id) ON DELETE CASCADE,
  label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX control_grants_profile_label ON control_grants(profile_id, label);
CREATE TABLE control_policies (
  id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES control_profiles(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('allow','ask','block')), created_at INTEGER NOT NULL
);
CREATE INDEX control_policies_layer ON control_policies(org_id, profile_id);
CREATE TABLE control_runs (
  id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL REFERENCES control_grants(id), profile_id TEXT NOT NULL REFERENCES control_profiles(id),
  tool TEXT NOT NULL, tool_id TEXT, tool_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_approval','queued','running','succeeded','denied','blocked','expired','canceled','failed','outcome_unknown')),
  fingerprint TEXT, trace_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deadline INTEGER,
  policy_decision TEXT NOT NULL CHECK(policy_decision IN ('allow','ask','block')),
  display_json TEXT NOT NULL,
  admitted_epoch INTEGER NOT NULL, approved_revision TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  lease_owner TEXT, lease_until INTEGER, started_at INTEGER, finished_at INTEGER,
  error_code TEXT, error_message TEXT, error_retryable INTEGER NOT NULL DEFAULT 0 CHECK(error_retryable IN (0,1))
);
CREATE INDEX control_runs_queue ON control_runs(status, created_at);
CREATE INDEX control_runs_org ON control_runs(org_id, created_at);
CREATE TRIGGER control_run_request_immutable BEFORE UPDATE OF org_id, grant_id, profile_id, tool, tool_id, tool_revision, fingerprint, policy_decision, display_json, created_at, deadline, admitted_epoch ON control_runs BEGIN
  SELECT RAISE(ABORT, 'Run requests and deadlines are immutable');
END;
CREATE TABLE control_run_payloads (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_cipher TEXT, result_cipher TEXT, expires_at INTEGER NOT NULL
);
CREATE TRIGGER control_run_payload_immutable BEFORE UPDATE OF request_cipher ON control_run_payloads
WHEN NEW.request_cipher IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Protected requests are immutable');
END;
CREATE TABLE control_approvals (
  id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES control_runs(id) ON DELETE CASCADE,
  requested_revision TEXT NOT NULL, deadline INTEGER NOT NULL, decision TEXT CHECK(decision IN ('approve','deny')),
  created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE TRIGGER control_approval_request_immutable BEFORE UPDATE OF requested_revision, deadline, run_id, org_id ON control_approvals BEGIN
  SELECT RAISE(ABORT, 'Approval request and deadline are immutable');
END;
CREATE TABLE control_dedup (
  id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL REFERENCES control_grants(id), profile_id TEXT NOT NULL REFERENCES control_profiles(id), tool TEXT NOT NULL,
  caller_key TEXT NOT NULL, fingerprint TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES control_runs(id), expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX control_dedup_scope ON control_dedup(org_id, grant_id, profile_id, tool, caller_key);
CREATE TABLE control_audit (
  id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id TEXT, run_id TEXT, action TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX control_audit_run ON control_audit(run_id, created_at);
CREATE TABLE control_attempts (
  id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3), lease_owner TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT
);
CREATE UNIQUE INDEX control_attempts_run_number ON control_attempts(run_id, attempt);
CREATE TABLE control_fixture_effects (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES control_runs(id), org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  value INTEGER NOT NULL, created_at INTEGER NOT NULL
);
