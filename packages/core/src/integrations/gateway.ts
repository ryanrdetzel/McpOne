import type { Database } from "@scaffold/database";
import {
  GatewayCreateConnectionInput,
  GatewayCreateProfileInput,
  GatewayState,
} from "@scaffold/schema/gateway";
import type {
  IntegrationDraft,
  ProfileView,
} from "@scaffold/schema/integrations";
import { ControlError } from "../execution/service";
import type { CatalogService } from "./catalog";
import { createConnectionCredentials } from "./connection-credentials";
import type { HttpTransport } from "./transport";

type Owner = { orgId: string; userId: string };
export interface GatewayService {
  list(orgId: string): Promise<GatewayState>;
  createProfile(owner: Owner, input: unknown): Promise<ProfileView>;
  createConnection(owner: Owner, input: unknown): Promise<IntegrationDraft>;
}
export function createGatewayService(options: {
  db: Database;
  secret: string;
  transport: HttpTransport;
  catalog: CatalogService;
  now?: () => number;
}): GatewayService {
  const client = options.db.$client,
    credentials = createConnectionCredentials(options),
    now = options.now ?? Date.now;
  return {
    async list(orgId) {
      const profileRows = await client
        .prepare(
          "SELECT id FROM control_profiles WHERE org_id=? ORDER BY created_at,id",
        )
        .bind(orgId)
        .all<{ id: string }>();
      const profiles: GatewayState["profiles"] = [];
      for (const row of profileRows.results) {
        const profile = await options.catalog.profile(orgId, row.id);
        const policies = await client
          .prepare(
            "SELECT pattern,decision FROM control_policies WHERE org_id=? AND profile_id=? ORDER BY pattern",
          )
          .bind(orgId, row.id)
          .all<{ pattern: string; decision: "allow" | "ask" | "block" }>();
        const grants = await client
          .prepare(
            "SELECT id,label,expires_at,revoked_at FROM control_grants WHERE org_id=? AND profile_id=? ORDER BY created_at,id",
          )
          .bind(orgId, row.id)
          .all<{
            id: string;
            label: string;
            expires_at: number | null;
            revoked_at: number | null;
          }>();
        profiles.push({
          ...profile,
          policies: policies.results,
          grants: grants.results.map((grant) => ({
            grantId: grant.id,
            label: grant.label,
            expiresAt:
              grant.expires_at === null
                ? null
                : new Date(grant.expires_at).toISOString(),
            revoked: grant.revoked_at !== null,
          })),
        });
      }
      const integrationRows = await client
        .prepare(`SELECT i.id,i.slug,i.display_name,i.enabled,i.current_revision_id,
        (SELECT id FROM control_integration_revisions WHERE integration_id=i.id AND status='draft' ORDER BY created_at DESC,id DESC LIMIT 1) AS draft_revision_id
        FROM control_integrations i WHERE i.org_id=? ORDER BY i.created_at,i.id`)
        .bind(orgId)
        .all<{
          id: string;
          slug: string;
          display_name: string;
          enabled: number;
          current_revision_id: string | null;
          draft_revision_id: string | null;
        }>();
      const connections: GatewayState["connections"] = [];
      for (const row of integrationRows.results) {
        const revision = row.draft_revision_id ?? row.current_revision_id;
        if (!revision) continue;
        const chunks = await client
          .prepare(
            "SELECT c.content FROM control_catalog_chunks c JOIN control_integration_revisions r ON r.source_blob_id=c.blob_id WHERE r.id=? AND r.integration_id=? ORDER BY c.chunk_index",
          )
          .bind(revision, row.id)
          .all<{ content: string }>();
        const source = JSON.parse(
          chunks.results.map((chunk) => chunk.content).join(""),
        );
        if (source.kind !== "remote_mcp") continue;
        connections.push({
          integrationId: row.id,
          slug: row.slug,
          displayName: row.display_name,
          enabled: Boolean(row.enabled),
          currentRevisionId: row.current_revision_id,
          draftRevisionId: row.draft_revision_id,
          endpoint: source.endpoint,
          authentication:
            source.connectionCredentialId || source.accountId
              ? "bearer"
              : "none",
        });
      }
      return GatewayState.parse({ profiles, connections });
    },
    async createProfile(owner, input) {
      const parsed = GatewayCreateProfileInput.safeParse(input);
      if (!parsed.success)
        throw new ControlError(
          "invalid_request",
          "A Profile label is required.",
          400,
        );
      const id = crypto.randomUUID(),
        at = now();
      const created = await client.batch([
        client
          .prepare(
            "INSERT OR IGNORE INTO control_workspaces(org_id,epoch,created_at) VALUES(?,0,?)",
          )
          .bind(owner.orgId, at),
        client
          .prepare(
            "INSERT INTO control_profiles(id,org_id,label,enabled,approval_lifetime_ms,dispatch_paused,revision,created_at,updated_at) SELECT ?,?,?,1,10800000,0,1,?,? WHERE NOT EXISTS(SELECT 1 FROM control_profiles WHERE org_id=? AND label=?) RETURNING id",
          )
          .bind(
            id,
            owner.orgId,
            parsed.data.label,
            at,
            at,
            owner.orgId,
            parsed.data.label,
          ),
        client
          .prepare(
            "UPDATE control_workspaces SET epoch=epoch+1 WHERE org_id=? AND EXISTS(SELECT 1 FROM control_profiles WHERE id=?)",
          )
          .bind(owner.orgId, id),
      ]);
      if (!created[1]?.results.length)
        throw new ControlError(
          "invalid_request",
          "That Profile label is already in use.",
          409,
        );
      return options.catalog.profile(owner.orgId, id);
    },
    async createConnection(owner, input) {
      const parsed = GatewayCreateConnectionInput.safeParse(input);
      if (!parsed.success)
        throw new ControlError(
          "invalid_request",
          "A canonical HTTPS connection is required.",
          400,
        );
      const { bearerToken, ...connection } = parsed.data;
      const credentialId =
        bearerToken === undefined
          ? undefined
          : await credentials.create(owner, connection.endpoint, bearerToken);
      try {
        return await options.catalog.create(owner, {
          slug: connection.slug,
          displayName: connection.displayName,
          source: {
            kind: "remote_mcp",
            endpoint: connection.endpoint,
            namespace: connection.slug,
            nameMapping: {},
            ...(credentialId ? { connectionCredentialId: credentialId } : {}),
          },
        });
      } catch (error) {
        if (credentialId)
          await client
            .prepare(
              "DELETE FROM control_connection_credentials WHERE id=? AND org_id=?",
            )
            .bind(credentialId, owner.orgId)
            .run();
        throw error;
      }
    },
  };
}
