CREATE TABLE control_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  grant_id TEXT NOT NULL REFERENCES control_grants(id),
  profile_id TEXT NOT NULL REFERENCES control_profiles(id),
  owner_user_id TEXT,
  run_id TEXT REFERENCES control_runs(id),
  state TEXT NOT NULL CHECK (state IN ('staging', 'ready')),
  format TEXT NOT NULL CHECK (format = 'mcpone-artifact-v1'),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  staging_expires_at INTEGER NOT NULL,
  expires_at INTEGER,
  size_bytes INTEGER CHECK (size_bytes BETWEEN 0 AND 26214400),
  chunk_count INTEGER CHECK (chunk_count BETWEEN 0 AND 50),
  sha256 TEXT,
  metadata_cipher TEXT,
  metadata_digest TEXT,
  content_deleted_at INTEGER,
  cleanup_checked_at INTEGER,
  CHECK ((state = 'staging') OR (completed_at IS NOT NULL AND expires_at IS NOT NULL AND size_bytes IS NOT NULL AND chunk_count IS NOT NULL AND sha256 IS NOT NULL AND metadata_cipher IS NOT NULL AND metadata_digest IS NOT NULL))
);
CREATE INDEX control_artifacts_scope ON control_artifacts(org_id, grant_id, profile_id, id);
CREATE INDEX control_artifacts_cleanup ON control_artifacts(state, staging_expires_at, expires_at);
CREATE INDEX control_artifacts_run ON control_artifacts(org_id, run_id);
CREATE TABLE control_artifact_chunks (
  artifact_id TEXT NOT NULL REFERENCES control_artifacts(id),
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 49),
  plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes BETWEEN 1 AND 524288),
  declared_size INTEGER NOT NULL CHECK (declared_size BETWEEN -1 AND 26214400),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) = plaintext_bytes + 28),
  PRIMARY KEY (artifact_id, chunk_index)
);
CREATE TABLE control_artifact_inputs (
  artifact_id TEXT NOT NULL REFERENCES control_artifacts(id),
  run_id TEXT NOT NULL REFERENCES control_runs(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  grant_id TEXT NOT NULL REFERENCES control_grants(id),
  profile_id TEXT NOT NULL REFERENCES control_profiles(id),
  deadline INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, run_id)
);
CREATE INDEX control_artifact_inputs_deadline ON control_artifact_inputs(deadline, artifact_id);
CREATE TABLE control_artifact_run_inputs (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES control_runs(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  grant_id TEXT NOT NULL REFERENCES control_grants(id),
  profile_id TEXT NOT NULL REFERENCES control_profiles(id),
  refs_cipher TEXT NOT NULL,
  refs_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (length(refs_cipher) <= 32768 AND length(refs_digest) = 64)
);
CREATE TRIGGER control_artifact_run_inputs_immutable BEFORE UPDATE ON control_artifact_run_inputs BEGIN
  SELECT RAISE(ABORT, 'artifact_run_inputs_immutable');
END;
CREATE TRIGGER control_artifact_run_inputs_scope_insert BEFORE INSERT ON control_artifact_run_inputs BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM control_runs r WHERE r.id = NEW.run_id AND r.org_id = NEW.org_id AND r.grant_id = NEW.grant_id AND r.profile_id = NEW.profile_id AND r.status IN ('pending_approval', 'queued', 'running')) THEN RAISE(ABORT, 'artifact_run_inputs_scope') END);
END;
CREATE TRIGGER control_artifacts_scope_insert BEFORE INSERT ON control_artifacts BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM control_grants g JOIN control_profiles p ON p.id = g.profile_id WHERE g.id = NEW.grant_id AND g.org_id = NEW.org_id AND g.profile_id = NEW.profile_id AND p.org_id = NEW.org_id) THEN RAISE(ABORT, 'artifact_scope') END);
  SELECT (CASE WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM control_runs r WHERE r.id = NEW.run_id AND r.org_id = NEW.org_id AND r.grant_id = NEW.grant_id AND r.profile_id = NEW.profile_id) THEN RAISE(ABORT, 'artifact_run_scope') END);
END;
CREATE TRIGGER control_artifact_inputs_scope_insert BEFORE INSERT ON control_artifact_inputs BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM control_artifacts a JOIN control_runs r ON r.id = NEW.run_id WHERE a.id = NEW.artifact_id AND a.org_id = NEW.org_id AND a.grant_id = NEW.grant_id AND a.profile_id = NEW.profile_id AND r.org_id = NEW.org_id AND r.grant_id = NEW.grant_id AND r.profile_id = NEW.profile_id AND coalesce(r.deadline, r.lease_until) = NEW.deadline AND r.status IN ('pending_approval', 'queued', 'running')) THEN RAISE(ABORT, 'artifact_input_scope') END);
END;
