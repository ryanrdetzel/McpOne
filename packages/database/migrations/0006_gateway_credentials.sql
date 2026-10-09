-- Generic MCP bearer custody is distinct from verified Provider Accounts.
CREATE TABLE control_connection_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER control_connection_credential_immutable BEFORE UPDATE ON control_connection_credentials BEGIN
  SELECT RAISE(ABORT,'Connection credentials are immutable');
END;
