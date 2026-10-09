import type { D1PreparedStatement as Statement } from "@cloudflare/workers-types";
import { sha256 as incrementalSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Database } from "@scaffold/database";
import type { OAuthScopeImpact } from "@scaffold/schema/integrations";
import {
  CreateIntegrationInput,
  type FrozenTool,
  type IntegrationView,
  isJsonObject,
  jsonProblem,
  PatchIntegrationInput,
  type ProfileView,
  type Publication,
  PublishIntegrationInput,
  RefreshIntegrationInput,
  type Requirement,
  type ReviewReport,
  RollbackIntegrationInput,
  type SelectedAccount,
  Source,
  ToolDefinition,
  UpdateBindingsInput,
} from "@scaffold/schema/integrations";
import { canonicalJson } from "../execution/canonical";
import { ControlError } from "../execution/service";
import { parseStrictJson } from "../strict-json";
import {
  assertDerivedMetadataBudget,
  canonicalFragments,
  DerivedMetadataBudgetError,
} from "./derived-budget";
import type { OAuthImpactPreviewer } from "./oauth";
import { ImportError } from "./reference-resolver";
export type OwnerContext = { orgId: string; userId: string; slug: string };
export type ResolvedSource = {
  accepted: ToolDefinition[];
  rejected: ReviewReport["rejected"];
  diagnostics?: ReviewReport["diagnostics"];
  snapshot: unknown;
};
export interface SourceResolver {
  resolveTools(source: Source, owner: OwnerContext): Promise<ResolvedSource>;
}
export interface AccountAuthority {
  resolveBindings(input: {
    orgId: string;
    principalId: string | null;
    requirements: Record<string, Requirement>;
    bindings: Record<string, string>;
    integrationSlug: string;
  }): Promise<Record<string, SelectedAccount>>;
  resolveBoundIdentities(input: {
    orgId: string;
    principalId: string | null;
    requirements: Record<string, Requirement>;
    bindings: Record<string, string>;
    integrationSlug: string;
  }): Promise<Record<string, SelectedAccount>>;
  verifySelections(input: {
    orgId: string;
    principalId: string | null;
    requirements: Record<string, Requirement>;
    selections: Record<string, SelectedAccount>;
  }): Promise<void>;
}
export interface CatalogService {
  create(
    owner: Omit<OwnerContext, "slug">,
    input: unknown,
  ): Promise<{ integrationId: string; draftRevisionId: string }>;
  get(orgId: string, id: string): Promise<IntegrationView>;
  validate(
    owner: Omit<OwnerContext, "slug">,
    id: string,
    revisionId: string,
  ): Promise<ReviewReport>;
  refresh(
    owner: Omit<OwnerContext, "slug">,
    id: string,
    input: unknown,
  ): Promise<{ integrationId: string; draftRevisionId: string }>;
  publish(
    owner: Omit<OwnerContext, "slug">,
    id: string,
    input: unknown,
    rollback?: boolean,
  ): Promise<Publication>;
  patch(
    orgId: string,
    id: string,
    input: unknown,
  ): Promise<{ integrationId: string; enabled: boolean; displayName: string }>;
  profile(orgId: string, id: string): Promise<ProfileView>;
  updateBindings(
    owner: Omit<OwnerContext, "slug">,
    id: string,
    input: unknown,
  ): Promise<{ profileId: string; revision: number }>;
  resolveTool(
    orgId: string,
    profileId: string,
    name: string,
  ): Promise<{
    tool: FrozenTool;
    enabled: boolean;
    available: boolean;
    slug: string;
  } | null>;
  retainedTool(
    orgId: string,
    toolId: string,
    revision: string,
  ): Promise<FrozenTool | null>;
  snapshot(orgId: string, revisionId: string): Promise<ResolvedSource>;
  bindings(orgId: string, profileId: string): Promise<Record<string, string>>;
  names(orgId: string, profileId: string): Promise<string[]>;
  discover(
    orgId: string,
    profileId: string,
    names?: readonly string[],
  ): Promise<FrozenTool[]>;
  previewOAuthImpact: OAuthImpactPreviewer;
  cleanup(): Promise<void>;
}
type Bound = string | number | null;
type IntegrationRow = {
  id: string;
  org_id: string;
  slug: string;
  display_name: string;
  enabled: number;
  current_revision_id: string | null;
};
type RevisionRow = {
  id: string;
  integration_id: string;
  source_blob_id: string;
  source_digest: string;
  status: "draft" | "published" | "superseded";
  available: number;
  created_at: number;
};
const SQL_NOW = "cast((julianday('now') - 2440587.5) * 86400000 as integer)";
const fail = (
  code:
    | "invalid_request"
    | "not_found"
    | "publication_conflict"
    | "name_collision"
    | "tool_unavailable"
    | "import_invalid",
  status = 400,
) =>
  new ControlError(
    code,
    {
      invalid_request: "Invalid catalogue request.",
      not_found: "The requested resource was not found.",
      publication_conflict:
        "The reviewed configuration changed. Validate and review the current state again.",
      name_collision:
        "The canonical name already belongs to another Integration.",
      tool_unavailable: "The retained revision is unavailable.",
      import_invalid: "The source cannot be imported safely.",
    }[code],
    status,
  );
