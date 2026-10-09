-- M2 immutable catalogue and the single Run engine delta. Legacy Grants remain unattributed.
ALTER TABLE control_grants ADD COLUMN principal_id TEXT;
ALTER TABLE control_tools ADD COLUMN integration_id TEXT REFERENCES control_integrations(id);
ALTER TABLE control_tool_revisions ADD COLUMN integration_revision_id TEXT;
ALTER TABLE control_tool_revisions ADD COLUMN definition_index INTEGER;
ALTER TABLE control_tool_revisions ADD COLUMN input_schema_format TEXT NOT NULL DEFAULT 'inline_json' CHECK(input_schema_format IN ('inline_json','catalog_reference'));
ALTER TABLE control_profile_tools ADD COLUMN tool_revision TEXT;
ALTER TABLE control_runs ADD COLUMN fingerprint_version TEXT NOT NULL DEFAULT 'm1' CHECK(fingerprint_version IN ('m1','m2'));
ALTER TABLE control_runs ADD COLUMN integration_id TEXT;
ALTER TABLE control_runs ADD COLUMN integration_revision_id TEXT;
ALTER TABLE control_runs ADD COLUMN artifact_digest TEXT;
ALTER TABLE control_runs ADD COLUMN result_format TEXT NOT NULL DEFAULT 'legacy_json' CHECK(result_format IN ('legacy_json','mcp'));
ALTER TABLE control_runs ADD COLUMN wall_timeout_ms INTEGER NOT NULL DEFAULT 60000 CHECK(wall_timeout_ms BETWEEN 1 AND 300000);
ALTER TABLE control_runs ADD COLUMN outbound_remaining INTEGER NOT NULL DEFAULT 30 CHECK(outbound_remaining BETWEEN 0 AND 30);
ALTER TABLE control_runs ADD COLUMN effect_state TEXT NOT NULL DEFAULT 'not_dispatched';
ALTER TABLE control_runs ADD COLUMN effect_evidence_json TEXT;
ALTER TABLE control_runs ADD COLUMN claim_epoch INTEGER;
ALTER TABLE control_runs ADD COLUMN admission_ready INTEGER NOT NULL DEFAULT 1 CHECK(admission_ready IN (0,1));
ALTER TABLE control_run_payloads ADD COLUMN result_format TEXT NOT NULL DEFAULT 'legacy_json' CHECK(result_format IN ('legacy_json','mcp'));
ALTER TABLE control_run_payloads ADD COLUMN request_chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE control_run_payloads ADD COLUMN result_chunk_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE control_run_payload_chunks (
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('request','result')), chunk_index INTEGER NOT NULL,
  cipher TEXT NOT NULL CHECK(length(CAST(cipher AS BLOB))<=262144),
  PRIMARY KEY(run_id,kind,chunk_index)
);
CREATE TRIGGER control_payload_chunk_immutable BEFORE UPDATE ON control_run_payload_chunks BEGIN SELECT RAISE(ABORT,'Protected payload chunks are immutable'); END;
CREATE TABLE control_run_log_chunks (
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  plaintext_bytes INTEGER NOT NULL CHECK(plaintext_bytes BETWEEN 1 AND 65536),
  cipher TEXT NOT NULL CHECK(length(CAST(cipher AS BLOB))<=98304),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,sequence)
);
CREATE TRIGGER control_run_log_chunk_immutable BEFORE UPDATE ON control_run_log_chunks BEGIN SELECT RAISE(ABORT,'Protected Run logs are immutable'); END;
CREATE TABLE control_tool_availability (
  tool_id TEXT NOT NULL REFERENCES control_tools(id), revision TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)), reason TEXT,
  PRIMARY KEY(tool_id,revision)
);
CREATE TRIGGER control_run_m2_request_immutable BEFORE UPDATE OF fingerprint_version,integration_id,integration_revision_id,artifact_digest,wall_timeout_ms,result_format ON control_runs BEGIN
  SELECT RAISE(ABORT, 'Run source references and budgets are immutable');
