-- Account grants remain actual normalized Provider evidence. This trigger applies
-- only explicit documented GitHub scope inclusions, matching github.ts; never
-- infer prefix/wildcard authority or manufacture extra stored granted scopes.
-- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
DROP TRIGGER control_account_restrictions;
CREATE TRIGGER control_account_restrictions AFTER UPDATE OF enabled, health, scopes_json ON control_accounts
WHEN (OLD.enabled=1 AND NEW.enabled=0)
  OR (OLD.health NOT IN ('revoked','error','expired') AND NEW.health IN ('revoked','error','expired'))
  OR EXISTS(
    SELECT 1 FROM json_each(OLD.scopes_json) old_scope WHERE NOT EXISTS(
      SELECT 1 FROM json_each(NEW.scopes_json) new_scope WHERE new_scope.value=old_scope.value OR (
        NEW.provider='github' AND EXISTS(
          SELECT 1 FROM json_each('{"user":["read:user","user:email","user:follow"],"repo":["repo:status","repo_deployment","public_repo","repo:invite","security_events","admin:repo_hook","write:repo_hook","read:repo_hook"],"admin:repo_hook":["write:repo_hook","read:repo_hook"],"write:repo_hook":["read:repo_hook"],"admin:org":["write:org","read:org"],"write:org":["read:org"],"admin:public_key":["write:public_key","read:public_key"],"write:public_key":["read:public_key"],"admin:gpg_key":["write:gpg_key","read:gpg_key"],"write:gpg_key":["read:gpg_key"],"project":["read:project"]}') coverage
          JOIN json_each(coverage.value) included
          WHERE coverage.key=new_scope.value AND included.value=old_scope.value
        )
      )
    )
  )
BEGIN
  UPDATE control_workspaces SET epoch=epoch+1 WHERE org_id=NEW.org_id;
  UPDATE control_runs SET status='canceled', error_code=CASE WHEN NEW.enabled=0 THEN 'account_disabled' WHEN NEW.health='revoked' THEN 'account_revoked' WHEN NEW.health='error' THEN 'credential_unavailable' WHEN NEW.health='expired' THEN 'account_expired' ELSE 'account_scope_required' END,
    error_message='The fixed Account no longer satisfies current restrictions.', error_retryable=0,
    finished_at=cast((julianday('now') - 2440587.5)*86400000 as integer), updated_at=cast((julianday('now') - 2440587.5)*86400000 as integer)
  WHERE org_id=NEW.org_id AND status IN ('pending_approval','queued') AND EXISTS(
    SELECT 1 FROM control_run_accounts selected WHERE selected.run_id=control_runs.id AND selected.account_id=NEW.id AND (
      NEW.enabled=0 OR NEW.health IN ('revoked','error','expired') OR selected.requirement_json='{}' OR EXISTS(
        SELECT 1 FROM json_each(selected.requirement_json, '$.scopes') required_scope WHERE NOT EXISTS(
          SELECT 1 FROM json_each(NEW.scopes_json) granted_scope WHERE granted_scope.value=required_scope.value OR (
            NEW.provider='github' AND EXISTS(
              SELECT 1 FROM json_each('{"user":["read:user","user:email","user:follow"],"repo":["repo:status","repo_deployment","public_repo","repo:invite","security_events","admin:repo_hook","write:repo_hook","read:repo_hook"],"admin:repo_hook":["write:repo_hook","read:repo_hook"],"write:repo_hook":["read:repo_hook"],"admin:org":["write:org","read:org"],"write:org":["read:org"],"admin:public_key":["write:public_key","read:public_key"],"write:public_key":["read:public_key"],"admin:gpg_key":["write:gpg_key","read:gpg_key"],"write:gpg_key":["read:gpg_key"],"project":["read:project"]}') coverage
              JOIN json_each(coverage.value) included
              WHERE coverage.key=granted_scope.value AND included.value=required_scope.value
            )
          )
        )
      )
    )
  );
END;