function jsonGroups(values: readonly unknown[]): string[] {
  const groups: string[] = [],
    encoder = new TextEncoder();
  let parts: string[] = [],
    bytes = 2;
  for (const value of values) {
    const text = canonicalJson(value),
      size = encoder.encode(text).length + 1;
    if (size > 1572864) throw fail("invalid_request");
    if (bytes + size > 1572864) {
      groups.push("[" + parts.join(",") + "]");
      parts = [];
      bytes = 2;
    }
    parts.push(text);
    bytes += size;
  }
  if (parts.length) groups.push("[" + parts.join(",") + "]");
  return groups;
}
/** Exact canonicalJson bytes, hashed incrementally without a whole UTF-8/WebCrypto copy. */
function encodeCanonical(
  value: unknown,
  onChunk?: (content: string, index: number, sizeBytes: number) => void,
) {
  const encoder = new TextEncoder(),
    hash = incrementalSha256.create();
  let parts: string[] = [],
    units = 0,
    sizeBytes = 0,
    chunkCount = 0;
  function flush() {
    if (!units) return;
    const content = parts.join(""),
      bytes = encoder.encode(content);
    sizeBytes += bytes.length;
    if (sizeBytes > 64 * 1024 * 1024)
      throw new ControlError(
        "payload_too_large",
        "The serialized catalogue snapshot exceeds the implementation storage envelope.",
        413,
      );
    hash.update(bytes);
    onChunk?.(content, chunkCount, bytes.length);
    chunkCount++;
    parts = [];
    units = 0;
  }
  for (const fragment of canonicalFragments(value))
    for (let start = 0; start < fragment.length; ) {
      let end = Math.min(start + 65536 - units, fragment.length);
      if (
        end < fragment.length &&
        fragment.charCodeAt(end - 1) >= 0xd800 &&
        fragment.charCodeAt(end - 1) <= 0xdbff
      )
        end--;
      if (end === start) {
        flush();
        continue;
      }
      parts.push(fragment.slice(start, end));
      units += end - start;
      start = end;
      if (units === 65536) flush();
    }
  flush();
  return { digest: bytesToHex(hash.digest()), sizeBytes, chunkCount };
}
const canonicalDigest = (value: unknown) => encodeCanonical(value).digest;
/** Source, manifest, reference/code closure and report rows remain below the D1 row ceiling. */
export function createCatalogService({
  db,
  sources,
  accounts,
  remoteDrift,
  now = Date.now,
}: {
  db: Database;
  sources: SourceResolver;
  accounts: AccountAuthority;
  remoteDrift?: (
    previous: ToolDefinition[],
    next: ResolvedSource,
  ) => {
    oldAvailability: {
      tool: string;
      available: boolean;
      classification: string;
    }[];
  };
  now?: () => number;
}): CatalogService {
  const client = db.$client;
  const stmt = (sql: string, ...values: Bound[]) =>
    values.length ? client.prepare(sql).bind(...values) : client.prepare(sql);
  const row = <T>(sql: string, ...values: Bound[]) =>
    stmt(sql, ...values).first<T>();
  const rows = async <T>(sql: string, ...values: Bound[]) =>
    (await stmt(sql, ...values).all<T>()).results;
  async function integration(orgId: string, id: string) {
    const value = await row<IntegrationRow>(
      "SELECT * FROM control_integrations WHERE id=? AND org_id=?",
      id,
      orgId,
    );
    if (!value) throw fail("not_found", 404);
    return value;
  }
  async function revision(orgId: string, id: string, revisionId: string) {
    await integration(orgId, id);
    const value = await row<RevisionRow>(
      "SELECT * FROM control_integration_revisions WHERE id=? AND integration_id=?",
      revisionId,
      id,
    );
    if (!value) throw fail("not_found", 404);
    return value;
  }
  async function blob(orgId: string, kind: string, value: unknown) {
    if (jsonProblem(value, 64 * 1024 * 1024, 128)) throw fail("import_invalid");
    const chunks: { content: string; index: number; sizeBytes: number }[] = [],
      encoded = encodeCanonical(value, (content, index, sizeBytes) =>
        chunks.push({ content, index, sizeBytes }),
      ),
      id = crypto.randomUUID();
    await stmt(
      "INSERT INTO control_catalog_blobs(id,org_id,kind,digest,size_bytes,chunk_count,created_at) VALUES(?,?,?,?,?,?,?)",
      id,
      orgId,
      kind,
      encoded.digest,
      encoded.sizeBytes,
      encoded.chunkCount,
      now(),
    ).run();
    const group: typeof chunks = [];
    let bytes = 0;
    async function flush() {
      if (!group.length) return;
      const values: Bound[] = [];
      for (const chunk of group) values.push(chunk.index, chunk.content);
      await stmt(
        `WITH chunks(chunk_index,content) AS(VALUES ${group.map(() => "(?,?)").join(",")}) INSERT INTO control_catalog_chunks(blob_id,chunk_index,content) SELECT ?,chunk_index,content FROM chunks`,
        ...values,
        id,
      ).run();
      for (const chunk of group) chunk.content = "";
      group.length = 0;
      bytes = 0;
    }
    for (const chunk of chunks) {
      if (group.length === 48 || bytes + chunk.sizeBytes > 1572864)
        await flush();
      group.push(chunk);
      bytes += chunk.sizeBytes;
    }
    await flush();
    // These rows are inert until an immutable revision/manifest/review references this complete blob.
    return { id, digest: encoded.digest };
  }
  async function readBlob<T>(orgId: string, id: string): Promise<T> {
    const meta = await row<{
      digest: string;
      size_bytes: number;
      chunk_count: number;
    }>(
      "SELECT digest,size_bytes,chunk_count FROM control_catalog_blobs WHERE id=? AND org_id=?",
      id,
      orgId,
    );
    if (!meta) throw fail("tool_unavailable", 409);
    const chunks = await rows<{ chunk_index: number; content: string }>(
      "SELECT chunk_index,content FROM control_catalog_chunks WHERE blob_id=? ORDER BY chunk_index",
      id,
    );
    if (
      chunks.length !== meta.chunk_count ||
      chunks.some((c, i) => c.chunk_index !== i)
    )
      throw fail("tool_unavailable", 409);
    const hash = incrementalSha256.create(),
      encoder = new TextEncoder();
    let size = 0;
    for (const chunk of chunks) {
      const bytes = encoder.encode(chunk.content);
      size += bytes.length;
      hash.update(bytes);
    }
    if (size !== meta.size_bytes || bytesToHex(hash.digest()) !== meta.digest)
      throw fail("tool_unavailable", 409);
    const content = chunks.map((c) => c.content).join("");
    chunks.length = 0;
    const value = parseStrictJson(content, 128);
    if (jsonProblem(value, 64 * 1024 * 1024, 128)) throw fail("import_invalid");
    return value as T;
  }
  async function stage(orgId: string, id: string, source: Source) {
    const snapshot = await blob(orgId, "source", source),
      revisionId = crypto.randomUUID();
    await stmt(
      "INSERT INTO control_integration_revisions(id,integration_id,source_blob_id,source_digest,created_at) VALUES(?,?,?,?,?)",
      revisionId,
      id,
      snapshot.id,
      snapshot.digest,
      now(),
    ).run();
    return { integrationId: id, draftRevisionId: revisionId };
  }
  async function create(owner: Omit<OwnerContext, "slug">, input: unknown) {
    if (jsonProblem(input, 12 * 1024 * 1024, 128))
      throw fail("invalid_request");
    const parsed = CreateIntegrationInput.safeParse(input);
    if (!parsed.success) throw fail("invalid_request");
    if (
      await row(
        "SELECT id FROM control_integrations WHERE org_id=? AND slug=?",
        owner.orgId,
        parsed.data.slug,
      )
    )
      throw fail("name_collision", 409);
    const id = crypto.randomUUID(),
      at = now(),
      source = await blob(owner.orgId, "source", parsed.data.source),
      revisionId = crypto.randomUUID();
    await client.batch([
      stmt(
        "INSERT OR IGNORE INTO control_workspaces(org_id,epoch,created_at) VALUES(?,0,?)",
        owner.orgId,
        at,
      ),
      stmt(
        "INSERT INTO control_integrations(id,org_id,slug,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        id,
        owner.orgId,
        parsed.data.slug,
        parsed.data.displayName,
        at,
        at,
      ),
      stmt(
        "INSERT INTO control_integration_revisions(id,integration_id,source_blob_id,source_digest,created_at) VALUES(?,?,?,?,?)",
        revisionId,
        id,
        source.id,
        source.digest,
        at,
      ),
    ]);
    return { integrationId: id, draftRevisionId: revisionId };
  }
  async function get(orgId: string, id: string): Promise<IntegrationView> {
    const i = await integration(orgId, id),
      revisions = await rows<RevisionRow & { digest: string }>(
        "SELECT r.*,coalesce(m.digest,r.source_digest) AS digest FROM control_integration_revisions r LEFT JOIN control_revision_manifests m ON m.revision_id=r.id WHERE r.integration_id=? ORDER BY r.created_at,r.id",
        id,
      );
    const summary = (r: RevisionRow & { digest: string }) => ({
      revisionId: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      status: r.status,
      digest: r.digest,
      available: Boolean(r.available),
    });
    return {
      integrationId: id,
      slug: i.slug,
      displayName: i.display_name,
      enabled: Boolean(i.enabled),
      currentRevisionId: i.current_revision_id,
      drafts: revisions.filter((r) => r.status === "draft").map(summary),
      revisions: revisions.filter((r) => r.status !== "draft").map(summary),
    };
  }
  async function snapshot(orgId: string, revisionId: string) {
    const manifest = await row<{ blob_id: string }>(
      "SELECT m.blob_id FROM control_revision_manifests m JOIN control_integration_revisions r ON r.id=m.revision_id JOIN control_integrations i ON i.id=r.integration_id WHERE r.id=? AND i.org_id=?",
      revisionId,
      orgId,
    );
    if (!manifest) throw fail("tool_unavailable", 409);
    return readBlob<ResolvedSource>(orgId, manifest.blob_id);
  }
  async function impact(
    orgId: string,
    id: string,
  ): Promise<ReviewReport["affectedProfiles"]> {
    const profiles = await rows<{
      profileId: string;
      revision: number;
      grantCount: number;
      tools_json: string;
    }>(
      `SELECT p.id AS profileId,p.revision,
      (SELECT count(*) FROM control_grants g WHERE g.profile_id=p.id AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>max(?,${SQL_NOW}))) AS grantCount,
      (SELECT json_group_array(name) FROM(SELECT t.name FROM control_profile_tools pt JOIN control_tools t ON t.id=pt.tool_id WHERE pt.profile_id=p.id AND t.integration_id=? AND pt.enabled=1 ORDER BY t.name)) AS tools_json
      FROM control_profiles p WHERE p.org_id=? AND EXISTS(SELECT 1 FROM control_profile_tools pt JOIN control_tools t ON t.id=pt.tool_id WHERE pt.profile_id=p.id AND t.integration_id=?) ORDER BY p.id`,
      now(),
      id,
      orgId,
      id,
    );
    return profiles.map((p) => ({
      profileId: p.profileId,
      revision: p.revision,
      grantCount: p.grantCount,
      tools: parseStrictJson(p.tools_json) as string[],
    }));
  }
  async function validate(
    owner: Omit<OwnerContext, "slug">,
    id: string,
    revisionId: string,
  ): Promise<ReviewReport> {
    const i = await integration(owner.orgId, id),
      r = await revision(owner.orgId, id, revisionId);
    if (!r.available) throw fail("tool_unavailable", 409);
    let source: Source | undefined, normalized: ResolvedSource;
    const existing = await row(
      "SELECT revision_id FROM control_revision_manifests WHERE revision_id=?",
      revisionId,
    );
    if (existing) normalized = await snapshot(owner.orgId, revisionId);
    else {
      source = Source.parse(await readBlob(owner.orgId, r.source_blob_id));
      try {
        normalized = await sources.resolveTools(source, {
          ...owner,
          slug: i.slug,
        });
      } catch (error) {
        if (error instanceof DerivedMetadataBudgetError)
          throw new ControlError(error.code, error.message, error.status);
        if (error instanceof ControlError) throw error;
        if (error instanceof ImportError)
          throw new ControlError(
            [
              "reference_limit",
              "reference_forbidden",
              "schema_limit",
              "unsupported_schema",
              "unsupported_feature",
            ].includes(error.code)
              ? (error.code as
                  | "reference_limit"
                  | "reference_forbidden"
                  | "schema_limit"
                  | "unsupported_schema"
                  | "unsupported_feature")
              : "import_invalid",
            "The source cannot be imported within its reviewed format and limits.",
            400,
          );
        throw error;
      }
      if (
        normalized.accepted.length > 500 ||
        new Set(normalized.accepted.map((t) => t.name)).size !==
          normalized.accepted.length
      )
        throw fail("import_invalid");
      try {
        assertDerivedMetadataBudget({
          accepted: normalized.accepted,
          rejected: normalized.rejected,
          ...(normalized.diagnostics?.length
            ? { diagnostics: normalized.diagnostics }
            : {}),
        });
      } catch (error) {
        if (error instanceof DerivedMetadataBudgetError)
          throw new ControlError(error.code, error.message, error.status);
        throw error;
      }
      for (const tool of normalized.accepted)
        if (
          !ToolDefinition.safeParse(tool).success ||
          !tool.name.startsWith(i.slug + ".")
        )
          throw fail("import_invalid");
      const stored = await blob(owner.orgId, "manifest", normalized);
      await stmt(
        "INSERT OR IGNORE INTO control_revision_manifests(revision_id,blob_id,digest) VALUES(?,?,?)",
        revisionId,
        stored.id,
        stored.digest,
      ).run();
      normalized = await snapshot(owner.orgId, revisionId);
    }
    if (!existing && source?.kind === "remote_mcp" && remoteDrift) {
      const retained = await rows<{ id: string }>(
          "SELECT id FROM control_integration_revisions WHERE integration_id=? AND status<>'draft'",
          id,
        ),
        suspensions: Statement[] = [];
      for (const old of retained) {
        const previous = await snapshot(owner.orgId, old.id);
        for (const drift of remoteDrift(previous.accepted, normalized)
          .oldAvailability)
          if (!drift.available)
            suspensions.push(
              stmt(
                "INSERT INTO control_tool_availability(tool_id,revision,available,reason) SELECT id,?,0,? FROM control_tools WHERE integration_id=? AND name=? ON CONFLICT(tool_id,revision) DO UPDATE SET available=0,reason=excluded.reason",
                old.id,
                drift.classification,
                id,
                drift.tool,
              ),
            );
      }
      if (suspensions.length)
        await client.batch([
          ...suspensions,
          stmt(
            "UPDATE control_workspaces SET epoch=epoch+1 WHERE org_id=?",
            owner.orgId,
          ),
          stmt(
            "UPDATE control_runs SET status='blocked',error_code='tool_unavailable',error_message='The retained remote definition is unavailable.',error_retryable=0,finished_at=?,updated_at=? WHERE org_id=? AND integration_id=? AND status IN ('pending_approval','queued') AND EXISTS(SELECT 1 FROM control_tool_availability a WHERE a.tool_id=control_runs.tool_id AND a.revision=control_runs.tool_revision AND a.available=0)",
            now(),
            now(),
            owner.orgId,
            id,
          ),
        ]);
    }
    // Bracket the impact reads by the monotonic epoch; a report is not authority if this changes.
    for (let attempt = 0; attempt < 5; attempt++) {
      const epoch = await row<{ epoch: number }>(
          "SELECT epoch FROM control_workspaces WHERE org_id=?",
          owner.orgId,
        ),
        current = await integration(owner.orgId, id),
        affectedProfiles = await impact(owner.orgId, id);
      const previous = current.current_revision_id
        ? await snapshot(owner.orgId, current.current_revision_id)
        : { accepted: [] };
      const old = new Map(
          previous.accepted.map((t) => [t.name, canonicalDigest(t)]),
        ),
        next = new Map(
          normalized.accepted.map((t) => [t.name, canonicalDigest(t)]),
        );
      const changes: ReviewReport["changes"] = [...next].map(
        ([tool, value]) => ({
          tool,
          kind: old.has(tool)
            ? old.get(tool) === value
              ? "unchanged"
              : "changed"
            : "new",
        }),
      );
      for (const tool of old.keys())
        if (!next.has(tool)) changes.push({ tool, kind: "removed" });
      changes.sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
      const manifest = await row<{ digest: string }>(
        "SELECT digest FROM control_revision_manifests WHERE revision_id=?",
        revisionId,
      );
      const base = {
        integrationId: id,
        draftRevisionId: revisionId,
        accepted: normalized.accepted,
        rejected: normalized.rejected,
        ...(normalized.diagnostics?.length
          ? { diagnostics: normalized.diagnostics }
          : {}),
        changes,
        affectedProfiles,
      };
      try {
        assertDerivedMetadataBudget({ ...base, reportDigest: "0".repeat(64) });
      } catch (error) {
        if (error instanceof DerivedMetadataBudgetError)
          throw new ControlError(error.code, error.message, error.status);
        throw error;
      }
      const reportDigest = canonicalDigest({
        report: base,
        sourceDigest: r.source_digest,
        manifestDigest: manifest!.digest,
        controlEpoch: epoch!.epoch,
        currentRevisionId: current.current_revision_id,
      });
      const report = { ...base, reportDigest },
        stored = await blob(owner.orgId, "report", report),
        reviewId = crypto.randomUUID();
      const guard =
        "EXISTS(SELECT 1 FROM control_workspaces WHERE org_id=? AND epoch=?) AND EXISTS(SELECT 1 FROM control_integrations WHERE id=? AND current_revision_id IS ?)";
      await stmt(
        `INSERT INTO control_reviews(id,revision_id,report_digest,report_blob_id,control_epoch,expected_current_revision_id,created_at) SELECT ?,?,?,?,?,?,? WHERE ${guard}`,
        reviewId,
        revisionId,
        reportDigest,
        stored.id,
        epoch!.epoch,
        current.current_revision_id,
        now(),
        owner.orgId,
        epoch!.epoch,
        id,
        current.current_revision_id,
      ).run();
      if (await row("SELECT id FROM control_reviews WHERE id=?", reviewId))
        return report;
    }
    throw fail("publication_conflict", 409);
  }
  async function refresh(
    owner: Omit<OwnerContext, "slug">,
    id: string,
    input: unknown,
  ) {
    const i = await integration(owner.orgId, id),
      request = RefreshIntegrationInput.safeParse(input);
    if (!request.success) throw fail("invalid_request");
    let source: unknown = request.data.source;
    if (source === undefined) {
      const latest = await row<RevisionRow>(
        "SELECT * FROM control_integration_revisions WHERE integration_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
        id,
      );
      if (!latest) throw fail("not_found", 404);
      source = await readBlob(owner.orgId, latest.source_blob_id);
    }
    const parsed = Source.safeParse(source);
    if (
      !parsed.success ||
      !CreateIntegrationInput.safeParse({
        slug: i.slug,
        displayName: i.display_name,
        source: parsed.success ? parsed.data : source,
      }).success
    )
      throw fail("invalid_request");
    const staged = await stage(owner.orgId, id, parsed.data);
    await validate(owner, id, staged.draftRevisionId);
    return staged;
  }
  async function bindings(orgId: string, profileId: string) {
    if (
      !(await row(
        "SELECT id FROM control_profiles WHERE id=? AND org_id=?",
        profileId,
        orgId,
      ))
    )
      throw fail("not_found", 404);
    const bindings = Object.create(null) as Record<string, string>;
    for (const b of await rows<{ requirement_key: string; account_id: string }>(
      "SELECT requirement_key,account_id FROM control_profile_bindings WHERE profile_id=? ORDER BY requirement_key",
      profileId,
    ))
      bindings[b.requirement_key] = b.account_id;
    return bindings;
  }
  async function profile(orgId: string, id: string): Promise<ProfileView> {
    const p = await row<{ label: string; revision: number; enabled: number }>(
      "SELECT label,revision,enabled FROM control_profiles WHERE id=? AND org_id=?",
      id,
      orgId,
    );
    if (!p) throw fail("not_found", 404);
    const tools = await rows<{ name: string }>(
      "SELECT t.name FROM control_profile_tools pt JOIN control_tools t ON t.id=pt.tool_id WHERE pt.profile_id=? AND t.org_id=? AND pt.enabled=1 ORDER BY t.name",
      id,
      orgId,
    );
    return {
      profileId: id,
      label: p.label,
      revision: p.revision,
      enabled: Boolean(p.enabled),
      tools: tools.map((t) => t.name),
      bindings: await bindings(orgId, id),
    };
  }
  async function validateProfileBindings(
    owner: Omit<OwnerContext, "slug">,
    profileId: string,
    slug: string,
    tools: ToolDefinition[],
    bindings: Record<string, string>,
  ) {
    const used = new Set(
      tools.flatMap((t) =>
        Object.keys(t.requirements).map((r) => slug + "." + r),
      ),
    );
    if (Object.keys(bindings).some((k) => !used.has(k)))
      throw fail("invalid_request");
    const checked = new Set<string>();
    for (const tool of tools)
      for (const [key, requirement] of Object.entries(tool.requirements)) {
        const identity = key + ":" + canonicalJson(requirement);
        if (checked.has(identity)) continue;
        checked.add(identity);
        await accounts.resolveBindings({
          orgId: owner.orgId,
          principalId: owner.userId,
          requirements: { [key]: requirement },
          bindings,
          integrationSlug: slug,
        });
      }
  }
  async function publish(
    owner: Omit<OwnerContext, "slug">,
    id: string,
    input: unknown,
    rollback = false,
  ): Promise<Publication> {
    const parsed = rollback
      ? RollbackIntegrationInput.safeParse(input)
      : PublishIntegrationInput.safeParse(input);
    if (!parsed.success) throw fail("invalid_request");
    const request = parsed.data,
      revisionId =
        "revisionId" in request ? request.revisionId : request.draftRevisionId,
      i = await integration(owner.orgId, id),
      r = await revision(owner.orgId, id, revisionId);
    if (!r.available) throw fail("tool_unavailable", 409);
    if (rollback ? r.status === "draft" : r.status !== "draft")
      throw fail("publication_conflict", 409);
    const review = await row<{
      id: string;
      report_blob_id: string;
      control_epoch: number;
      expected_current_revision_id: string | null;
    }>(
      "SELECT * FROM control_reviews WHERE revision_id=? AND report_digest=? ORDER BY created_at DESC,id DESC LIMIT 1",
      revisionId,
      request.reportDigest,
    );
    if (
      !review ||
      review.expected_current_revision_id !== request.expectedCurrentRevisionId
    )
      throw fail("publication_conflict", 409);
    const report = await readBlob<ReviewReport>(
        owner.orgId,
        review.report_blob_id,
      ),
      manifest = await snapshot(owner.orgId, revisionId),
      byName = new Map(manifest.accepted.map((t) => [t.name, t]));
    const ownedProfiles = await rows<{ id: string; revision: number }>(
        "SELECT id,revision FROM control_profiles WHERE org_id=? AND id IN(SELECT value FROM json_each(?))",
        owner.orgId,
        canonicalJson(request.profiles.map((p) => p.profileId)),
      ),
      profileRevisions = new Map(ownedProfiles.map((p) => [p.id, p.revision]));
    for (const p of request.profiles) {
      if (!profileRevisions.has(p.profileId)) throw fail("not_found", 404);
      if (profileRevisions.get(p.profileId) !== p.expectedRevision)
        throw fail("publication_conflict", 409);
      if (p.tools.some((name) => !byName.has(name)))
        throw fail("invalid_request");
      if (
        p.policies.some(
          (policy) =>
            !policy.pattern.startsWith(i.slug + ".") ||
            policy.pattern === i.slug,
        )
      )
        throw fail("invalid_request");
      if (new Set(p.policies.map((p) => p.pattern)).size !== p.policies.length)
        throw fail("invalid_request");
      await validateProfileBindings(
        owner,
        p.profileId,
        i.slug,
        p.tools.map((name) => byName.get(name)!),
        p.bindings,
      );
    }
    if (
      report.reportDigest !== request.reportDigest ||
      report.draftRevisionId !== revisionId
    )
      throw fail("publication_conflict", 409);
    if (
      await row(
        "SELECT t.id FROM control_tools t WHERE t.org_id=? AND t.integration_id IS NOT ? AND t.name IN(SELECT value FROM json_each(?)) LIMIT 1",
        owner.orgId,
        id,
        canonicalJson(manifest.accepted.map((t) => t.name)),
      )
    )
      throw fail("name_collision", 409);
    if (
      await row(
        "SELECT a.tool_id FROM control_tool_availability a JOIN control_tools t ON t.id=a.tool_id WHERE t.integration_id=? AND a.revision=? AND a.available=0 LIMIT 1",
        id,
        revisionId,
      )
    )
      throw fail("tool_unavailable", 409);
    const publicationId = crypto.randomUUID(),
      at = now(),
      guard = "EXISTS(SELECT 1 FROM control_publications WHERE id=?)",
      statements: Statement[] = [];
    for (const group of jsonGroups(
      request.profiles.map((p) => ({
        profileId: p.profileId,
        expectedRevision: p.expectedRevision,
      })),
    ))
      statements.push(
        stmt(
          "INSERT INTO control_publication_updates(publication_id,profile_id,expected_revision) SELECT ?,json_extract(value,'$.profileId'),json_extract(value,'$.expectedRevision') FROM json_each(?)",
          publicationId,
          group,
        ),
      );
    for (const group of jsonGroups(
      request.profiles.flatMap((p) =>
        p.tools.map((tool) => ({ profileId: p.profileId, tool })),
      ),
    ))
      statements.push(
        stmt(
          "INSERT INTO control_publication_tool_updates(publication_id,profile_id,tool) SELECT ?,json_extract(value,'$.profileId'),json_extract(value,'$.tool') FROM json_each(?)",
          publicationId,
          group,
        ),
      );
    for (const group of jsonGroups(
      request.profiles.flatMap((p) =>
        Object.entries(p.bindings).map(([key, accountId]) => ({
          profileId: p.profileId,
          key,
          accountId,
        })),
      ),
    ))
      statements.push(
        stmt(
          "INSERT INTO control_publication_binding_updates(publication_id,profile_id,requirement_key,account_id) SELECT ?,json_extract(value,'$.profileId'),json_extract(value,'$.key'),json_extract(value,'$.accountId') FROM json_each(?)",
          publicationId,
          group,
        ),
      );
    for (const group of jsonGroups(
      request.profiles.flatMap((p) =>
        p.policies.map((policy) => ({ profileId: p.profileId, ...policy })),
      ),
    ))
      statements.push(
        stmt(
          "INSERT INTO control_publication_policy_updates(publication_id,profile_id,pattern,decision) SELECT ?,json_extract(value,'$.profileId'),json_extract(value,'$.pattern'),json_extract(value,'$.decision') FROM json_each(?)",
          publicationId,
          group,
        ),
      );
    const names = canonicalJson(
      manifest.accepted.map((tool, index) => ({
        id: crypto.randomUUID(),
        revisionId: crypto.randomUUID(),
        name: tool.name,
        index,
      })),
    );
    statements.push(
      stmt(
        `INSERT INTO control_publications(id,org_id,integration_id,revision_id,review_id,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM control_workspaces WHERE org_id=? AND epoch=?)
      AND EXISTS(SELECT 1 FROM control_integrations WHERE id=? AND org_id=? AND current_revision_id IS ?)
      AND EXISTS(SELECT 1 FROM control_integration_revisions WHERE id=? AND available=1)
      AND NOT EXISTS(SELECT 1 FROM control_publication_updates u LEFT JOIN control_profiles p ON p.id=u.profile_id AND p.org_id=? WHERE u.publication_id=? AND (p.id IS NULL OR p.revision<>u.expected_revision))
      AND NOT EXISTS(SELECT 1 FROM control_tool_availability a JOIN control_tools t ON t.id=a.tool_id WHERE t.integration_id=? AND a.revision=? AND a.available=0)
      AND NOT EXISTS(SELECT 1 FROM control_tools t JOIN json_each(?) n ON t.name=json_extract(n.value,'$.name') WHERE t.org_id=? AND t.integration_id IS NOT ?)`,
        publicationId,
        owner.orgId,
        id,
        revisionId,
        review.id,
        at,
        owner.orgId,
        review.control_epoch,
        id,
        owner.orgId,
        request.expectedCurrentRevisionId,
        revisionId,
        owner.orgId,
        publicationId,
        id,
        revisionId,
        names,
        owner.orgId,
        id,
      ),
    );
    statements.push(
      stmt(
        `INSERT OR IGNORE INTO control_tools(id,org_id,name,active_revision,integration_id,created_at) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.name'),?,?,? FROM json_each(?) WHERE ${guard}`,
        owner.orgId,
        revisionId,
        id,
        at,
        names,
        publicationId,
      ),
      stmt(
        `INSERT OR IGNORE INTO control_tool_revisions(id,tool_id,revision,input_schema,input_schema_format,integration_revision_id,definition_index,created_at)
        SELECT json_extract(n.value,'$.revisionId'),t.id,?,json_object('revisionId',?,'definitionIndex',json_extract(n.value,'$.index')),'catalog_reference',?,json_extract(n.value,'$.index'),?
        FROM json_each(?) n JOIN control_tools t ON t.name=json_extract(n.value,'$.name') AND t.org_id=? AND t.integration_id=? WHERE ${guard}`,
        revisionId,
        revisionId,
        revisionId,
        at,
        names,
        owner.orgId,
        id,
        publicationId,
      ),
      stmt(
        `UPDATE control_tools SET active_revision=? WHERE org_id=? AND integration_id=? AND name IN(SELECT json_extract(value,'$.name') FROM json_each(?)) AND ${guard}`,
        revisionId,
        owner.orgId,
        id,
        names,
        publicationId,
      ),
      stmt(
        `DELETE FROM control_profile_tools WHERE profile_id IN(SELECT profile_id FROM control_publication_updates WHERE publication_id=?) AND tool_id IN(SELECT id FROM control_tools WHERE integration_id=?) AND ${guard}`,
        publicationId,
        id,
        publicationId,
      ),
      stmt(
        `INSERT INTO control_profile_tools(id,profile_id,tool_id,enabled,tool_revision) SELECT lower(hex(randomblob(16))),u.profile_id,t.id,1,? FROM control_publication_tool_updates u JOIN control_tools t ON t.name=u.tool AND t.org_id=? AND t.integration_id=? WHERE u.publication_id=? AND ${guard}`,
        revisionId,
        owner.orgId,
        id,
        publicationId,
        publicationId,
      ),
      stmt(
        `DELETE FROM control_profile_bindings WHERE profile_id IN(SELECT profile_id FROM control_publication_updates WHERE publication_id=?) AND substr(requirement_key,1,?)=? AND ${guard}`,
        publicationId,
        i.slug.length + 1,
        i.slug + ".",
        publicationId,
      ),
      stmt(
        `INSERT INTO control_profile_bindings(profile_id,requirement_key,account_id) SELECT u.profile_id,u.requirement_key,u.account_id FROM control_publication_binding_updates u WHERE u.publication_id=? AND ${guard}`,
        publicationId,
        publicationId,
      ),
      stmt(
        `DELETE FROM control_policies WHERE org_id=? AND EXISTS(SELECT 1 FROM control_publication_policy_updates u WHERE u.publication_id=? AND u.profile_id=control_policies.profile_id AND u.pattern=control_policies.pattern) AND ${guard}`,
        owner.orgId,
        publicationId,
        publicationId,
      ),
      stmt(
        `INSERT INTO control_policies(id,org_id,profile_id,pattern,decision,created_at) SELECT lower(hex(randomblob(16))),?,u.profile_id,u.pattern,u.decision,? FROM control_publication_policy_updates u WHERE u.publication_id=? AND ${guard}`,
        owner.orgId,
        at,
        publicationId,
        publicationId,
      ),
      stmt(
        `UPDATE control_profiles SET revision=revision+1,updated_at=? WHERE org_id=? AND id IN(SELECT profile_id FROM control_publication_updates WHERE publication_id=?) AND ${guard}`,
        at,
        owner.orgId,
        publicationId,
        publicationId,
      ),
      stmt(
        `UPDATE control_integration_revisions SET status='superseded' WHERE integration_id=? AND status='published' AND id<>? AND ${guard}`,
        id,
        revisionId,
        publicationId,
      ),
      stmt(
        `UPDATE control_integration_revisions SET status='published' WHERE id=? AND ${guard}`,
        revisionId,
        publicationId,
      ),
      stmt(
        `UPDATE control_integrations SET current_revision_id=?,updated_at=? WHERE id=? AND org_id=? AND ${guard}`,
        revisionId,
        at,
        id,
        owner.orgId,
        publicationId,
      ),
      stmt(
        `UPDATE control_workspaces SET epoch=epoch+1 WHERE org_id=? AND ${guard}`,
        owner.orgId,
        publicationId,
      ),
    );
    await client.batch(statements);
    if (
      !(await row(
        "SELECT id FROM control_publications WHERE id=?",
        publicationId,
      ))
    )
      throw fail("publication_conflict", 409);
    return {
      integrationId: id,
      revisionId,
      profiles: request.profiles.map((p) => ({
        profileId: p.profileId,
        revision: p.expectedRevision + 1,
      })),
    };
  }
  async function patch(orgId: string, id: string, input: unknown) {
    const parsed = PatchIntegrationInput.safeParse(input);
    if (!parsed.success) throw fail("invalid_request");
    await integration(orgId, id);
    await client.batch([
      stmt(
        "UPDATE control_integrations SET enabled=coalesce(?,enabled),display_name=coalesce(?,display_name),updated_at=? WHERE id=? AND org_id=?",
        parsed.data.enabled === undefined ? null : Number(parsed.data.enabled),
        parsed.data.displayName ?? null,
        now(),
        id,
        orgId,
      ),
      stmt("UPDATE control_workspaces SET epoch=epoch+1 WHERE org_id=?", orgId),
      stmt(
        "UPDATE control_runs SET status='blocked',error_code='integration_disabled',error_message='The Integration is disabled.',error_retryable=0,finished_at=?,updated_at=? WHERE org_id=? AND integration_id=? AND status IN ('pending_approval','queued') AND EXISTS(SELECT 1 FROM control_integrations WHERE id=? AND enabled=0)",
        now(),
        now(),
        orgId,
        id,
        id,
      ),
    ]);
    const i = await integration(orgId, id);
    return {
      integrationId: id,
      enabled: Boolean(i.enabled),
      displayName: i.display_name,
    };
  }
  async function retainedTool(
    orgId: string,
    toolId: string,
    version: string,
  ): Promise<FrozenTool | null> {
    const t = await row<{
      name: string;
      integration_id: string;
      integration_revision_id: string;
      definition_index: number;
      digest: string;
    }>(
      "SELECT t.name,t.integration_id,tr.integration_revision_id,tr.definition_index,m.digest FROM control_tools t JOIN control_tool_revisions tr ON tr.tool_id=t.id JOIN control_revision_manifests m ON m.revision_id=tr.integration_revision_id WHERE t.id=? AND t.org_id=? AND tr.revision=?",
      toolId,
      orgId,
      version,
    );
    if (!t) return null;
    const normalized = await snapshot(orgId, t.integration_revision_id),
      definition = normalized.accepted[t.definition_index];
    if (!definition || definition.name !== t.name) return null;
    let artifactDigest = t.digest;
    if (
      isJsonObject(normalized.snapshot) &&
      isJsonObject(normalized.snapshot.compiled)
    ) {
      const artifact = normalized.snapshot.compiled[t.name];
      if (isJsonObject(artifact) && typeof artifact.artifactDigest === "string")
        artifactDigest = artifact.artifactDigest;
    }
    return {
      toolId,
      name: t.name,
      toolRevision: version,
      integrationId: t.integration_id,
      integrationRevision: t.integration_revision_id,
      artifactDigest,
      definition,
    };
  }
  async function resolveTool(orgId: string, profileId: string, name: string) {
    const t = await row<{
      id: string;
      revision: string;
      enabled: number;
      available: number;
      slug: string;
    }>(
      "SELECT t.id,coalesce(pt.tool_revision,t.active_revision) AS revision,coalesce(pt.enabled,0)*i.enabled AS enabled,coalesce(r.available,0)*coalesce(a.available,1) AS available,i.slug FROM control_tools t JOIN control_integrations i ON i.id=t.integration_id LEFT JOIN control_profile_tools pt ON pt.tool_id=t.id AND pt.profile_id=? LEFT JOIN control_integration_revisions r ON r.id=coalesce(pt.tool_revision,t.active_revision) LEFT JOIN control_tool_availability a ON a.tool_id=t.id AND a.revision=coalesce(pt.tool_revision,t.active_revision) WHERE t.org_id=? AND t.name=?",
      profileId,
      orgId,
      name,
    );
    if (!t) return null;
    const tool = await retainedTool(orgId, t.id, t.revision);
    return tool
      ? {
          tool,
          enabled: Boolean(t.enabled),
          available: Boolean(t.available),
          slug: t.slug,
        }
      : null;
  }
  async function names(orgId: string, profileId: string) {
    return (
      await rows<{ name: string }>(
        `SELECT t.name FROM control_profile_tools pt JOIN control_tools t ON t.id=pt.tool_id JOIN control_integrations i ON i.id=t.integration_id JOIN control_integration_revisions r ON r.id=coalesce(pt.tool_revision,t.active_revision) WHERE pt.profile_id=? AND t.org_id=? AND pt.enabled=1 AND i.enabled=1 AND r.available=1 AND r.status<>'draft' AND NOT EXISTS(SELECT 1 FROM control_tool_availability a WHERE a.tool_id=t.id AND a.revision=r.id AND a.available=0) ORDER BY t.name`,
        profileId,
        orgId,
      )
    ).map((t) => t.name);
  }
  async function discover(
    orgId: string,
    profileId: string,
    selectedNames?: readonly string[],
    configuredOnly = false,
  ) {
    const entries = await rows<{
      id: string;
      name: string;
      revision: string;
      integration_id: string;
      integration_revision_id: string;
      definition_index: number;
      digest: string;
    }>(
      `SELECT t.id,t.name,tr.revision,t.integration_id,tr.integration_revision_id,tr.definition_index,m.digest FROM control_profile_tools pt
      JOIN control_tools t ON t.id=pt.tool_id JOIN control_integrations i ON i.id=t.integration_id
      JOIN control_tool_revisions tr ON tr.tool_id=t.id AND tr.revision=coalesce(pt.tool_revision,t.active_revision)
      JOIN control_integration_revisions r ON r.id=tr.integration_revision_id JOIN control_revision_manifests m ON m.revision_id=r.id
      WHERE pt.profile_id=? AND t.org_id=? AND pt.enabled=1 AND r.status<>'draft'
      ${configuredOnly ? "" : "AND i.enabled=1 AND r.available=1 AND NOT EXISTS(SELECT 1 FROM control_tool_availability a WHERE a.tool_id=t.id AND a.revision=tr.revision AND a.available=0)"}
      ${selectedNames ? "AND t.name IN(SELECT value FROM json_each(?))" : ""} ORDER BY t.name`,
      profileId,
      orgId,
      ...(selectedNames ? [canonicalJson(selectedNames)] : []),
    );
    let manifest: ResolvedSource | undefined, lastRevision: string | undefined;
    const tools: FrozenTool[] = [];
    for (const entry of entries) {
      if (lastRevision !== entry.integration_revision_id || !manifest) {
        manifest = await snapshot(orgId, entry.integration_revision_id);
        lastRevision = entry.integration_revision_id;
      }
      const definition = manifest.accepted[entry.definition_index];
      if (!definition || definition.name !== entry.name)
        throw fail("tool_unavailable", 409);
      let artifactDigest = entry.digest;
      if (
        isJsonObject(manifest.snapshot) &&
        isJsonObject(manifest.snapshot.compiled)
      ) {
        const artifact = manifest.snapshot.compiled[entry.name];
        if (
          isJsonObject(artifact) &&
          typeof artifact.artifactDigest === "string"
        )
          artifactDigest = artifact.artifactDigest;
      }
      tools.push({
        toolId: entry.id,
        name: entry.name,
        toolRevision: entry.revision,
        integrationId: entry.integration_id,
        integrationRevision: entry.integration_revision_id,
        artifactDigest,
        definition,
      });
    }
    return tools;
  }
  const previewOAuthImpact: OAuthImpactPreviewer = async (owner, input) => {
    type ImpactProfile = OAuthScopeImpact["published"][number];
    type Entry = {
      revision: string;
      name: string;
      profile_id: string;
      label: string;
      requirement_key: string;
      slug: string;
    };
    const encoder = new TextEncoder(),
      measure = (value: unknown) =>
        encoder.encode(JSON.stringify(value)).length;
    const toolImpact = (
      name: string,
      requirement: string,
      contract: Requirement,
    ) => ({
      name,
      requirement,
      currentScopesSatisfied: input.coversScopes(
        input.currentScopes,
        contract.scopes,
      ),
      requestedScopesSufficient: input.coversScopes(
        input.requestedScopes,
        contract.scopes,
      ),
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      const epoch = await row<{ epoch: number }>(
        "SELECT epoch FROM control_workspaces WHERE org_id=?",
        owner.orgId,
      );
      const published = new Map<string, ImpactProfile>();
      let bytes = measure({ published: [] });
      function reserve(additionalBytes: number) {
        bytes += additionalBytes;
        if (bytes > 1048576)
          throw new ControlError(
            "payload_too_large",
            "The OAuth scope-impact preview exceeds the supported JSON limit.",
            413,
          );
      }
      if (input.accountId) {
        let cursor: readonly string[] | null = null,
          lastRevision: string | undefined,
          requirements: Map<string, Record<string, Requirement>> | undefined;
        for (;;) {
          const entries: Entry[] = await rows(
            `SELECT tr.integration_revision_id AS revision,t.name,p.id AS profile_id,p.label,b.requirement_key,i.slug
            FROM control_profile_bindings b JOIN control_profiles p ON p.id=b.profile_id
            JOIN control_profile_tools pt ON pt.profile_id=p.id AND pt.enabled=1
            JOIN control_tools t ON t.id=pt.tool_id AND t.org_id=p.org_id JOIN control_integrations i ON i.id=t.integration_id
            JOIN control_tool_revisions tr ON tr.tool_id=t.id AND tr.revision=coalesce(pt.tool_revision,t.active_revision)
            JOIN control_integration_revisions r ON r.id=tr.integration_revision_id
            WHERE p.org_id=? AND b.account_id=? AND r.status<>'draft' AND substr(b.requirement_key,1,length(i.slug)+1)=i.slug||'.'
            ${cursor ? "AND (tr.integration_revision_id,t.name,p.id,b.requirement_key)>(?,?,?,?)" : ""}
            ORDER BY tr.integration_revision_id,t.name,p.id,b.requirement_key LIMIT 128`,
            owner.orgId,
            input.accountId,
            ...(cursor ?? []),
          );
          if (!entries.length) break;
          for (const entry of entries) {
            if (lastRevision !== entry.revision || !requirements) {
              const retained = await snapshot(owner.orgId, entry.revision);
              requirements = new Map(
                retained.accepted.map((tool) => [tool.name, tool.requirements]),
              );
              lastRevision = entry.revision;
            }
            const local = entry.requirement_key.slice(entry.slug.length + 1),
              contract = requirements.get(entry.name)?.[local];
            if (!contract || contract.provider !== input.provider) continue;
            let target = published.get(entry.profile_id);
            if (!target) {
              target = {
                profileId: entry.profile_id,
                label: entry.label,
                tools: [],
              };
              reserve(measure(target) + (published.size ? 1 : 0));
              published.set(entry.profile_id, target);
            }
            const impact = toolImpact(entry.name, local, contract);
            reserve(measure(impact) + (target.tools.length ? 1 : 0));
            target.tools.push(impact);
          }
          const last = entries[entries.length - 1]!;
          cursor = [
            last.revision,
            last.name,
            last.profile_id,
            last.requirement_key,
          ];
        }
      }
      let proposed: OAuthScopeImpact["proposed"];
      if (input.review) {
        const review = input.review,
          revisionRow = await revision(
            owner.orgId,
            review.integrationId,
            review.draftRevisionId,
          );
        if (
          revisionRow.status !== "draft" ||
          !(await row(
            "SELECT id FROM control_reviews WHERE revision_id=? LIMIT 1",
            review.draftRevisionId,
          ))
        )
          throw fail("publication_conflict", 409);
        if (
          !review.profileIds.length ||
          new Set(review.profileIds).size !== review.profileIds.length
        )
          throw fail("invalid_request");
        const ids = canonicalJson(review.profileIds),
          owned = await row<{ count: number }>(
            "SELECT count(*) AS count FROM control_profiles WHERE org_id=? AND id IN(SELECT value FROM json_each(?))",
            owner.orgId,
            ids,
          );
        if (owned?.count !== review.profileIds.length)
          throw fail("not_found", 404);
        proposed = {
          integrationId: review.integrationId,
          draftRevisionId: review.draftRevisionId,
          callable: false,
          profiles: [],
        };
        reserve(measure(proposed) + 12);
        const retained = await snapshot(owner.orgId, review.draftRevisionId);
        const tools = retained.accepted.flatMap((tool) =>
          Object.entries(tool.requirements)
            .filter(([, contract]) => contract.provider === input.provider)
            .map(([requirement, contract]) =>
              toolImpact(tool.name, requirement, contract),
            ),
        );
        let after = "";
        for (;;) {
          const targets = await rows<{ id: string; label: string }>(
            "SELECT id,label FROM control_profiles WHERE org_id=? AND id IN(SELECT value FROM json_each(?)) AND id>? ORDER BY id LIMIT 128",
            owner.orgId,
            ids,
            after,
          );
          if (!targets.length) break;
          for (const target of targets) {
            const profile: ImpactProfile = {
              profileId: target.id,
              label: target.label,
              tools: [],
            };
            reserve(measure(profile) + (proposed.profiles.length ? 1 : 0));
            for (const impact of tools) {
              reserve(measure(impact) + (profile.tools.length ? 1 : 0));
              profile.tools.push(impact);
            }
            proposed.profiles.push(profile);
          }
          after = targets[targets.length - 1]!.id;
        }
      }
      const current = await row<{ epoch: number }>(
        "SELECT epoch FROM control_workspaces WHERE org_id=?",
        owner.orgId,
      );
      if (current?.epoch !== epoch?.epoch) continue;
      const profiles = [...published.values()].sort((a, b) =>
        a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0,
      );
      for (const profile of profiles)
        profile.tools.sort((a, b) =>
          a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : a.requirement < b.requirement
                ? -1
                : a.requirement > b.requirement
                  ? 1
                  : 0,
        );
      return { published: profiles, ...(proposed ? { proposed } : {}) };
    }
    throw fail("publication_conflict", 409);
  };
  async function updateBindings(
    owner: Omit<OwnerContext, "slug">,
    id: string,
    input: unknown,
  ) {
    const parsed = UpdateBindingsInput.safeParse(input);
    if (!parsed.success) throw fail("invalid_request");
    const p = await profile(owner.orgId, id);
    if (p.revision !== parsed.data.expectedRevision)
      throw fail("publication_conflict", 409);
    const epoch = await row<{ epoch: number }>(
        "SELECT epoch FROM control_workspaces WHERE org_id=?",
        owner.orgId,
      ),
      tools = await discover(owner.orgId, id, undefined, true),
      bySlug = new Map<string, ToolDefinition[]>();
    for (const tool of tools) {
      const slug = tool.name.split(".")[0]!;
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), tool.definition]);
    }
    if (
      Object.keys(parsed.data.bindings).some(
        (k) => !bySlug.has(k.split(".")[0]!),
      )
    )
      throw fail("invalid_request");
    for (const [slug, definitions] of bySlug)
      await validateProfileBindings(
        owner,
        id,
        slug,
        definitions,
        Object.fromEntries(
          Object.entries(parsed.data.bindings).filter(([k]) =>
            k.startsWith(slug + "."),
          ),
        ),
      );
    const at = now(),
      updated = await client.batch([
        stmt(
          "UPDATE control_profiles SET revision=revision+1,updated_at=? WHERE id=? AND org_id=? AND revision=? AND EXISTS(SELECT 1 FROM control_workspaces WHERE org_id=? AND epoch=?) RETURNING revision",
          at,
          id,
          owner.orgId,
          p.revision,
          owner.orgId,
          epoch!.epoch,
        ),
        stmt(
          "DELETE FROM control_profile_bindings WHERE profile_id=? AND EXISTS(SELECT 1 FROM control_profiles WHERE id=? AND revision=? AND updated_at=?) AND EXISTS(SELECT 1 FROM control_workspaces WHERE org_id=? AND epoch=?)",
          id,
          id,
          p.revision + 1,
          at,
          owner.orgId,
          epoch!.epoch,
        ),
        ...Object.entries(parsed.data.bindings).map(([key, accountId]) =>
          stmt(
            "INSERT INTO control_profile_bindings(profile_id,requirement_key,account_id) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM control_profiles WHERE id=? AND revision=? AND updated_at=?) AND EXISTS(SELECT 1 FROM control_workspaces WHERE org_id=? AND epoch=?)",
            id,
            key,
            accountId,
            id,
            p.revision + 1,
            at,
            owner.orgId,
            epoch!.epoch,
          ),
        ),
        stmt(
          "UPDATE control_workspaces SET epoch=epoch+1 WHERE org_id=? AND epoch=? AND EXISTS(SELECT 1 FROM control_profiles WHERE id=? AND revision=? AND updated_at=?)",
          owner.orgId,
          epoch!.epoch,
          id,
          p.revision + 1,
          at,
        ),
      ]);
    if (!updated[0]?.results.length) throw fail("publication_conflict", 409);
    return { profileId: id, revision: p.revision + 1 };
  }
  async function cleanup() {
    await client.batch([
      stmt(
        "DELETE FROM control_catalog_blobs WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM control_integration_revisions r WHERE r.source_blob_id=control_catalog_blobs.id) AND NOT EXISTS(SELECT 1 FROM control_revision_manifests m WHERE m.blob_id=control_catalog_blobs.id) AND NOT EXISTS(SELECT 1 FROM control_reviews r WHERE r.report_blob_id=control_catalog_blobs.id)",
        now() - 86400000,
      ),
      ...[
        "control_publication_tool_updates",
        "control_publication_binding_updates",
        "control_publication_policy_updates",
        "control_publication_updates",
      ].map((table) =>
        stmt(
          `DELETE FROM ${table} WHERE NOT EXISTS(SELECT 1 FROM control_publications p WHERE p.id=${table}.publication_id)`,
        ),
      ),
    ]);
  }
  return {
    create,
    get,
    validate,
    refresh,
    publish,
    patch,
    profile,
    updateBindings,
    resolveTool,
    retainedTool,
    snapshot,
    bindings,
    names,
    discover,
    previewOAuthImpact,
    cleanup,
  };
}