END;
CREATE TABLE control_integrations (
  id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  current_revision_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX control_integrations_org_slug ON control_integrations(org_id,slug);
CREATE TABLE control_catalog_blobs (
  id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, digest TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 67108864),
  chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 1 AND 1024), created_at INTEGER NOT NULL
);
CREATE TABLE control_catalog_chunks (
  blob_id TEXT NOT NULL REFERENCES control_catalog_blobs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 1023), content TEXT NOT NULL CHECK(length(CAST(content AS BLOB))<=262144),
  PRIMARY KEY(blob_id,chunk_index)
);
CREATE TRIGGER control_catalog_blob_immutable BEFORE UPDATE ON control_catalog_blobs BEGIN SELECT RAISE(ABORT,'Catalogue snapshots are immutable'); END;
CREATE TRIGGER control_catalog_chunk_immutable BEFORE UPDATE ON control_catalog_chunks BEGIN SELECT RAISE(ABORT,'Catalogue snapshots are immutable'); END;
CREATE TABLE control_integration_revisions (
  id TEXT PRIMARY KEY NOT NULL, integration_id TEXT NOT NULL REFERENCES control_integrations(id) ON DELETE CASCADE,
  source_blob_id TEXT NOT NULL REFERENCES control_catalog_blobs(id), source_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','superseded')),
  available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)), created_at INTEGER NOT NULL
);
CREATE INDEX control_integration_revisions_parent ON control_integration_revisions(integration_id,created_at);
CREATE TRIGGER control_integration_source_immutable BEFORE UPDATE OF integration_id,source_blob_id,source_digest,created_at ON control_integration_revisions BEGIN SELECT RAISE(ABORT,'Integration revisions are immutable'); END;
CREATE TABLE control_revision_manifests (
  revision_id TEXT PRIMARY KEY NOT NULL REFERENCES control_integration_revisions(id),
  blob_id TEXT NOT NULL REFERENCES control_catalog_blobs(id), digest TEXT NOT NULL
);
CREATE TRIGGER control_revision_manifest_immutable BEFORE UPDATE ON control_revision_manifests BEGIN SELECT RAISE(ABORT,'Resolved manifests are immutable'); END;
CREATE TABLE control_reviews (
  id TEXT PRIMARY KEY NOT NULL, revision_id TEXT NOT NULL REFERENCES control_integration_revisions(id),
  report_digest TEXT NOT NULL, report_blob_id TEXT NOT NULL REFERENCES control_catalog_blobs(id),
  control_epoch INTEGER NOT NULL, expected_current_revision_id TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX control_reviews_revision_digest ON control_reviews(revision_id,report_digest);
CREATE TRIGGER control_review_immutable BEFORE UPDATE ON control_reviews BEGIN SELECT RAISE(ABORT,'Review reports are immutable'); END;
CREATE TABLE control_publications (
  id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id),
  integration_id TEXT NOT NULL REFERENCES control_integrations(id), revision_id TEXT NOT NULL REFERENCES control_integration_revisions(id),
  review_id TEXT NOT NULL REFERENCES control_reviews(id), created_at INTEGER NOT NULL
);
CREATE TABLE control_profile_bindings (
  profile_id TEXT NOT NULL REFERENCES control_profiles(id) ON DELETE CASCADE,
  requirement_key TEXT NOT NULL, account_id TEXT NOT NULL,
  PRIMARY KEY(profile_id,requirement_key)
);
-- Untrusted-to-authority staging is inert until the one atomic publication CAS wins.
CREATE TABLE control_publication_updates (
  publication_id TEXT NOT NULL, profile_id TEXT NOT NULL, expected_revision INTEGER NOT NULL,
  PRIMARY KEY(publication_id,profile_id)
);
CREATE TABLE control_publication_tool_updates (
  publication_id TEXT NOT NULL, profile_id TEXT NOT NULL, tool TEXT NOT NULL,
  PRIMARY KEY(publication_id,profile_id,tool)
);
CREATE TABLE control_publication_binding_updates (
  publication_id TEXT NOT NULL, profile_id TEXT NOT NULL, requirement_key TEXT NOT NULL, account_id TEXT NOT NULL,
  PRIMARY KEY(publication_id,profile_id,requirement_key)
);
CREATE TABLE control_publication_policy_updates (
  publication_id TEXT NOT NULL, profile_id TEXT NOT NULL, pattern TEXT NOT NULL, decision TEXT NOT NULL,
  PRIMARY KEY(publication_id,profile_id,pattern)
);
