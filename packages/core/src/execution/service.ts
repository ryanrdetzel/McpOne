import type { D1PreparedStatement as Statement } from "@cloudflare/workers-types";
import type { Database } from "@scaffold/database";
import {
  ExecutionErrorCode,
  ExecutionRequestMetadata,
  FixtureArguments,
  type FixtureArguments as FixtureInput,
  IDEMPOTENCY_RETENTION_MS,
  PolicyPattern,
  type RunStatus,
} from "@scaffold/schema/execution";
import {
  BusinessMcpResult,
  EffectEvidence,
  type FrozenTool,
  type HttpMethod,
  IntegrationToolName,
  isJsonObject,
  type JSONSchema,
  type JSONValue,
  jsonProblem,
  ProtectedMcpResult,
  type SelectedAccount,
  schemaHasObjectRoot,
} from "@scaffold/schema/integrations";
import type {
  ArtifactPrincipal,
  ArtifactProvenance,
  ArtifactRunContext,
  ArtifactScope,
} from "../integrations/artifacts";
import type { AccountAuthority, CatalogService } from "../integrations/catalog";
import { validateInput } from "../integrations/schema";
import { canonicalJson, sha256 } from "./canonical";
import { CURRENT_POLICY_SQL, type PolicyRule, resolvePolicy } from "./policy";
import { toolResult } from "./presentation";
import { createPayloadProtection } from "./protection";

export interface RunConsoleEntry {
  level: "log" | "info" | "warn" | "error";
  text: string;
}
export interface IntegrationInvocation {
  runId: string;
  claimId: string;
  orgId: string;
  grantId: string;
  profileId: string;
  principalId: string | null;
  tool: FrozenTool;
  arguments: Record<string, JSONValue>;
  selections: Record<string, SelectedAccount>;
  deadlineMs: number;
  retentionDeadline: number | null;
  beforeRequest(input: {
    accountRequirement: string | null;
    accountRequirements?: string[];
    method: HttpMethod;
    url: string;
    controlTraffic?: boolean;
  }): Promise<void>;
  onLogs(entries: readonly RunConsoleEntry[]): Promise<void>;
}
export interface IntegrationRuntime {
  catalog: CatalogService;
  accounts: AccountAuthority;
  tryAcquire(runId: string): (() => void) | null;
  invokeTool(
    input: IntegrationInvocation,
  ): Promise<{ result: BusinessMcpResult; effect: EffectEvidence }>;
  prepare(input: IntegrationInvocation): Promise<void>;
  finalizeResult(
    input: IntegrationInvocation,
    result: BusinessMcpResult,
    completedAt: number,
  ): Promise<BusinessMcpResult>;
  cleanup(): Promise<void>;
  completed?(input: IntegrationInvocation, completedAt: number): Promise<void>;
}

const FIXTURE = "fixture.counter.increment";
const REVISION = "v1";
export const EXECUTION_LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const MAX_WORKSPACE_RUNNING = 5;
const MAX_REQUEST_BYTES = 1024 * 1024;
const GRANT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_APPROVAL_LIFETIME_MS = 3 * 60 * 60 * 1000;
// SQLite evaluates this at the atomic mutation, not before a remote D1 round trip.
const SQL_NOW = "cast((julianday('now') - 2440587.5) * 86400000 as integer)";

export interface GrantIdentity {
  id: string;
  orgId: string;
  profileId: string;
  principalId?: string | null;
}
export interface RunView {
  runId: string;
  tool: string;
  status: RunStatus;
  createdAt: number;
  deadline: number | null;
  grantId: string;
  profileId: string;
  attempts: number;
  approvalLink?: string;
  error?: {
    code: ExecutionErrorCode;
    message: string;
    retryable: boolean;
    run_id?: string;
  };
  result?: unknown;
  businessResult?: BusinessMcpResult;
  accounts?: Record<string, string>;
  displayArguments?: {
    value?: number;
    note?: "[redacted]";
    fault?: FixtureInput["fault"];
  };
  policyDecision?: PolicyRule["decision"];
  frozenToolRevision?: string;
  approvedRevision?: string;
  grantLabel?: string;
}
export interface OwnerRunView extends RunView {
  outboundRequests?: number;
  effectState?: EffectEvidence["state"];
  logs?: RunConsoleEntry[];
}
export interface ProfileUpdate {
  enabled?: boolean;
  toolEnabled?: boolean;
  approvalLifetimeMs?: number;
  dispatchPaused?: boolean;
}
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | JSONSchema;
  outputSchema?: JSONSchema;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}
export interface ExecutionService {
  setup(
    orgId: string,
    label: string,
  ): Promise<{ profileId: string; tool: string }>;
  issueGrant(
    orgId: string,
    profileId: string,
    label: string,
    expiresAt?: number | null,
    principalId?: string | null,
  ): Promise<{ grantId: string; token: string; expiresAt: number | null }>;
  authenticate(profileId: string, token: string): Promise<GrantIdentity>;
  discover(grant: GrantIdentity): Promise<ToolDescriptor[]>;
  discoveryPage(
    grant: GrantIdentity,
    cursor?: string,
  ): Promise<{ tools: ToolDescriptor[]; nextCursor?: string }>;
  authorizeArtifactAccess(
    principal: ArtifactPrincipal,
    scope: ArtifactScope,
    operation: "upload" | "read" | "audit",
  ): Promise<void>;
  authorizeArtifactRun(
    context: ArtifactRunContext,
    source?: ArtifactProvenance,
    targetRequirement?: string | null,
  ): Promise<void>;
  invoke(
    grant: GrantIdentity,
    input: { name: string; arguments: unknown; metadata?: unknown },
  ): Promise<RunView>;
  getRun(grant: GrantIdentity, runId: string): Promise<RunView>;
  ownerRuns(orgId: string): Promise<OwnerRunView[]>;
  ownerRun(orgId: string, runId: string): Promise<OwnerRunView>;
  decide(
    orgId: string,
    runId: string,
    decision: "approve" | "deny",
  ): Promise<RunView>;
  cancel(orgId: string, runId: string): Promise<RunView>;
  updateProfile(
    orgId: string,
    profileId: string,
    patch: ProfileUpdate,
  ): Promise<void>;
  setPolicies(
    orgId: string,
    profileId: string | null,
    rules: PolicyRule[],
  ): Promise<void>;
  revokeGrant(orgId: string, grantId: string): Promise<void>;
  fixtureStats(orgId: string): Promise<{ writes: number; total: number }>;
  drain(): Promise<void>;
}
export class ControlError extends Error {
  constructor(
    public readonly code: ExecutionErrorCode,
    message: string,
    public readonly status = 400,
    public readonly runId?: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ControlError";
  }
}
const messages: Partial<Record<ExecutionErrorCode, string>> = {
  unauthenticated: "A valid Grant token is required.",
  forbidden: "This operation is not authorized.",
  not_found: "The requested resource was not found.",
  invalid_request: "The request is invalid.",
  invalid_arguments: "The Tool arguments are invalid.",
  payload_too_large: "The request exceeds the 1 MiB limit.",
  idempotency_conflict:
    "This idempotency key already identifies a different request.",
  policy_blocked: "Current policy blocks this Tool.",
  approval_denied: "The owner denied this request.",
  approval_expired: "The immutable approval deadline has expired.",
  grant_revoked: "This Grant has been revoked.",
  grant_expired: "This Grant has expired.",
  profile_disabled: "This Profile is disabled.",
  tool_unavailable:
    "The Tool is not available in this Profile at the frozen revision.",
  canceled: "The request was canceled before dispatch.",
  execution_failed: "Execution failed.",
  outcome_unknown:
    "Execution may have produced an effect. Do not retry this write automatically.",
  content_expired: "Protected Run content has expired.",
  rate_limited: "Execution capacity is temporarily unavailable.",
  internal_error: "The operation could not be completed safely.",
  execution_timeout: "The execution lease expired.",
};
function problem(
  code: ExecutionErrorCode,
  status = 400,
  runId?: string,
  retryable = false,
): ControlError {
  return new ControlError(
    code,
    messages[code] ?? "The operation could not be completed.",
    status,
    runId,
    retryable,
  );
}
interface GrantRow {
  id: string;
  org_id: string;
  profile_id: string;
  revoked_at: number | null;
  expires_at: number | null;
  enabled: number;
  approval_lifetime_ms: number;
  dispatch_paused: number;
  epoch: number;
  principal_id: string | null;
  principal_active: number;
}
interface RunRow {
  id: string;
  org_id: string;
  grant_id: string;
  profile_id: string;
  tool: string;
  tool_id: string | null;
  tool_revision: string;
  status: RunStatus;
  fingerprint: string | null;
  created_at: number;
  updated_at: number;
  deadline: number | null;
  admitted_epoch: number;
  approved_revision: string | null;
  attempts: number;
  lease_owner: string | null;
  lease_until: number | null;
  error_code: ExecutionErrorCode | null;
  error_message: string | null;
  error_retryable: number;
  policy_decision: PolicyRule["decision"];
  display_json: string;
  fingerprint_version: "m1" | "m2";
  integration_id: string | null;
  integration_revision_id: string | null;
  artifact_digest: string | null;
  result_format: "legacy_json" | "mcp";
  outbound_remaining: number;
  wall_timeout_ms: number;
  claim_epoch: number | null;
  effect_state: EffectEvidence["state"];
  effect_evidence_json: string | null;
  admission_ready: number;
}
interface PayloadRow {
  request_cipher: string | null;
  result_cipher: string | null;
  expires_at: number;
  result_format: "legacy_json" | "mcp";
  request_chunk_count: number;
  result_chunk_count: number;
}
interface ToolRow {
  id: string;
  active_revision: string;
  enabled: number | null;
}
interface PolicyRow extends PolicyRule {
  profile_id: string | null;
}
type Bound = string | number | null;

const fixtureDescriptor = {
  name: FIXTURE,
  description:
    "M1 durable counter fixture. Each dispatched Run has one observable numeric effect. Advertised faults: safe_before_effect fails once before any effect; after_effect loses its response after a write; crash_after_claim leaves a running lease without an effect. note is protected and never displayed.",
  inputSchema: {
    type: "object",
    properties: {
      value: {
        type: "integer",
        minimum: Number.MIN_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
        default: 1,
      },
      note: {
        type: "string",
        description:
          "Sensitive note, retained only in encrypted replay content.",
      },
      fault: {
        type: "string",
        enum: ["safe_before_effect", "after_effect", "crash_after_claim"],
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};
const getDescriptor = {
  name: "runs.get",
  description:
    "Retrieve a Run authorized to this Grant. Never executes or retries it.",
  inputSchema: {
    type: "object",
    properties: { run_id: { type: "string", minLength: 1 } },
    required: ["run_id"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const PRINCIPAL_AUTHORITY_SQL =
  "(g.principal_id IS NULL OR EXISTS(SELECT 1 FROM users u JOIN members m ON m.user_id=u.id AND m.organization_id=g.org_id WHERE u.id=g.principal_id))";
// These restrictions are evaluated in SQL, inside each owner's mutation and each claim.
const RESTRICTION_SQL = `(CASE
  WHEN NOT EXISTS (SELECT 1 FROM control_profiles p WHERE p.id=r.profile_id AND p.org_id=r.org_id AND p.enabled=1) THEN 'profile_disabled'
  WHEN EXISTS (SELECT 1 FROM control_grants g WHERE g.id=r.grant_id AND g.revoked_at IS NOT NULL) THEN 'grant_revoked'
  WHEN EXISTS (SELECT 1 FROM control_grants g WHERE g.id=r.grant_id AND g.expires_at IS NOT NULL AND g.expires_at<=max(?,${SQL_NOW})) THEN 'grant_expired'
  WHEN NOT EXISTS(SELECT 1 FROM control_grants g WHERE g.id=r.grant_id AND g.org_id=r.org_id AND g.profile_id=r.profile_id AND ${PRINCIPAL_AUTHORITY_SQL}) THEN 'forbidden'
  WHEN NOT EXISTS (SELECT 1 FROM control_tools t JOIN control_profile_tools pt ON pt.tool_id=t.id
    JOIN control_tool_revisions tr ON tr.tool_id=t.id AND tr.revision=r.tool_revision
    WHERE t.id=r.tool_id AND t.org_id=r.org_id AND t.name=r.tool
      AND pt.profile_id=r.profile_id AND pt.enabled=1) THEN 'tool_unavailable'
  WHEN r.integration_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM control_integrations i WHERE i.id=r.integration_id AND i.org_id=r.org_id AND i.enabled=1) THEN 'integration_disabled'
  WHEN r.integration_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM control_integration_revisions ir WHERE ir.id=r.integration_revision_id AND ir.available=1 AND ir.status<>'draft')
    OR EXISTS(SELECT 1 FROM control_tool_availability a WHERE a.tool_id=r.tool_id AND a.revision=r.tool_revision AND a.available=0)) THEN 'tool_unavailable'
  WHEN r.deadline IS NOT NULL AND r.deadline<=max(?,${SQL_NOW}) THEN 'approval_expired'
  WHEN ${CURRENT_POLICY_SQL}='block' THEN 'policy_blocked'
  WHEN ${CURRENT_POLICY_SQL}='ask' AND r.deadline IS NULL AND r.approved_revision IS NULL THEN 'forbidden'
  ELSE NULL END)`;

/** Shared D1/SQLite domain. batch() is the adapter's real atomic transaction boundary. */
export function createExecutionService({
  db,
  secret,
  now = Date.now,
  runtime,
}: {
  db: Database;
  secret: string;
  now?: () => number;
  runtime?: IntegrationRuntime;
}): ExecutionService {
  const client = db.$client;
  const protection = createPayloadProtection(secret);
  const cursorEncoder = new TextEncoder();
  const cursorKey = runtime
    ? crypto.subtle
        .digest(
          "SHA-256",
          cursorEncoder.encode("mcpone/control/discovery/v1:" + secret),
        )
        .then((bytes) =>
          crypto.subtle.importKey(
            "raw",
            bytes,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign", "verify"],
          ),
        )
    : null;
  function statement(sql: string, ...values: Bound[]): Statement {
    const prepared = client.prepare(sql);
    return values.length ? prepared.bind(...values) : prepared;
  }
  async function row<T>(sql: string, ...values: Bound[]): Promise<T | null> {
    return statement(sql, ...values).first<T>();
  }
  async function rows<T>(sql: string, ...values: Bound[]): Promise<T[]> {
    return (await statement(sql, ...values).all<T>()).results;
  }
  function audit(
    orgId: string,
    grantId: string | null,
    runId: string | null,
    action: string,
    reason: string | null,
    at: number,
  ): Statement {
    return statement(
      "INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at) VALUES(?,?,?,?,?,?,?)",
      crypto.randomUUID(),
      orgId,
      grantId,
      runId,
      action,
      reason,
      at,
    );
  }
  function epoch(orgId: string): Statement {
    return statement(
      "UPDATE control_workspaces SET epoch=epoch+1 WHERE org_id=?",
      orgId,
    );
  }
  async function profile(orgId: string, profileId: string) {
    const found = await row<{ id: string }>(
      "SELECT id FROM control_profiles WHERE id=? AND org_id=?",
      profileId,
      orgId,
    );
    if (!found) throw problem("not_found", 404);
  }
  async function loadGrant(grant: GrantIdentity): Promise<GrantRow> {
    const found = await row<GrantRow>(
      `SELECT g.id,g.org_id,g.profile_id,g.revoked_at,g.expires_at,g.principal_id,${PRINCIPAL_AUTHORITY_SQL} AS principal_active,
      p.enabled,p.approval_lifetime_ms,p.dispatch_paused,w.epoch FROM control_grants g
      JOIN control_profiles p ON p.id=g.profile_id AND p.org_id=g.org_id
      JOIN control_workspaces w ON w.org_id=g.org_id WHERE g.id=? AND g.org_id=? AND g.profile_id=?`,
      grant.id,
      grant.orgId,
      grant.profileId,
    );
    if (!found) throw problem("unauthenticated", 401);
    return found;
  }
  function grantFailure(
    grant: GrantRow,
    at: number,
  ): ExecutionErrorCode | null {
    if (grant.revoked_at !== null) return "grant_revoked";
    if (grant.expires_at !== null && grant.expires_at <= at)
      return "grant_expired";
    if (!grant.enabled) return "profile_disabled";
    if (!grant.principal_active) return "forbidden";
    return null;
  }
  async function requireGrant(grant: GrantIdentity): Promise<GrantRow> {
    const found = await loadGrant(grant);
    const failure = grantFailure(found, now());
    if (failure) {
      await audit(
        found.org_id,
        found.id,
        null,
        "authorization_denied",
        failure,
        now(),
      ).run();
      throw problem(failure, 403);
    }
    return found;
  }
  async function runRow(
    orgId: string,
    runId: string,
    grantId?: string,
  ): Promise<RunRow> {
    const found = await row<RunRow>(
      `SELECT * FROM control_runs WHERE id=? AND org_id=?${grantId === undefined ? "" : " AND grant_id=?"}`,
      runId,
      orgId,
      ...(grantId === undefined ? [] : [grantId]),
    );
    if (!found) throw problem("not_found", 404);
    return found;
  }
  async function view(run: RunRow, owner = false): Promise<RunView> {
    const selected =
      run.fingerprint_version === "m2" ? await selections(run.id) : {};
    const result: RunView = {
      runId: run.id,
      tool: run.tool,
      status: run.status,
      createdAt: run.created_at,
      deadline: run.deadline,
      grantId: run.grant_id,
      profileId: run.profile_id,
      attempts: run.attempts,
    };
    if (Object.keys(selected).length)
      result.accounts = Object.fromEntries(
        Object.entries(selected).map(([key, account]) => [key, account.alias]),
      );
    if (owner) {
      result.displayArguments = JSON.parse(
        run.display_json,
      ) as RunView["displayArguments"];
      result.policyDecision = run.policy_decision;
      result.frozenToolRevision = run.tool_revision;
      if (run.approved_revision !== null)
        result.approvedRevision = run.approved_revision;
      const grant = await row<{ label: string }>(
        "SELECT label FROM control_grants WHERE id=? AND org_id=?",
        run.grant_id,
        run.org_id,
      );
      if (grant) result.grantLabel = grant.label;
    }
    if (run.status === "pending_approval")
      result.approvalLink = `/api/control/runs/${encodeURIComponent(run.id)}`;
    if (run.error_code)
      result.error = {
        code: run.error_code,
        message:
          run.error_message ?? messages[run.error_code] ?? "Execution failed.",
        retryable: Boolean(run.error_retryable),
        run_id: run.id,
      };
    if (run.status === "succeeded") {
      const protectedRow = await row<PayloadRow>(
        "SELECT * FROM control_run_payloads WHERE run_id=? AND org_id=?",
        run.id,
        run.org_id,
      );
      if (
        !protectedRow ||
        protectedRow.expires_at <= now() ||
        (!protectedRow.result_cipher && !protectedRow.result_chunk_count)
      ) {
        result.error = {
          code: "content_expired",
          message: messages.content_expired!,
          retryable: false,
          run_id: run.id,
        };
      } else {
        try {
          const cipher =
            protectedRow.result_cipher ??
            (await payloadCipher(
              run.id,
              "result",
              protectedRow.result_chunk_count,
            ));
          const decoded = await protection.decrypt<unknown>(
            run.org_id,
            run.id,
            "result",
            cipher,
          );
          if (protectedRow.result_format === "mcp") {
            result.businessResult = ProtectedMcpResult.parse(decoded).result;
            if (run.tool === FIXTURE)
              result.result = result.businessResult.structuredContent;
          } else {
            result.result = decoded;
            result.businessResult = legacyBusinessResult(decoded);
          }
        } catch {
          result.error = {
            code: "internal_error",
            message: messages.internal_error!,
            retryable: false,
            run_id: run.id,
          };
        }
      }
    }
    return result;
  }

  /** Apply waiting-work restrictions with safe audit and approval state in the same transaction. */
  function restrictWaiting(orgId: string, at: number): Statement[] {
    return [
      statement(
        `UPDATE control_runs AS r SET error_code=${RESTRICTION_SQL}, updated_at=?
        WHERE r.org_id=? AND r.status IN ('pending_approval','queued') AND ${RESTRICTION_SQL} IS NOT NULL`,
        at,
        at,
        at,
        orgId,
        at,
        at,
      ),
      statement(
        `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
        SELECT lower(hex(randomblob(16))),org_id,grant_id,id,'restriction_denied',error_code,? FROM control_runs
        WHERE org_id=? AND status IN ('pending_approval','queued') AND error_code IS NOT NULL`,
        at,
        orgId,
      ),
      statement(
        `UPDATE control_runs SET status=CASE error_code WHEN 'approval_expired' THEN 'expired' ELSE 'blocked' END,
        error_message=CASE error_code WHEN 'policy_blocked' THEN ? WHEN 'approval_expired' THEN ? WHEN 'grant_revoked' THEN ?
          WHEN 'grant_expired' THEN ? WHEN 'profile_disabled' THEN ? WHEN 'forbidden' THEN ? ELSE ? END,error_retryable=0,finished_at=?,updated_at=?
        WHERE org_id=? AND status IN ('pending_approval','queued') AND error_code IS NOT NULL`,
        messages.policy_blocked!,
        messages.approval_expired!,
        messages.grant_revoked!,
        messages.grant_expired!,
        messages.profile_disabled!,
        messages.forbidden!,
        messages.tool_unavailable!,
        at,
        at,
        orgId,
      ),
    ];
  }

  async function setup(
    orgId: string,
    label: string,
  ): Promise<{ profileId: string; tool: string }> {
    if (typeof label !== "string" || !label.trim() || label.trim().length > 128)
      throw problem("invalid_request");
    if (!(await row("SELECT id FROM organizations WHERE id=?", orgId)))
      throw problem("not_found", 404);
    const at = now();
    const toolId = crypto.randomUUID();
    const profileId = crypto.randomUUID();
    await client.batch([
      statement(
        "INSERT OR IGNORE INTO control_workspaces(org_id,epoch,created_at) VALUES(?,0,?)",
        orgId,
        at,
      ),
      statement(
        "INSERT OR IGNORE INTO control_tools(id,org_id,name,active_revision,created_at) VALUES(?,?,?,?,?)",
        toolId,
        orgId,
        FIXTURE,
        REVISION,
        at,
      ),
      statement(
        `INSERT OR IGNORE INTO control_tool_revisions(id,tool_id,revision,input_schema,created_at)
        SELECT ?,id,?,?,? FROM control_tools WHERE org_id=? AND name=?`,
        crypto.randomUUID(),
        REVISION,
        JSON.stringify(fixtureDescriptor.inputSchema),
        at,
        orgId,
        FIXTURE,
      ),
      statement(
        "INSERT OR IGNORE INTO control_profiles(id,org_id,label,enabled,approval_lifetime_ms,dispatch_paused,revision,created_at,updated_at) VALUES(?,?,?,1,?,0,1,?,?)",
        profileId,
        orgId,
        label.trim(),
        DEFAULT_APPROVAL_LIFETIME_MS,
        at,
        at,
      ),
      statement(
        `INSERT OR IGNORE INTO control_profile_tools(id,profile_id,tool_id,enabled)
        SELECT ?,p.id,t.id,1 FROM control_profiles p JOIN control_tools t ON t.org_id=p.org_id
        WHERE p.org_id=? AND p.label=? AND t.name=?`,
        crypto.randomUUID(),
        orgId,
        label.trim(),
        FIXTURE,
      ),
      epoch(orgId),
      audit(orgId, null, null, "profile_provisioned", null, at),
    ]);
    const stored = await row<{ id: string }>(
      "SELECT id FROM control_profiles WHERE org_id=? AND label=?",
      orgId,
      label.trim(),
    );
    if (!stored) throw problem("internal_error", 500);
    return { profileId: stored.id, tool: FIXTURE };
  }

  async function issueGrant(
    orgId: string,
    profileId: string,
    label: string,
    expiresAt?: number | null,
    principalId: string | null = null,
  ) {
    await profile(orgId, profileId);
    if (typeof label !== "string" || !label.trim() || label.trim().length > 128)
      throw problem("invalid_request");
    const at = now();
    const expiry = expiresAt === undefined ? at + GRANT_LIFETIME_MS : expiresAt;
    if (expiry !== null && (!Number.isSafeInteger(expiry) || expiry <= at))
      throw problem("invalid_request");
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = `m1_${Array.from(tokenBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const grantId = crypto.randomUUID();
    const hash = await sha256(token);
    const created = await client.batch([
      statement(
        `INSERT INTO control_grants(id,org_id,profile_id,label,token_hash,expires_at,created_at,principal_id)
        SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM control_grants WHERE profile_id=? AND label=?) RETURNING id`,
        grantId,
        orgId,
        profileId,
        label.trim(),
        hash,
        expiry,
        at,
        principalId,
        profileId,
        label.trim(),
      ),
      epoch(orgId),
      statement(
        `INSERT INTO control_audit(id,org_id,grant_id,action,created_at)
        SELECT ?,org_id,id,'grant_issued',? FROM control_grants WHERE id=?`,
        crypto.randomUUID(),
        at,
        grantId,
      ),
    ]);
    if (!created[0]?.results.length)
      throw new ControlError(
        "invalid_request",
        "This Profile already has a Grant with that label.",
        409,
      );
    return { grantId, token, expiresAt: expiry };
  }

  async function authenticate(
    profileId: string,
    token: string,
  ): Promise<GrantIdentity> {
    const scoped = await row<{ org_id: string }>(
      "SELECT org_id FROM control_profiles WHERE id=?",
      profileId,
    );
    if (!scoped) throw problem("unauthenticated", 401);
    const found =
      typeof token === "string" && token.length > 0 && token.length <= 256
        ? await row<{ id: string; principal_id: string | null }>(
            "SELECT id,principal_id FROM control_grants WHERE profile_id=? AND token_hash=?",
            profileId,
            await sha256(token),
          )
        : null;
    if (!found) {
      await audit(
        scoped.org_id,
        null,
        null,
        "authentication_denied",
        "unauthenticated",
        now(),
      ).run();
      throw problem("unauthenticated", 401);
    }
    const identity = {
      id: found.id,
      orgId: scoped.org_id,
      profileId,
      principalId: found.principal_id,
    };
    await requireGrant(identity);
    return identity;
  }
  async function builtinTools(grant: GrantIdentity) {
    await requireGrant(grant);
    const tool = await row<ToolRow>(
      `SELECT t.id,t.active_revision,pt.enabled FROM control_tools t JOIN control_profile_tools pt ON pt.tool_id=t.id
      WHERE t.org_id=? AND pt.profile_id=? AND t.name=? AND pt.enabled=1`,
      grant.orgId,
      grant.profileId,
      FIXTURE,
    );
    await audit(
      grant.orgId,
      grant.id,
      null,
      "tools_discovered",
      null,
      now(),
    ).run();
    const visible: ToolDescriptor[] =
      tool?.active_revision === REVISION
        ? [fixtureDescriptor, getDescriptor]
        : [getDescriptor];
    return visible;
  }
  function toolDescriptor(published: FrozenTool): ToolDescriptor {
    const objectSchema = (schema: JSONSchema): JSONSchema => {
      if (!schemaHasObjectRoot(schema) || !isJsonObject(schema))
        throw problem("tool_unavailable", 409);
      return schema.type === "object" ? schema : { ...schema, type: "object" };
    };
    return {
      name: published.name,
      description: published.definition.description,
      inputSchema: objectSchema(published.definition.inputSchema),
      ...(published.definition.outputSchema !== undefined
        ? { outputSchema: objectSchema(published.definition.outputSchema) }
        : {}),
      annotations: {
        readOnlyHint: published.definition.operationClass === "read",
        destructiveHint: published.definition.operationClass === "destructive",
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }
  async function discover(grant: GrantIdentity) {
    const visible = await builtinTools(grant);
    if (runtime)
      visible.push(
        ...(await runtime.catalog.discover(grant.orgId, grant.profileId)).map(
          toolDescriptor,
        ),
      );
    return visible.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  async function resolveReservation(
    grant: GrantIdentity,
    tool: string,
    callerKey: string,
    fingerprint: string,
    snapshotEpoch: number,
    at: number,
  ): Promise<{ kind: "absent" | "retry" } | { kind: "found"; run: RunView }> {
    const reservation = await row<{ run_id: string; fingerprint: string }>(
      `SELECT run_id,fingerprint FROM control_dedup
      WHERE org_id=? AND grant_id=? AND profile_id=? AND tool=? AND caller_key=? AND expires_at>max(?,${SQL_NOW})`,
      grant.orgId,
      grant.id,
      grant.profileId,
      tool,
      callerKey,
      at,
    );
    if (!reservation) return { kind: "absent" };
    const active = await requireGrant(grant);
    if (active.epoch !== snapshotEpoch) return { kind: "retry" };
    await audit(
      grant.orgId,
      grant.id,
      reservation.run_id,
      reservation.fingerprint === fingerprint
        ? "duplicate"
        : "idempotency_conflict",
      reservation.fingerprint === fingerprint ? null : "idempotency_conflict",
      now(),
    ).run();
    if (reservation.fingerprint !== fingerprint)
      throw problem("idempotency_conflict", 409, reservation.run_id);
    return {
      kind: "found",
      run: await view(await runRow(grant.orgId, reservation.run_id, grant.id)),
    };
  }

  async function invoke(
    grant: GrantIdentity,
    input: { name: string; arguments: unknown; metadata?: unknown },
  ): Promise<RunView> {
    const runId = crypto.randomUUID();
    // No caller-controlled value is echoed in an error, audit reason, or display field.
    const toolName =
      typeof input.name === "string" &&
      /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(input.name) &&
      input.name.length <= 256
        ? input.name
        : "invalid.tool";
    const metadata = ExecutionRequestMetadata.safeParse(
      input.metadata === undefined ? {} : input.metadata,
    );
    const suppliedArguments =
      input.arguments === undefined ? {} : input.arguments;
    const parsed = FixtureArguments.safeParse(suppliedArguments);
    let originalArguments: unknown;
    let validation: ExecutionErrorCode | null = null;
    try {
      originalArguments = JSON.parse(canonicalJson(suppliedArguments));
      if (
        new TextEncoder().encode(
          canonicalJson({
            name: input.name,
            arguments: originalArguments,
            metadata: input.metadata ?? {},
          }),
        ).byteLength > MAX_REQUEST_BYTES
      ) {
        validation = "payload_too_large";
      }
    } catch {
      validation = "invalid_arguments";
    }
    if (!metadata.success) validation = "invalid_request";
    if (!parsed.success && validation === null)
      validation = "invalid_arguments";
    if (toolName !== FIXTURE && runtime) return invokeIntegration(grant, input);

    // Resolve a consistent authority snapshot. A concurrent mutation invalidates admission's epoch CAS.
    for (let snapshotAttempt = 0; snapshotAttempt < 5; snapshotAttempt++) {
      const current = await loadGrant(grant);
      const authorization = grantFailure(current, now());
      const tool = await row<ToolRow>(
        `SELECT t.id,t.active_revision,pt.enabled FROM control_tools t
        LEFT JOIN control_profile_tools pt ON pt.tool_id=t.id AND pt.profile_id=?
        WHERE t.org_id=? AND t.name=?`,
        grant.profileId,
        grant.orgId,
        toolName,
      );
      const policyRows = await rows<PolicyRow>(
        "SELECT pattern,decision,profile_id FROM control_policies WHERE org_id=? AND (profile_id=? OR profile_id IS NULL)",
        grant.orgId,
        grant.profileId,
      );
      const decision = resolvePolicy(
        toolName,
        policyRows.filter((rule) => rule.profile_id === null),
        policyRows.filter((rule) => rule.profile_id !== null),
      );
      const unavailable =
        toolName !== FIXTURE ||
        !tool ||
        !tool.enabled ||
        tool.active_revision !== REVISION;
      const failure =
        authorization ??
        (unavailable ? "tool_unavailable" : validation) ??
        (decision === "block" ? "policy_blocked" : null);
      const revision = tool?.active_revision ?? "unavailable";
      // Membership controls dispatch, not the identity of a known request.
      const validIdentity =
        !authorization && toolName === FIXTURE && Boolean(tool) && !validation;
      const fingerprint = validIdentity
        ? await sha256(
            canonicalJson({
              version: "m1",
              organization_id: grant.orgId,
              grant_id: grant.id,
              profile_id: grant.profileId,
              tool: toolName,
              tool_revision: revision,
              accounts: {},
              options: {},
              arguments: originalArguments,
            }),
          )
        : null;
      const callerKey =
        validIdentity && metadata.success
          ? (metadata.data.idempotency_key ?? null)
          : null;
      if (callerKey !== null && fingerprint !== null) {
        const existing = await resolveReservation(
          grant,
          toolName,
          callerKey,
          fingerprint,
          current.epoch,
          now(),
        );
        if (existing.kind === "retry") continue;
        if (existing.kind === "found") return existing.run;
      }
      const traceId = metadata.success
        ? (metadata.data.trace_id ?? null)
        : null;
      const status: RunStatus = failure
        ? failure === "policy_blocked" || authorization || unavailable
          ? "blocked"
          : "failed"
        : decision === "ask"
          ? "pending_approval"
          : "queued";
      const needsApproval = status === "pending_approval";
      const cipher =
        validIdentity && parsed.success
          ? await protection.encrypt(grant.orgId, runId, "request", {
              arguments: parsed.data,
              originalArguments,
              toolRevision: revision,
              originalPolicy: decision,
            })
          : null;
      const display =
        parsed.success && !validation && toolName === FIXTURE
          ? {
              value: parsed.data.value,
              ...(parsed.data.note === undefined ? {} : { note: "[redacted]" }),
              ...(parsed.data.fault === undefined
                ? {}
                : { fault: parsed.data.fault }),
            }
          : {};
      const dedupScope: Bound[] = [
        grant.orgId,
        grant.id,
        grant.profileId,
        toolName,
        callerKey,
      ];
      const absent =
        callerKey === null
          ? "1"
          : "NOT EXISTS(SELECT 1 FROM control_dedup WHERE org_id=? AND grant_id=? AND profile_id=? AND tool=? AND caller_key=?)";
      const statements: Statement[] = [];
      if (callerKey !== null)
        statements.push(
          statement(
            `DELETE FROM control_dedup WHERE org_id=? AND grant_id=? AND profile_id=? AND tool=? AND caller_key=? AND expires_at<=max(?,${SQL_NOW})`,
            ...dedupScope,
            now(),
          ),
        );
      // Freeze admission inside the winning transaction; every retention and
      // approval timestamp below derives from this immutable database time.
      statements.push(
        statement(
          `INSERT INTO control_runs(id,org_id,grant_id,profile_id,tool,tool_id,tool_revision,status,fingerprint,trace_id,
          policy_decision,display_json,created_at,updated_at,deadline,admitted_epoch,error_code,error_message,error_retryable,finished_at,result_format)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,admitted_at,admitted_at,
          CASE WHEN ?=1 THEN admitted_at+? ELSE NULL END,?,?,?,0,
          CASE WHEN ?=1 THEN admitted_at ELSE NULL END,'mcp'
        FROM (SELECT max(?,${SQL_NOW}) AS admitted_at) WHERE ${absent}
          AND EXISTS(SELECT 1 FROM control_workspaces WHERE org_id=? AND epoch=?)
          AND (?=1 OR EXISTS(SELECT 1 FROM control_grants g WHERE g.id=? AND ${PRINCIPAL_AUTHORITY_SQL}))`,
          runId,
          grant.orgId,
          grant.id,
          grant.profileId,
          toolName,
          tool?.id ?? null,
          revision,
          status,
          fingerprint,
          traceId,
          decision,
          JSON.stringify(display),
          needsApproval ? 1 : 0,
          current.approval_lifetime_ms,
          current.epoch,
          failure,
          failure ? (messages[failure] ?? "The request cannot execute.") : null,
          failure ? 1 : 0,
          now(),
          ...(callerKey === null ? [] : dedupScope),
          grant.orgId,
          current.epoch,
          authorization ? 1 : 0,
          grant.id,
        ),
      );
      if (cipher !== null)
        statements.push(
          statement(
            `INSERT INTO control_run_payloads(run_id,org_id,request_cipher,expires_at,result_format)
        SELECT id,org_id,?,created_at+?,'mcp' FROM control_runs WHERE id=?`,
            cipher,
            IDEMPOTENCY_RETENTION_MS,
            runId,
          ),
        );
      if (needsApproval)
        statements.push(
          statement(
            `INSERT INTO control_approvals(id,org_id,run_id,requested_revision,deadline,created_at)
        SELECT ?,org_id,id,tool_revision,deadline,created_at FROM control_runs WHERE id=?`,
            crypto.randomUUID(),
            runId,
          ),
        );
      if (callerKey !== null)
        statements.push(
          statement(
            `INSERT INTO control_dedup(id,org_id,grant_id,profile_id,tool,caller_key,fingerprint,run_id,expires_at)
        SELECT ?,org_id,grant_id,profile_id,tool,?,fingerprint,id,created_at+? FROM control_runs WHERE id=?`,
            crypto.randomUUID(),
            callerKey,
            IDEMPOTENCY_RETENTION_MS,
            runId,
          ),
        );
      statements.push(
        statement(
          `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
        SELECT ?,org_id,grant_id,id,'invocation',error_code,created_at FROM control_runs WHERE id=?`,
          crypto.randomUUID(),
          runId,
        ),
      );
      await client.batch(statements);
      const admitted = await row<RunRow>(
        "SELECT * FROM control_runs WHERE id=? AND org_id=?",
        runId,
        grant.orgId,
      );
      if (admitted) return view(admitted);
      if (callerKey !== null && fingerprint !== null) {
        const existing = await resolveReservation(
          grant,
          toolName,
          callerKey,
          fingerprint,
          current.epoch,
          now(),
        );
        if (existing.kind === "found") return existing.run;
      }
    }
    // No work has been admitted or dispatched when the authority epoch cannot stabilize.
    throw problem("rate_limited", 429, undefined, true);
  }

  function legacyBusinessResult(value: unknown): BusinessMcpResult {
    return BusinessMcpResult.parse({
      content: [{ type: "text", text: JSON.stringify(value) }],
      ...(isJsonObject(value) ? { structuredContent: value } : {}),
    });
  }
  async function selections(
    runId: string,
  ): Promise<Record<string, SelectedAccount>> {
    const result = Object.create(null) as Record<string, SelectedAccount>;
    for (const selected of await rows<{
      requirement: string;
      account_id: string;
      identity_digest: string;
      alias: string;
    }>(
      "SELECT requirement,account_id,identity_digest,alias FROM control_run_accounts WHERE run_id=? ORDER BY requirement",
      runId,
    ))
      result[selected.requirement] = {
        requirement: selected.requirement,
        accountId: selected.account_id,
        identityDigest: selected.identity_digest,
        alias: selected.alias,
      };
    return result;
  }
  function splitCipher(cipher: string): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < cipher.length; i += 262144)
      chunks.push(cipher.slice(i, i + 262144));
    return chunks;
  }
  async function payloadCipher(
    runId: string,
    kind: "request" | "result",
    count: number,
  ): Promise<string> {
    const chunks = await rows<{ chunk_index: number; cipher: string }>(
      "SELECT chunk_index,cipher FROM control_run_payload_chunks WHERE run_id=? AND kind=? ORDER BY chunk_index",
      runId,
      kind,
    );
    if (
      !count ||
      chunks.length !== count ||
      chunks.some((chunk, index) => chunk.chunk_index !== index)
    )
      throw problem("content_expired", 410, runId);
    return chunks.map((chunk) => chunk.cipher).join("");
  }
  async function blockWaiting(
    run: RunRow,
    code: ExecutionErrorCode,
  ): Promise<void> {
    const failed = [
      "invalid_arguments",
      "invalid_request",
      "content_expired",
      "payload_too_large",
      "internal_error",
    ].includes(code);
    await client.batch([
      statement(
        "UPDATE control_runs SET status=?,error_code=?,error_message=?,error_retryable=0,finished_at=?,updated_at=? WHERE id=? AND org_id=? AND status IN ('pending_approval','queued')",
        failed ? "failed" : "blocked",
        code,
        messages[code] ?? "Current authority does not permit this Tool.",
        now(),
        now(),
        run.id,
        run.org_id,
      ),
      audit(
        run.org_id,
        run.grant_id,
        run.id,
        "restriction_denied",
        code,
        now(),
      ),
    ]);
  }
  async function invokeIntegration(
    grant: GrantIdentity,
    input: { name: string; arguments: unknown; metadata?: unknown },
  ): Promise<RunView> {
    const validName = IntegrationToolName.safeParse(input.name).success;
    if (!validName) input = { ...input, name: "invalid.tool" };
    if (!runtime) throw problem("tool_unavailable", 409);
    const runId = crypto.randomUUID(),
      metadata = ExecutionRequestMetadata.safeParse(input.metadata ?? {}),
      original = input.arguments === undefined ? {} : input.arguments;
    let validation: ExecutionErrorCode | null =
      !validName || !metadata.success
        ? "invalid_request"
        : jsonProblem(original)
          ? "invalid_arguments"
          : !isJsonObject(original) || Object.hasOwn(original, "_account")
            ? "invalid_arguments"
            : null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await loadGrant(grant),
        authorization = grantFailure(current, now()),
        resolved = await runtime.catalog.resolveTool(
          grant.orgId,
          grant.profileId,
          input.name,
        );
      const policyRows = await rows<PolicyRow>(
        "SELECT pattern,decision,profile_id FROM control_policies WHERE org_id=? AND (profile_id=? OR profile_id IS NULL)",
        grant.orgId,
        grant.profileId,
      );
      const decision = resolvePolicy(
        input.name,
        policyRows.filter((p) => p.profile_id === null),
        policyRows.filter((p) => p.profile_id !== null),
      );
      let selected: Record<string, SelectedAccount> = {},
        accountFailure: ExecutionErrorCode | null = null;
      if (resolved && !validation) {
        if (
          !validateInput(resolved.tool.definition.inputSchema, original, {
            direction: "request",
            dialect:
              resolved.tool.definition.implementation.kind === "http"
                ? resolved.tool.definition.implementation.dialect
                : undefined,
          }).valid
        )
          validation = "invalid_arguments";
        try {
          selected = await runtime.accounts.resolveBoundIdentities({
            orgId: grant.orgId,
            principalId: current.principal_id,
            requirements: resolved.tool.definition.requirements,
            bindings: await runtime.catalog.bindings(
              grant.orgId,
              grant.profileId,
            ),
            integrationSlug: resolved.slug,
          });
        } catch (error) {
          accountFailure =
            error instanceof ControlError ? error.code : "internal_error";
        }
      }
      const unavailable = !resolved || !resolved.enabled || !resolved.available;
      let failure =
        authorization ??
        (unavailable ? "tool_unavailable" : null) ??
        validation ??
        accountFailure ??
        (decision === "block" ? "policy_blocked" : null);
      const validIdentity =
        !authorization && Boolean(resolved) && !validation && !accountFailure;
      const accounts = Object.fromEntries(
        Object.entries(selected).map(([key, value]) => [
          key,
          {
            account_id: value.accountId,
            identity_digest: value.identityDigest,
          },
        ]),
      );
      const fingerprint = validIdentity
        ? await sha256(
            canonicalJson({
              version: "m2",
              organization_id: grant.orgId,
              grant_id: grant.id,
              profile_id: grant.profileId,
              tool: input.name,
              tool_revision: resolved!.tool.toolRevision,
              integration_revision: resolved!.tool.integrationRevision,
              accounts,
              options: {},
              arguments: original,
            }),
          )
        : null;
      let callerKey =
        validIdentity && metadata.success
          ? (metadata.data.idempotency_key ?? null)
          : null;
      if (callerKey && fingerprint) {
        const reservation = await resolveReservation(
          grant,
          input.name,
          callerKey,
          fingerprint,
          current.epoch,
          now(),
        );
        if (reservation.kind === "retry") continue;
        if (reservation.kind === "found") return reservation.run;
      }
      if (validIdentity)
        try {
          await runtime.accounts.verifySelections({
            orgId: grant.orgId,
            principalId: current.principal_id,
            requirements: resolved!.tool.definition.requirements,
            selections: selected,
          });
        } catch (error) {
          accountFailure =
            error instanceof ControlError ? error.code : "internal_error";
          failure = failure ?? accountFailure;
          callerKey = null;
        }
      const status: RunStatus = failure
        ? authorization ||
          unavailable ||
          accountFailure ||
          failure === "policy_blocked"
          ? "blocked"
          : "failed"
        : decision === "ask"
          ? "pending_approval"
          : "queued";
      const cipher = validIdentity
        ? await protection.encrypt(grant.orgId, runId, "request", {
            arguments: original,
            originalPolicy: decision,
            toolRevision: resolved!.tool.toolRevision,
            integrationRevision: resolved!.tool.integrationRevision,
            artifactDigest: resolved!.tool.artifactDigest,
            selections: selected,
          })
        : null;
      const chunks = cipher ? splitCipher(cipher) : [],
        at = now(),
        scope: Bound[] = [
          grant.orgId,
          grant.id,
          grant.profileId,
          input.name,
          callerKey,
        ];
      const statements: Statement[] = callerKey
        ? [
            statement(
              `DELETE FROM control_dedup WHERE org_id=? AND grant_id=? AND profile_id=? AND tool=? AND caller_key=? AND expires_at<=max(?,${SQL_NOW})`,
              ...scope,
              at,
            ),
          ]
        : [];
      statements.push(
        statement(
          `INSERT INTO control_runs(id,org_id,grant_id,profile_id,tool,tool_id,tool_revision,status,fingerprint,trace_id,policy_decision,display_json,created_at,updated_at,deadline,admitted_epoch,error_code,error_message,error_retryable,finished_at,fingerprint_version,integration_id,integration_revision_id,artifact_digest,result_format,admission_ready,wall_timeout_ms)
        SELECT ?,?,?,?,?,?,?,?,?,?,?, '{}',admitted_at,admitted_at,CASE WHEN ?=1 THEN admitted_at+? ELSE NULL END,?,?,?,0,CASE WHEN ?=1 THEN admitted_at ELSE NULL END,'m2',?,?,?,'mcp',0,60000
        FROM(SELECT max(?,${SQL_NOW}) AS admitted_at) WHERE EXISTS(SELECT 1 FROM control_workspaces WHERE org_id=? AND epoch=?)
        AND (?=1 OR EXISTS(SELECT 1 FROM control_grants g WHERE g.id=? AND ${PRINCIPAL_AUTHORITY_SQL})) ${callerKey ? "AND NOT EXISTS(SELECT 1 FROM control_dedup WHERE org_id=? AND grant_id=? AND profile_id=? AND tool=? AND caller_key=?)" : ""}`,
          runId,
          grant.orgId,
          grant.id,
          grant.profileId,
          input.name,
          resolved?.tool.toolId ?? null,
          resolved?.tool.toolRevision ?? "unavailable",
          status,
          fingerprint,
          metadata.success ? (metadata.data.trace_id ?? null) : null,
          decision,
          status === "pending_approval" ? 1 : 0,
          current.approval_lifetime_ms,
          current.epoch,
          failure,
          failure ? (messages[failure] ?? "The request cannot execute.") : null,
          failure ? 1 : 0,
          resolved?.tool.integrationId ?? null,
          resolved?.tool.integrationRevision ?? null,
          resolved?.tool.artifactDigest ?? null,
          at,
          grant.orgId,
          current.epoch,
          authorization ? 1 : 0,
          grant.id,
          ...(callerKey ? scope : []),
        ),
      );
      if (cipher) {
        statements.push(
          statement(
            "INSERT INTO control_run_payloads(run_id,org_id,expires_at,result_format,request_chunk_count) SELECT id,org_id,created_at+?,'mcp',? FROM control_runs WHERE id=?",
            IDEMPOTENCY_RETENTION_MS,
            chunks.length,
            runId,
          ),
        );
        for (const [index, chunk] of chunks.entries())
          statements.push(
            statement(
              "INSERT INTO control_run_payload_chunks(run_id,kind,chunk_index,cipher) SELECT id,'request',?,? FROM control_runs WHERE id=?",
              index,
              chunk,
              runId,
            ),
          );
        for (const [key, selection] of Object.entries(selected))
          statements.push(
            statement(
              "INSERT INTO control_run_accounts(run_id,requirement,account_id,identity_digest,alias,requirement_json) SELECT id,?,?,?,?,? FROM control_runs WHERE id=?",
              key,
              selection.accountId,
              selection.identityDigest,
              selection.alias,
              canonicalJson(resolved!.tool.definition.requirements[key]),
              runId,
            ),
          );
      }
      if (status === "pending_approval")
        statements.push(
          statement(
            "INSERT INTO control_approvals(id,org_id,run_id,requested_revision,deadline,created_at) SELECT ?,org_id,id,tool_revision,deadline,created_at FROM control_runs WHERE id=?",
            crypto.randomUUID(),
            runId,
          ),
        );
      if (callerKey)
        statements.push(
          statement(
            "INSERT INTO control_dedup(id,org_id,grant_id,profile_id,tool,caller_key,fingerprint,run_id,expires_at) SELECT ?,org_id,grant_id,profile_id,tool,?,fingerprint,id,created_at+? FROM control_runs WHERE id=?",
            crypto.randomUUID(),
            callerKey,
            IDEMPOTENCY_RETENTION_MS,
            runId,
          ),
        );
      statements.push(
        statement(
          "INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at) SELECT ?,org_id,grant_id,id,'invocation',error_code,created_at FROM control_runs WHERE id=?",
          crypto.randomUUID(),
          runId,
        ),
      );
      await client.batch(statements);
      const admitted = await row<RunRow>(
        "SELECT * FROM control_runs WHERE id=? AND org_id=?",
        runId,
        grant.orgId,
      );
      if (admitted) {
        if (
          admitted.status === "queued" ||
          admitted.status === "pending_approval"
        )
          await prepareRun(admitted);
        return view(await runRow(grant.orgId, runId, grant.id));
      }
    }
    throw problem("rate_limited", 429, undefined, true);
  }
  async function prepareRun(run: RunRow): Promise<void> {
    if (!runtime || run.admission_ready) return;
    try {
      const authority = await verifyRunAuthority(run),
        payload = await row<PayloadRow>(
          "SELECT * FROM control_run_payloads WHERE run_id=? AND org_id=?",
          run.id,
          run.org_id,
        );
      if (!payload || payload.expires_at <= now())
        throw problem("content_expired", 410, run.id);
      const cipher =
        payload.request_cipher ??
        (await payloadCipher(run.id, "request", payload.request_chunk_count));
      const frozen = await protection.decrypt<{
        arguments: Record<string, JSONValue>;
        toolRevision: string;
        integrationRevision: string;
        artifactDigest: string;
        selections: Record<string, SelectedAccount>;
      }>(run.org_id, run.id, "request", cipher);
      if (
        frozen.toolRevision !== run.tool_revision ||
        frozen.integrationRevision !== run.integration_revision_id ||
        frozen.artifactDigest !== run.artifact_digest ||
        canonicalJson(frozen.selections) !==
          canonicalJson(authority.selected) ||
        jsonProblem(frozen.arguments)
      )
        throw problem("tool_unavailable", 409, run.id);
      await runtime.prepare({
        runId: run.id,
        claimId: "admission",
        orgId: run.org_id,
        grantId: run.grant_id,
        profileId: run.profile_id,
        principalId: authority.grant.principal_id,
        tool: authority.tool,
        arguments: frozen.arguments,
        selections: authority.selected,
        retentionDeadline: run.deadline,
        deadlineMs: Math.min(
          run.deadline ?? Infinity,
          now() + run.wall_timeout_ms,
        ),
        beforeRequest: async () => {
          throw problem("forbidden", 403, run.id);
        },
        onLogs: async () => {
          throw problem("forbidden", 403, run.id);
        },
      });
      await verifyRunAuthority(run);
      await statement(
        "UPDATE control_runs SET admission_ready=1 WHERE id=? AND org_id=? AND status IN ('pending_approval','queued')",
        run.id,
        run.org_id,
      ).run();
    } catch (error) {
      const parsedCode = ExecutionErrorCode.safeParse(
        error instanceof Error && "code" in error ? error.code : undefined,
      );
      await blockWaiting(
        run,
        error instanceof ControlError
          ? error.code
          : parsedCode.success
            ? parsedCode.data
            : "invalid_arguments",
      );
    }
  }
  async function verifyRunAuthority(
    run: RunRow,
    contentRead = false,
  ): Promise<{
    tool: FrozenTool;
    selected: Record<string, SelectedAccount>;
    grant: GrantRow;
  }> {
    if (!runtime || !run.tool_id)
      throw problem("tool_unavailable", 409, run.id);
    const grant = await requireGrant({
      id: run.grant_id,
      orgId: run.org_id,
      profileId: run.profile_id,
    });
    const tool = await runtime.catalog.retainedTool(
      run.org_id,
      run.tool_id,
      run.tool_revision,
    );
    if (
      !tool ||
      tool.integrationId !== run.integration_id ||
      tool.integrationRevision !== run.integration_revision_id ||
      tool.artifactDigest !== run.artifact_digest
    )
      throw problem("tool_unavailable", 409, run.id);
    if (contentRead) {
      const current = await row(
        `SELECT r.id FROM control_runs r JOIN control_integrations i ON i.id=r.integration_id JOIN control_integration_revisions ir ON ir.id=r.integration_revision_id JOIN control_profile_tools pt ON pt.profile_id=r.profile_id AND pt.tool_id=r.tool_id
        WHERE r.id=? AND i.org_id=r.org_id AND i.enabled=1 AND ir.available=1 AND ir.status<>'draft' AND pt.enabled=1 AND NOT EXISTS(SELECT 1 FROM control_tool_availability a WHERE a.tool_id=r.tool_id AND a.revision=r.tool_revision AND a.available=0)`,
        run.id,
      );
      if (!current) throw problem("forbidden", 403, run.id);
    } else {
      const restriction = await row<{ code: ExecutionErrorCode | null }>(
        `SELECT ${RESTRICTION_SQL} AS code FROM control_runs r WHERE r.id=?`,
        now(),
        now(),
        run.id,
      );
      if (restriction?.code) throw problem(restriction.code, 409, run.id);
    }
    const selected = await selections(run.id);
    await runtime.accounts.verifySelections({
      orgId: run.org_id,
      principalId: grant.principal_id,
      requirements: tool.definition.requirements,
      selections: selected,
    });
    return { tool, selected, grant };
  }
  function consoleEntries(value: unknown): value is RunConsoleEntry[] {
    if (!Array.isArray(value) || jsonProblem(value, 98304)) return false;
    const levels: Record<string, true> = {
      log: true,
      info: true,
      warn: true,
      error: true,
    };
    return value.every(
      (entry) =>
        isJsonObject(entry) &&
        Object.keys(entry).length === 2 &&
        typeof entry.level === "string" &&
        levels[entry.level] === true &&
        typeof entry.text === "string",
    );
  }
  // Quota counts serialized entries, including their level/text wrappers, not batching delimiters.
  function consoleEntryBytes(entries: readonly RunConsoleEntry[]): number {
    const encoder = new TextEncoder();
    return entries.reduce(
      (bytes, entry) => bytes + encoder.encode(JSON.stringify(entry)).length,
      0,
    );
  }
  async function appendConsole(
    run: RunRow,
    entries: readonly RunConsoleEntry[],
  ): Promise<void> {
    if (!entries.length) return;
    if (!consoleEntries(entries)) throw problem("sandbox_limit", 409, run.id);
    const bytes = consoleEntryBytes(entries),
      at = now();
    const retained = await row<{
      expires_at: number;
      sequence: number;
      size_bytes: number;
    }>(
      `SELECT p.expires_at,
      coalesce((SELECT max(sequence) FROM control_run_log_chunks WHERE run_id=r.id),-1)+1 AS sequence,
      coalesce((SELECT sum(plaintext_bytes) FROM control_run_log_chunks WHERE run_id=r.id),0) AS size_bytes
      FROM control_runs r JOIN control_run_payloads p ON p.run_id=r.id WHERE r.id=? AND r.org_id=? AND r.status='running' AND r.lease_owner=? AND r.lease_until>max(?,${SQL_NOW}) AND p.expires_at>max(?,${SQL_NOW})`,
      run.id,
      run.org_id,
      run.lease_owner,
      at,
      at,
    );
    if (!retained) throw problem("execution_timeout", 409, run.id);
    if (retained.size_bytes + bytes > 65536)
      throw problem("sandbox_limit", 409, run.id);
    // The immutable chunk sequence is part of the AEAD domain, never a public Run identity.
    const cipher = await protection.encrypt(
      run.org_id,
      run.id + ":console:" + retained.sequence,
      "result",
      entries,
    );
    const stored = await statement(
      `INSERT INTO control_run_log_chunks(run_id,sequence,plaintext_bytes,cipher,created_at,expires_at)
      SELECT r.id,?,?,?,?,p.expires_at FROM control_runs r JOIN control_run_payloads p ON p.run_id=r.id
      WHERE r.id=? AND r.org_id=? AND r.status='running' AND r.lease_owner=? AND r.lease_until>max(?,${SQL_NOW}) AND p.expires_at>max(?,${SQL_NOW})
      AND ?=coalesce((SELECT max(sequence) FROM control_run_log_chunks WHERE run_id=r.id),-1)+1
      AND ?+coalesce((SELECT sum(plaintext_bytes) FROM control_run_log_chunks WHERE run_id=r.id),0)<=65536 RETURNING run_id`,
      retained.sequence,
      bytes,
      cipher,
      at,
      run.id,
      run.org_id,
      run.lease_owner,
      at,
      at,
      retained.sequence,
      bytes,
    ).all();
    if (!stored.results.length) throw problem("execution_timeout", 409, run.id);
  }
  async function beforeOutbound(
    run: RunRow,
    input: Parameters<IntegrationInvocation["beforeRequest"]>[0],
  ): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { grant } = await verifyRunAuthority(run),
        at = now();
      const sent = await statement(
        `UPDATE control_runs AS r SET outbound_remaining=outbound_remaining-1,claim_epoch=?,
        effect_state=CASE WHEN ?=1 THEN effect_state ELSE 'possible' END,effect_evidence_json=CASE WHEN ?=1 THEN effect_evidence_json ELSE '{"state":"possible"}' END
        WHERE r.id=? AND r.org_id=? AND r.status='running' AND r.lease_owner=? AND r.lease_until>max(?,${SQL_NOW}) AND r.outbound_remaining>0
        AND EXISTS(SELECT 1 FROM control_workspaces w WHERE w.org_id=r.org_id AND w.epoch=?) AND ${RESTRICTION_SQL} IS NULL RETURNING id`,
        grant.epoch,
        input.controlTraffic === true ? 1 : 0,
        input.controlTraffic === true ? 1 : 0,
        run.id,
        run.org_id,
        run.lease_owner,
        at,
        grant.epoch,
        at,
        at,
      ).all();
      if (sent.results.length) return;
      const current = await runRow(run.org_id, run.id);
      if (current.outbound_remaining === 0)
        throw problem("execution_failed", 409, run.id);
      if (
        current.status !== "running" ||
        current.lease_owner !== run.lease_owner ||
        !current.lease_until ||
        current.lease_until <= now()
      )
        throw problem("execution_timeout", 409, run.id);
    }
    throw problem("forbidden", 403, run.id);
  }
  async function executeIntegrationClaim(run: RunRow): Promise<void> {
    if (!runtime) return;
    let invocation: IntegrationInvocation | undefined;
    try {
      const authority = await verifyRunAuthority(run),
        payload = await row<PayloadRow>(
          "SELECT * FROM control_run_payloads WHERE run_id=? AND org_id=?",
          run.id,
          run.org_id,
        );
      if (!payload || payload.expires_at <= now())
        throw problem("content_expired", 410, run.id);
      const cipher =
        payload.request_cipher ??
        (await payloadCipher(run.id, "request", payload.request_chunk_count));
      const frozen = await protection.decrypt<{
        arguments: Record<string, JSONValue>;
        toolRevision: string;
        integrationRevision: string;
        artifactDigest: string;
        selections: Record<string, SelectedAccount>;
      }>(run.org_id, run.id, "request", cipher);
      if (
        frozen.toolRevision !== run.tool_revision ||
        frozen.integrationRevision !== run.integration_revision_id ||
        frozen.artifactDigest !== run.artifact_digest ||
        canonicalJson(frozen.selections) !==
          canonicalJson(authority.selected) ||
        jsonProblem(frozen.arguments) ||
        !validateInput(
          authority.tool.definition.inputSchema,
          frozen.arguments,
          {
            direction: "request",
            dialect:
              authority.tool.definition.implementation.kind === "http"
                ? authority.tool.definition.implementation.dialect
                : undefined,
          },
        ).valid
      )
        throw problem("tool_unavailable", 409, run.id);
      invocation = {
        runId: run.id,
        claimId: run.lease_owner!,
        orgId: run.org_id,
        grantId: run.grant_id,
        profileId: run.profile_id,
        principalId: authority.grant.principal_id,
        tool: authority.tool,
        arguments: frozen.arguments,
        selections: authority.selected,
        retentionDeadline: run.deadline,
        deadlineMs: run.lease_until!,
        beforeRequest: (input) => beforeOutbound(run, input),
        onLogs: (entries) => appendConsole(run, entries),
      };
      const outcome = await runtime.invokeTool(invocation),
        effect = EffectEvidence.parse(outcome.effect);
      await recordEffect(run, effect);
      const at = now(),
        business = await runtime.finalizeResult(
          invocation,
          BusinessMcpResult.parse(outcome.result),
          at,
        );
      // Correlation IDs allow 128 arbitrary UTF-16 units; NUL uses the longest JSON escape.
      const presentation = toolResult({
        runId: run.id,
        grantId: run.grant_id,
        profileId: run.profile_id,
        tool: run.tool,
        status: "succeeded",
        createdAt: run.created_at,
        deadline: run.deadline,
        attempts: run.attempts,
        businessResult: business,
        accounts: Object.fromEntries(
          Object.entries(authority.selected).map(([key, value]) => [
            key,
            value.alias,
          ]),
        ),
      });
      const resultBytes = new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "\0".repeat(128),
          result: presentation,
        }),
      ).length;
      if (resultBytes > MAX_REQUEST_BYTES)
        throw problem("payload_too_large", 413, run.id);
      const encrypted = await protection.encrypt(run.org_id, run.id, "result", {
          format: "mcp",
          result: business,
        }),
        chunks = splitCipher(encrypted);
      const guard = `EXISTS(SELECT 1 FROM control_runs WHERE id=? AND status='running' AND lease_owner=? AND lease_until>max(?,${SQL_NOW}))`;
      await client.batch([
        ...chunks.map((chunk, index) =>
          statement(
            `INSERT INTO control_run_payload_chunks(run_id,kind,chunk_index,cipher) SELECT ?,'result',?,? WHERE ${guard}`,
            run.id,
            index,
            chunk,
            run.id,
            run.lease_owner,
            at,
          ),
        ),
        statement(
          `UPDATE control_run_payloads SET result_chunk_count=? WHERE run_id=? AND org_id=? AND ${guard}`,
          chunks.length,
          run.id,
          run.org_id,
          run.id,
          run.lease_owner,
          at,
        ),
        statement(
          `UPDATE control_attempts SET ended_at=?,outcome='succeeded' WHERE run_id=? AND lease_owner=? AND ended_at IS NULL AND ${guard}`,
          at,
          run.id,
          run.lease_owner,
          run.id,
          run.lease_owner,
          at,
        ),
        statement(
          `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at) SELECT ?,org_id,grant_id,id,'execution_finished',?,? FROM control_runs WHERE id=? AND status='running' AND lease_owner=?`,
          crypto.randomUUID(),
          effect.state,
          at,
          run.id,
          run.lease_owner,
        ),
        statement(
          `UPDATE control_runs SET status='succeeded',effect_state=?,effect_evidence_json=?,lease_owner=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE id=? AND org_id=? AND status='running' AND lease_owner=? AND lease_until>max(?,${SQL_NOW})`,
          effect.state,
          canonicalJson(effect),
          at,
          at,
          run.id,
          run.org_id,
          run.lease_owner,
          at,
        ),
      ]);
    } catch (error) {
      const current = await runRow(run.org_id, run.id);
      if (
        current.status !== "running" ||
        current.lease_owner !== run.lease_owner
      )
        return;
      const supplied =
        error instanceof Error && "effect" in error
          ? EffectEvidence.safeParse(error.effect)
          : null;
      const effect = supplied?.success
        ? supplied.data
        : current.effect_evidence_json
          ? EffectEvidence.parse(JSON.parse(current.effect_evidence_json))
          : ({ state: current.effect_state } as EffectEvidence);
      await recordEffect(run, effect);
      const parsedCode = ExecutionErrorCode.safeParse(
        error instanceof Error && "code" in error ? error.code : undefined,
      );
      const code = parsedCode.success ? parsedCode.data : "execution_failed";
      const safe =
        effect.state === "verified_no_effect" ||
        effect.state === "not_dispatched" ||
        (effect.state === "provider_idempotent" &&
          Date.parse(effect.expiresAt) > now());
      const retryable =
        error instanceof Error &&
        "retryable" in error &&
        error.retryable === true;
      if (
        safe &&
        retryable &&
        run.attempts < MAX_ATTEMPTS &&
        run.lease_until! > now()
      ) {
        await client.batch([
          statement(
            "UPDATE control_attempts SET ended_at=?,outcome='verified_before_effect' WHERE run_id=? AND lease_owner=? AND ended_at IS NULL",
            now(),
            run.id,
            run.lease_owner,
          ),
          statement(
            `UPDATE control_runs SET status='queued',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_until>max(?,${SQL_NOW})`,
            now(),
            run.id,
            run.lease_owner,
            now(),
          ),
        ]);
        return;
      }
      if (invocation)
        try {
          await runtime.completed?.(invocation, now());
        } catch {}
      const unknown =
        effect.state === "possible" || effect.state === "provider_idempotent";
      await finish(
        run,
        unknown ? "outcome_unknown" : "failed",
        unknown ? "outcome_unknown" : code,
      );
    }
  }
  async function recordEffect(run: RunRow, effect: EffectEvidence) {
    await statement(
      "UPDATE control_runs SET effect_state=?,effect_evidence_json=? WHERE id=? AND org_id=? AND status='running' AND lease_owner=?",
      effect.state,
      canonicalJson(effect),
      run.id,
      run.org_id,
      run.lease_owner,
    ).run();
  }
  async function authorizeArtifactAccess(
    principal: ArtifactPrincipal,
    scope: ArtifactScope,
    operation: "upload" | "read" | "audit",
  ) {
    if (principal.orgId !== scope.orgId) throw problem("not_found", 404);
    const grant = await requireGrant({
      id: scope.grantId,
      orgId: scope.orgId,
      profileId: scope.profileId,
    });
    if (
      principal.kind === "grant" &&
      (principal.grantId !== scope.grantId ||
        principal.profileId !== scope.profileId)
    )
      throw problem("not_found", 404);
    if (scope.runId) {
      try {
        const run = await runRow(scope.orgId, scope.runId, scope.grantId);
        await verifyRunAuthority(run, true);
      } catch {
        throw problem("forbidden", 403);
      }
    }
    if (operation === "upload" && principal.kind !== "owner")
      throw problem("forbidden", 403);
    // Stage uploads have no producing Run; they confer no new credential capability.
    if (
      Object.keys(scope.selectedAccounts).length &&
      (!scope.runId || grant.principal_id === undefined)
    )
      throw problem("forbidden", 403);
  }
  async function authorizeArtifactRun(
    context: ArtifactRunContext,
    source?: ArtifactProvenance,
    targetRequirement?: string | null,
  ) {
    const run = await runRow(context.orgId, context.runId, context.grantId),
      authority = await verifyRunAuthority(run);
    const preparing =
      context.claimId === "admission" &&
      (run.status === "pending_approval" || run.status === "queued") &&
      run.admission_ready === 0;
    if (
      run.profile_id !== context.profileId ||
      context.deadline !== run.deadline ||
      !Number.isFinite(context.executionDeadline) ||
      context.executionDeadline <= now() ||
      (preparing &&
        context.executionDeadline >
          Math.min(run.deadline ?? Infinity, now() + run.wall_timeout_ms)) ||
      (!preparing &&
        (run.status !== "running" ||
          run.lease_owner !== context.claimId ||
          !run.lease_until ||
          run.lease_until <= now() ||
          context.executionDeadline !== run.lease_until)) ||
      canonicalJson(authority.selected) !==
        canonicalJson(context.selectedAccounts)
    )
      throw problem("forbidden", 403);
    if (targetRequirement && !(targetRequirement in authority.selected))
      throw problem("account_missing", 409);
    if (source)
      await authorizeArtifactAccess(
        {
          kind: "grant",
          orgId: context.orgId,
          profileId: context.profileId,
          grantId: context.grantId,
          principalId: authority.grant.principal_id,
        },
        source,
        "read",
      );
  }
  function cursorMessage(
    grant: GrantIdentity,
    epoch: number,
    offset: number,
    expiresAt: number,
  ) {
    return cursorEncoder.encode(
      canonicalJson({
        version: 1,
        organization_id: grant.orgId,
        grant_id: grant.id,
        profile_id: grant.profileId,
        epoch,
        offset,
        expiresAt,
      }),
    );
  }
  async function readCursor(
    grant: GrantIdentity,
    epoch: number,
    cursor: string,
  ) {
    if (!/^1\.[A-Za-z0-9_-]{71}$/.test(cursor))
      throw problem("invalid_request");
    let packed: Uint8Array<ArrayBuffer>;
    try {
      packed = Uint8Array.from(
        atob(cursor.slice(2).replace(/-/g, "+").replace(/_/g, "/") + "="),
        (c) => c.charCodeAt(0),
      );
    } catch {
      throw problem("invalid_request");
    }
    if (packed.length !== 53 || packed[0] !== 1)
      throw problem("invalid_request");
    const view = new DataView(
        packed.buffer,
        packed.byteOffset,
        packed.byteLength,
      ),
      storedEpoch = Number(view.getBigUint64(1)),
      expiresAt = Number(view.getBigUint64(9)),
      offset = view.getUint32(17);
    if (
      !Number.isSafeInteger(storedEpoch) ||
      storedEpoch !== epoch ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now() ||
      expiresAt > now() + 600000 ||
      !(await crypto.subtle.verify(
        "HMAC",
        await cursorKey!,
        packed.subarray(21),
        cursorMessage(grant, epoch, offset, expiresAt),
      ))
    )
      throw problem("invalid_request");
    return { offset, expiresAt };
  }
  async function makeCursor(
    grant: GrantIdentity,
    epoch: number,
    offset: number,
    expiresAt: number,
  ) {
    const packed = new Uint8Array(53),
      view = new DataView(packed.buffer);
    packed[0] = 1;
    view.setBigUint64(1, BigInt(epoch));
    view.setBigUint64(9, BigInt(expiresAt));
    view.setUint32(17, offset);
    packed.set(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await cursorKey!,
          cursorMessage(grant, epoch, offset, expiresAt),
        ),
      ),
      21,
    );
    return (
      "1." +
      btoa(String.fromCharCode(...packed))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
    );
  }
  async function discoveryPage(
    grant: GrantIdentity,
    cursor?: string,
  ): Promise<{ tools: ToolDescriptor[]; nextCursor?: string }> {
    let current = await requireGrant(grant);
    if (!runtime) {
      if (cursor !== undefined) throw problem("invalid_request");
      return { tools: await discover(grant) };
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const builtins = await builtinTools(grant),
        names = [
          ...builtins.map((t) => t.name),
          ...(await runtime.catalog.names(grant.orgId, grant.profileId)),
        ].sort();
      let offset = 0,
        expiresAt = now() + 600000;
      if (cursor !== undefined)
        ({ offset, expiresAt } = await readCursor(
          grant,
          current.epoch,
          cursor,
        ));
      if (offset >= names.length) throw problem("invalid_request");
      const pageNames = names.slice(offset, offset + 50),
        published = await runtime.catalog.discover(
          grant.orgId,
          grant.profileId,
          pageNames,
        ),
        byName = new Map(
          [...builtins, ...published.map(toolDescriptor)].map((tool) => [
            tool.name,
            tool,
          ]),
        );
      const after = await requireGrant(grant);
      if (after.epoch !== current.epoch) {
        current = after;
        continue;
      }
      const tools: ToolDescriptor[] = [];
      let size = 512;
      for (const name of pageNames) {
        const tool = byName.get(name);
        if (!tool) throw problem("invalid_request");
        const bytes = cursorEncoder.encode(JSON.stringify(tool)).length + 1;
        if (size + bytes > MAX_REQUEST_BYTES - 4096) break;
        tools.push(tool);
        size += bytes;
        offset++;
      }
      if (!tools.length) throw problem("payload_too_large", 413);
      return {
        tools,
        ...(offset < names.length
          ? {
              nextCursor: await makeCursor(
                grant,
                current.epoch,
                offset,
                expiresAt,
              ),
            }
          : {}),
      };
    }
    throw problem("rate_limited", 503);
  }

  async function getRun(grant: GrantIdentity, runId: string): Promise<RunView> {
    await requireGrant(grant);
    const stored = await runRow(grant.orgId, runId, grant.id);
    if (stored.profile_id !== grant.profileId) throw problem("not_found", 404);
    return view(stored);
  }
  async function ownerView(run: RunRow): Promise<OwnerRunView> {
    const result: OwnerRunView = await view(run, true);
    if (run.fingerprint_version !== "m2") return result;
    result.outboundRequests = 30 - run.outbound_remaining;
    result.effectState = run.effect_state;
    result.logs = [];
    const chunks = await rows<{
      sequence: number;
      plaintext_bytes: number;
      cipher: string;
    }>(
      "SELECT sequence,plaintext_bytes,cipher FROM control_run_log_chunks WHERE run_id=? AND expires_at>max(?, " +
        SQL_NOW +
        ") ORDER BY sequence",
      run.id,
      now(),
    );
    let total = 0;
    for (const [index, chunk] of chunks.entries()) {
      if (chunk.sequence !== index)
        throw problem("internal_error", 500, run.id);
      let entries: unknown;
      try {
        entries = await protection.decrypt(
          run.org_id,
          run.id + ":console:" + chunk.sequence,
          "result",
          chunk.cipher,
        );
      } catch {
        throw problem("internal_error", 500, run.id);
      }
      if (
        !consoleEntries(entries) ||
        consoleEntryBytes(entries) !== chunk.plaintext_bytes
      )
        throw problem("internal_error", 500, run.id);
      total += chunk.plaintext_bytes;
      if (total > 65536) throw problem("internal_error", 500, run.id);
      result.logs.push(...entries);
    }
    return result;
  }
  async function ownerRuns(orgId: string): Promise<OwnerRunView[]> {
    const stored = await rows<RunRow>(
      "SELECT * FROM control_runs WHERE org_id=? ORDER BY created_at DESC,id DESC",
      orgId,
    );
    return Promise.all(stored.map(ownerView));
  }
  async function ownerRun(orgId: string, runId: string): Promise<OwnerRunView> {
    return ownerView(await runRow(orgId, runId));
  }

  async function decide(
    orgId: string,
    runId: string,
    decision: "approve" | "deny",
  ): Promise<RunView> {
    if (decision !== "approve" && decision !== "deny")
      throw problem("invalid_request");
    await runRow(orgId, runId);
    const at = now();
    await client.batch([
      epoch(orgId),
      ...restrictWaiting(orgId, at),
      statement(
        `UPDATE control_approvals SET decision=?,decided_at=? WHERE org_id=? AND run_id=? AND decision IS NULL
        AND deadline>max(?,${SQL_NOW}) AND EXISTS(SELECT 1 FROM control_runs WHERE id=? AND org_id=? AND status='pending_approval')`,
        decision,
        at,
        orgId,
        runId,
        at,
        runId,
        orgId,
      ),
      statement(
        `UPDATE control_runs SET status=?,approved_revision=CASE WHEN ?='approve' THEN tool_revision ELSE NULL END,
        error_code=?,error_message=?,error_retryable=0,finished_at=?,updated_at=?
        WHERE id=? AND org_id=? AND status='pending_approval' AND deadline>max(?,${SQL_NOW})
          AND EXISTS(SELECT 1 FROM control_approvals a WHERE a.run_id=control_runs.id AND a.decision=? AND a.decided_at=?)`,
        decision === "approve" ? "queued" : "denied",
        decision,
        decision === "deny" ? "approval_denied" : null,
        decision === "deny" ? messages.approval_denied! : null,
        decision === "deny" ? at : null,
        at,
        runId,
        orgId,
        at,
        decision,
        at,
      ),
      audit(orgId, null, runId, `owner_${decision}`, null, at),
    ]);
    return ownerRun(orgId, runId);
  }
  async function cancel(orgId: string, runId: string): Promise<RunView> {
    await runRow(orgId, runId);
    const at = now();
    await client.batch([
      epoch(orgId),
      statement(
        `UPDATE control_runs SET status=CASE WHEN status='running' AND (fingerprint_version='m1' OR effect_state IN ('possible','provider_idempotent')) THEN 'outcome_unknown' ELSE 'canceled' END,
        error_code=CASE WHEN status='running' AND (fingerprint_version='m1' OR effect_state IN ('possible','provider_idempotent')) THEN 'outcome_unknown' ELSE 'canceled' END,
        error_message=CASE WHEN status='running' AND (fingerprint_version='m1' OR effect_state IN ('possible','provider_idempotent')) THEN ? ELSE ? END,error_retryable=0,
        lease_owner=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE id=? AND org_id=? AND status IN ('pending_approval','queued','running')`,
        messages.outcome_unknown!,
        messages.canceled!,
        at,
        at,
        runId,
        orgId,
      ),
      statement(
        `UPDATE control_attempts SET ended_at=?,outcome=CASE WHEN EXISTS(SELECT 1 FROM control_runs r WHERE r.id=control_attempts.run_id AND r.status='outcome_unknown') THEN 'outcome_unknown' ELSE 'failed' END WHERE run_id=? AND ended_at IS NULL
        AND EXISTS(SELECT 1 FROM control_runs WHERE id=? AND org_id=? AND status IN ('outcome_unknown','canceled'))`,
        at,
        runId,
        runId,
        orgId,
      ),
      audit(orgId, null, runId, "owner_cancel", null, at),
    ]);
    return ownerRun(orgId, runId);
  }

  async function updateProfile(
    orgId: string,
    profileId: string,
    patch: ProfileUpdate,
  ): Promise<void> {
    await profile(orgId, profileId);
    if (
      Object.keys(patch).some(
        (key) =>
          ![
            "enabled",
            "toolEnabled",
            "approvalLifetimeMs",
            "dispatchPaused",
          ].includes(key),
      ) ||
      (patch.enabled !== undefined && typeof patch.enabled !== "boolean") ||
      (patch.toolEnabled !== undefined &&
        typeof patch.toolEnabled !== "boolean") ||
      (patch.dispatchPaused !== undefined &&
        typeof patch.dispatchPaused !== "boolean") ||
      (patch.approvalLifetimeMs !== undefined &&
        (!Number.isSafeInteger(patch.approvalLifetimeMs) ||
          patch.approvalLifetimeMs < 900_000 ||
          patch.approvalLifetimeMs > 86_400_000))
    ) {
      throw problem("invalid_request");
    }
    const at = now();
    const mutations = [
      epoch(orgId),
      statement(
        `UPDATE control_profiles SET enabled=coalesce(?,enabled),
      approval_lifetime_ms=coalesce(?,approval_lifetime_ms),dispatch_paused=coalesce(?,dispatch_paused),revision=revision+1,updated_at=?
      WHERE id=? AND org_id=?`,
        patch.enabled === undefined ? null : Number(patch.enabled),
        patch.approvalLifetimeMs ?? null,
        patch.dispatchPaused === undefined
          ? null
          : Number(patch.dispatchPaused),
        at,
        profileId,
        orgId,
      ),
    ];
    if (patch.toolEnabled !== undefined)
      mutations.push(
        statement(
          `UPDATE control_profile_tools SET enabled=? WHERE profile_id=?
      AND tool_id IN (SELECT id FROM control_tools WHERE org_id=? AND name=?)`,
          Number(patch.toolEnabled),
          profileId,
          orgId,
          FIXTURE,
        ),
      );
    await client.batch([
      ...mutations,
      ...restrictWaiting(orgId, at),
      audit(orgId, null, null, "profile_updated", null, at),
    ]);
  }
  async function setPolicies(
    orgId: string,
    profileId: string | null,
    rules: PolicyRule[],
  ): Promise<void> {
    if (profileId !== null) await profile(orgId, profileId);
    if (
      !Array.isArray(rules) ||
      rules.length > 1000 ||
      rules.some(
        (rule) =>
          !rule ||
          !PolicyPattern.safeParse(rule.pattern).success ||
          !["allow", "ask", "block"].includes(rule.decision) ||
          Object.keys(rule).some(
            (key) => key !== "pattern" && key !== "decision",
          ),
      )
    ) {
      throw problem("invalid_request");
    }
    const at = now();
    await client.batch([
      epoch(orgId),
      statement(
        `DELETE FROM control_policies WHERE org_id=? AND ${profileId === null ? "profile_id IS NULL" : "profile_id=?"}`,
        orgId,
        ...(profileId === null ? [] : [profileId]),
      ),
      ...rules.map((rule) =>
        statement(
          "INSERT INTO control_policies(id,org_id,profile_id,pattern,decision,created_at) VALUES(?,?,?,?,?,?)",
          crypto.randomUUID(),
          orgId,
          profileId,
          rule.pattern,
          rule.decision,
          at,
        ),
      ),
      ...restrictWaiting(orgId, at),
      audit(orgId, null, null, "policies_updated", null, at),
    ]);
  }
  async function revokeGrant(orgId: string, grantId: string): Promise<void> {
    if (
      !(await row(
        "SELECT id FROM control_grants WHERE id=? AND org_id=?",
        grantId,
        orgId,
      ))
    )
      throw problem("not_found", 404);
    const at = now();
    await client.batch([
      epoch(orgId),
      statement(
        "UPDATE control_grants SET revoked_at=coalesce(revoked_at,?) WHERE id=? AND org_id=?",
        at,
        grantId,
        orgId,
      ),
      ...restrictWaiting(orgId, at),
      audit(orgId, grantId, null, "grant_revoked", null, at),
    ]);
  }
  async function fixtureStats(
    orgId: string,
  ): Promise<{ writes: number; total: number }> {
    const stats = await row<{ writes: number; total: number }>(
      "SELECT count(*) AS writes,coalesce(sum(value),0) AS total FROM control_fixture_effects WHERE org_id=?",
      orgId,
    );
    return stats ?? { writes: 0, total: 0 };
  }

  async function finish(
    run: RunRow,
    status: "failed" | "outcome_unknown",
    code: ExecutionErrorCode,
  ): Promise<void> {
    const at = now();
    await client.batch([
      statement(
        `UPDATE control_runs SET status=?,error_code=?,error_message=?,error_retryable=0,
        lease_owner=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE id=? AND org_id=? AND status='running' AND lease_owner=?`,
        status,
        code,
        messages[code] ?? "Execution failed.",
        at,
        at,
        run.id,
        run.org_id,
        run.lease_owner,
      ),
      statement(
        `UPDATE control_attempts SET ended_at=?,outcome=? WHERE run_id=? AND lease_owner=? AND ended_at IS NULL
        AND EXISTS(SELECT 1 FROM control_runs WHERE id=? AND status=? AND finished_at=?)`,
        at,
        status,
        run.id,
        run.lease_owner,
        run.id,
        status,
        at,
      ),
      statement(
        `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
        SELECT ?,org_id,grant_id,id,'execution_finished',error_code,? FROM control_runs WHERE id=? AND status=? AND finished_at=?`,
        crypto.randomUUID(),
        at,
        run.id,
        status,
        at,
      ),
    ]);
  }

  async function executeClaim(run: RunRow): Promise<void> {
    if (run.fingerprint_version === "m2") {
      await executeIntegrationClaim(run);
      return;
    }
    const payload = await row<PayloadRow>(
      "SELECT * FROM control_run_payloads WHERE run_id=? AND org_id=?",
      run.id,
      run.org_id,
    );
    if (!payload?.request_cipher || payload.expires_at <= now()) {
      await finish(run, "failed", "content_expired");
      return;
    }
    let args: FixtureInput;
    try {
      const frozen = await protection.decrypt<{
        arguments: unknown;
        toolRevision: string;
      }>(run.org_id, run.id, "request", payload.request_cipher);
      if (
        frozen.toolRevision !== run.tool_revision ||
        run.tool_revision !== REVISION ||
        run.tool !== FIXTURE
      )
        throw new Error("Unavailable frozen revision");
      args = FixtureArguments.parse(frozen.arguments);
    } catch {
      // No effect boundary was crossed; never reconstruct executable content from the display ledger.
      await finish(run, "failed", "internal_error");
      return;
    }
    if (args.fault === "crash_after_claim") return;
    if (args.fault === "safe_before_effect" && run.attempts === 1) {
      const at = now();
      await client.batch([
        statement(
          `UPDATE control_attempts SET ended_at=?,outcome='verified_before_effect' WHERE run_id=? AND lease_owner=? AND ended_at IS NULL
          AND EXISTS(SELECT 1 FROM control_runs WHERE id=? AND status='running' AND lease_owner=?)`,
          at,
          run.id,
          run.lease_owner,
          run.id,
          run.lease_owner,
        ),
        statement(
          `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
          SELECT ?,org_id,grant_id,id,CASE WHEN lease_until>max(?,${SQL_NOW}) AND attempts<${MAX_ATTEMPTS}
            THEN 'safe_retry' ELSE 'execution_finished' END,'verified_before_effect',? FROM control_runs
          WHERE id=? AND status='running' AND lease_owner=?`,
          crypto.randomUUID(),
          at,
          at,
          run.id,
          run.lease_owner,
        ),
        statement(
          `UPDATE control_runs SET status=CASE WHEN attempts<${MAX_ATTEMPTS} AND lease_until>max(?,${SQL_NOW}) THEN 'queued' ELSE 'failed' END,
          error_code=CASE WHEN attempts<${MAX_ATTEMPTS} AND lease_until>max(?,${SQL_NOW}) THEN NULL
            WHEN lease_until<=max(?,${SQL_NOW}) THEN 'execution_timeout' ELSE 'execution_failed' END,
          error_message=CASE WHEN attempts<${MAX_ATTEMPTS} AND lease_until>max(?,${SQL_NOW}) THEN NULL
            WHEN lease_until<=max(?,${SQL_NOW}) THEN ? ELSE ? END,error_retryable=0,lease_owner=NULL,lease_until=NULL,
          finished_at=CASE WHEN attempts<${MAX_ATTEMPTS} AND lease_until>max(?,${SQL_NOW}) THEN NULL ELSE ? END,updated_at=?
          WHERE id=? AND status='running' AND lease_owner=? AND NOT EXISTS(SELECT 1 FROM control_fixture_effects WHERE run_id=?)`,
          at,
          at,
          at,
          at,
          at,
          messages.execution_timeout!,
          messages.execution_failed!,
          at,
          at,
          at,
          run.id,
          run.lease_owner,
          run.id,
        ),
      ]);
      return;
    }

    // Fixture-only transactional effect ledger. A generic uncertain write NEVER uses this to replay.
    const effectAt = now();
    if (args.fault === "after_effect") {
      try {
        await client.batch([
          statement(
            `INSERT INTO control_fixture_effects(run_id,org_id,value,created_at)
            SELECT id,org_id,?,? FROM control_runs WHERE id=? AND org_id=? AND status='running' AND lease_owner=? AND lease_until>max(?,${SQL_NOW})`,
            args.value,
            effectAt,
            run.id,
            run.org_id,
            run.lease_owner,
            effectAt,
          ),
          statement(
            `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
            SELECT ?,org_id,grant_id,id,'fixture_effect','response_lost',? FROM control_runs
            WHERE id=? AND status='running' AND lease_owner=? AND EXISTS(SELECT 1 FROM control_fixture_effects WHERE run_id=?)`,
            crypto.randomUUID(),
            effectAt,
            run.id,
            run.lease_owner,
            run.id,
          ),
        ]);
      } catch {
        // Database/connection failure after a possible commit is not proof that no effect occurred.
      }
      await finish(run, "outcome_unknown", "outcome_unknown");
      return;
    }
    let cipher: string;
    try {
      // Echo no sensitive note. Independent owner stats expose the aggregate count/delta.
      cipher = await protection.encrypt(run.org_id, run.id, "result", {
        format: "mcp",
        result: legacyBusinessResult({ incremented: args.value }),
      });
      if (new TextEncoder().encode(cipher).byteLength > MAX_REQUEST_BYTES) {
        await finish(run, "failed", "payload_too_large");
        return;
      }
    } catch {
      await finish(run, "failed", "internal_error");
      return;
    }
    const commitAt = now();
    try {
      await client.batch([
        statement(
          `INSERT INTO control_fixture_effects(run_id,org_id,value,created_at)
          SELECT id,org_id,?,? FROM control_runs WHERE id=? AND org_id=? AND status='running' AND lease_owner=? AND lease_until>max(?,${SQL_NOW})`,
          args.value,
          commitAt,
          run.id,
          run.org_id,
          run.lease_owner,
          commitAt,
        ),
        statement(
          `UPDATE control_run_payloads SET result_cipher=? WHERE run_id=? AND org_id=?
          AND EXISTS(SELECT 1 FROM control_runs WHERE id=? AND status='running' AND lease_owner=? AND lease_until>max(?,${SQL_NOW}))
          AND EXISTS(SELECT 1 FROM control_fixture_effects WHERE run_id=?)`,
          cipher,
          run.id,
          run.org_id,
          run.id,
          run.lease_owner,
          commitAt,
          run.id,
        ),
        statement(
          `UPDATE control_attempts SET ended_at=?,outcome='succeeded' WHERE run_id=? AND lease_owner=? AND ended_at IS NULL
          AND EXISTS(SELECT 1 FROM control_runs WHERE id=? AND status='running' AND lease_owner=? AND lease_until>max(?,${SQL_NOW}))
          AND EXISTS(SELECT 1 FROM control_fixture_effects WHERE run_id=?)`,
          commitAt,
          run.id,
          run.lease_owner,
          run.id,
          run.lease_owner,
          commitAt,
          run.id,
        ),
        statement(
          `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
          SELECT ?,org_id,grant_id,id,'execution_finished',NULL,? FROM control_runs
          WHERE id=? AND status='running' AND lease_owner=? AND lease_until>max(?,${SQL_NOW}) AND EXISTS(SELECT 1 FROM control_fixture_effects WHERE run_id=?)`,
          crypto.randomUUID(),
          commitAt,
          run.id,
          run.lease_owner,
          commitAt,
          run.id,
        ),
        statement(
          `UPDATE control_runs SET status='succeeded',error_code=NULL,error_message=NULL,error_retryable=0,
          lease_owner=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE id=? AND org_id=? AND status='running' AND lease_owner=? AND lease_until>max(?,${SQL_NOW})
          AND EXISTS(SELECT 1 FROM control_fixture_effects WHERE run_id=?)`,
          commitAt,
          commitAt,
          run.id,
          run.org_id,
          run.lease_owner,
          commitAt,
          run.id,
        ),
      ]);
    } catch {
      await finish(run, "outcome_unknown", "outcome_unknown");
    }
  }

  async function recover(at: number): Promise<void> {
    if (runtime)
      for (const preparing of await rows<RunRow>(
        "SELECT * FROM control_runs WHERE fingerprint_version='m2' AND admission_ready=0 AND status IN ('pending_approval','queued') ORDER BY created_at,id LIMIT 40",
      ))
        await prepareRun(preparing);
    await client.batch([
      statement(
        `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
        SELECT lower(hex(randomblob(16))),org_id,grant_id,id,'lease_recovered',CASE WHEN fingerprint_version='m2' AND effect_state NOT IN ('possible','provider_idempotent') THEN 'execution_timeout' ELSE 'outcome_unknown' END,?
        FROM control_runs WHERE status='running' AND lease_until<=max(?,${SQL_NOW})`,
        at,
        at,
      ),
      statement(
        `UPDATE control_attempts SET ended_at=?,outcome=CASE WHEN EXISTS(SELECT 1 FROM control_runs r WHERE r.id=control_attempts.run_id AND r.fingerprint_version='m2' AND r.effect_state NOT IN ('possible','provider_idempotent')) THEN 'failed' ELSE 'outcome_unknown' END WHERE ended_at IS NULL AND run_id IN
        (SELECT id FROM control_runs WHERE status='running' AND lease_until<=max(?,${SQL_NOW}))`,
        at,
        at,
      ),
      statement(
        `UPDATE control_runs SET status=CASE WHEN fingerprint_version='m2' AND effect_state NOT IN ('possible','provider_idempotent') THEN 'failed' ELSE 'outcome_unknown' END,
        error_code=CASE WHEN fingerprint_version='m2' AND effect_state NOT IN ('possible','provider_idempotent') THEN 'execution_timeout' ELSE 'outcome_unknown' END,
        error_message=CASE WHEN fingerprint_version='m2' AND effect_state NOT IN ('possible','provider_idempotent') THEN ? ELSE ? END,error_retryable=0,
        lease_owner=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE status='running' AND lease_until<=max(?,${SQL_NOW})`,
        messages.execution_timeout!,
        messages.outcome_unknown!,
        at,
        at,
        at,
      ),
      statement(
        `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
        SELECT lower(hex(randomblob(16))),org_id,grant_id,id,'safe_retry_exhausted','verified_before_effect',?
        FROM control_runs WHERE status='queued' AND started_at IS NOT NULL
          AND (attempts>=${MAX_ATTEMPTS} OR started_at+wall_timeout_ms<=max(?,${SQL_NOW}))`,
        at,
        at,
      ),
      statement(
        `UPDATE control_runs SET status='failed',
        error_code=CASE WHEN started_at+wall_timeout_ms<=max(?,${SQL_NOW}) THEN 'execution_timeout' ELSE 'execution_failed' END,
        error_message=CASE WHEN started_at+wall_timeout_ms<=max(?,${SQL_NOW}) THEN ? ELSE ? END,
        error_retryable=0,finished_at=?,updated_at=? WHERE status='queued' AND started_at IS NOT NULL
          AND (attempts>=${MAX_ATTEMPTS} OR started_at+wall_timeout_ms<=max(?,${SQL_NOW}))`,
        at,
        at,
        messages.execution_timeout!,
        messages.execution_failed!,
        at,
        at,
        at,
      ),
      statement(
        `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
        SELECT lower(hex(randomblob(16))),org_id,grant_id,id,'content_expired','content_expired',? FROM control_runs r
        WHERE status IN ('pending_approval','queued') AND (NOT EXISTS(SELECT 1 FROM control_run_payloads p WHERE p.run_id=r.id)
          OR EXISTS(SELECT 1 FROM control_run_payloads p WHERE p.run_id=r.id AND (p.expires_at<=max(?,${SQL_NOW}) OR (p.request_cipher IS NULL AND p.request_chunk_count=0))))`,
        at,
        at,
      ),
      statement(
        `UPDATE control_runs AS r SET status='failed',error_code='content_expired',error_message=?,error_retryable=0,finished_at=?,updated_at=?
        WHERE status IN ('pending_approval','queued') AND (NOT EXISTS(SELECT 1 FROM control_run_payloads p WHERE p.run_id=r.id)
          OR EXISTS(SELECT 1 FROM control_run_payloads p WHERE p.run_id=r.id AND (p.expires_at<=max(?,${SQL_NOW}) OR (p.request_cipher IS NULL AND p.request_chunk_count=0))))`,
        messages.content_expired!,
        at,
        at,
        at,
      ),
      statement(
        `UPDATE control_run_payloads SET request_cipher=NULL,result_cipher=NULL WHERE expires_at<=max(?,${SQL_NOW})`,
        at,
      ),
      statement(
        `DELETE FROM control_run_payload_chunks WHERE run_id IN(SELECT run_id FROM control_run_payloads WHERE expires_at<=max(?,${SQL_NOW}))`,
        at,
      ),
      statement(
        `DELETE FROM control_run_log_chunks WHERE expires_at<=max(?,${SQL_NOW})`,
        at,
      ),
      statement(
        `DELETE FROM control_dedup WHERE expires_at<=max(?,${SQL_NOW})`,
        at,
      ),
      statement(
        "DELETE FROM control_audit WHERE created_at<?",
        at - 90 * 24 * 60 * 60 * 1000,
      ),
    ]);
    const workspaces = await rows<{ org_id: string }>(
      "SELECT DISTINCT org_id FROM control_runs WHERE status IN ('pending_approval','queued')",
    );
    for (const workspace of workspaces)
      await client.batch(restrictWaiting(workspace.org_id, at));
  }

  async function drain(): Promise<void> {
    await recover(now());
    await runtime?.cleanup();
    // Bounded ticks permit independent schedulers without process-local execution locks.
    for (let round = 0; round < 8; round++) {
      const candidates = await rows<
        RunRow & { epoch: number }
      >(`SELECT r.*,w.epoch FROM control_runs r
        JOIN control_workspaces w ON w.org_id=r.org_id JOIN control_profiles p ON p.id=r.profile_id AND p.org_id=r.org_id
        WHERE r.status='queued' AND p.dispatch_paused=0 ORDER BY r.created_at,r.id LIMIT 40`);
      if (!candidates.length) return;
      let claimedCount = 0;
      for (const candidate of candidates) {
        const release =
          candidate.fingerprint_version === "m2"
            ? runtime?.tryAcquire(candidate.id)
            : () => {};
        if (!release) continue;
        try {
          if (candidate.fingerprint_version === "m2")
            await verifyRunAuthority(candidate);
          const at = now();
          const leaseOwner = crypto.randomUUID();
          const claims = await client.batch([
            statement(
              `UPDATE control_runs AS r SET status='running',attempts=attempts+1,lease_owner=?,
            lease_until=coalesce(started_at,max(?,${SQL_NOW}))+wall_timeout_ms,claim_epoch=?,
            started_at=coalesce(started_at,max(?,${SQL_NOW})),updated_at=max(?,${SQL_NOW}),
            error_code=NULL,error_message=NULL,error_retryable=0
            WHERE r.id=? AND r.org_id=? AND r.status='queued' AND r.admission_ready=1 AND r.attempts<?
              AND (r.started_at IS NULL OR r.started_at+r.wall_timeout_ms>max(?,${SQL_NOW}))
              AND EXISTS(SELECT 1 FROM control_workspaces WHERE org_id=r.org_id AND epoch=?)
              AND EXISTS(SELECT 1 FROM control_grants g WHERE g.id=r.grant_id AND g.org_id=r.org_id AND g.profile_id=r.profile_id
                AND ${PRINCIPAL_AUTHORITY_SQL} AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>max(?,${SQL_NOW})))
              AND EXISTS(SELECT 1 FROM control_profiles p WHERE p.id=r.profile_id AND p.org_id=r.org_id AND p.enabled=1 AND p.dispatch_paused=0)
              AND EXISTS(SELECT 1 FROM control_tools t JOIN control_profile_tools pt ON pt.tool_id=t.id
                JOIN control_tool_revisions tr ON tr.tool_id=t.id AND tr.revision=r.tool_revision
                WHERE t.id=r.tool_id AND t.org_id=r.org_id AND t.name=r.tool AND pt.profile_id=r.profile_id AND pt.enabled=1)
              AND (r.integration_id IS NULL OR (EXISTS(SELECT 1 FROM control_integrations i JOIN control_integration_revisions ir ON ir.integration_id=i.id WHERE i.id=r.integration_id AND i.org_id=r.org_id AND i.enabled=1 AND ir.id=r.integration_revision_id AND ir.available=1 AND ir.status<>'draft')
                AND NOT EXISTS(SELECT 1 FROM control_tool_availability a WHERE a.tool_id=r.tool_id AND a.revision=r.tool_revision AND a.available=0)))
              AND (r.deadline IS NULL OR (r.deadline>max(?,${SQL_NOW}) AND r.approved_revision=r.tool_revision
                AND EXISTS(SELECT 1 FROM control_approvals a WHERE a.run_id=r.id AND a.org_id=r.org_id AND a.decision='approve'
                  AND a.requested_revision=r.tool_revision AND a.deadline=r.deadline)))
              AND (${CURRENT_POLICY_SQL}='allow' OR (${CURRENT_POLICY_SQL}='ask' AND r.approved_revision=r.tool_revision))
              AND (SELECT count(*) FROM control_runs occupied WHERE occupied.org_id=r.org_id AND occupied.status='running' AND occupied.lease_until>max(?,${SQL_NOW}))<?
              AND EXISTS(SELECT 1 FROM control_run_payloads protected WHERE protected.run_id=r.id AND protected.org_id=r.org_id
                AND (protected.request_cipher IS NOT NULL OR protected.request_chunk_count>0) AND protected.expires_at>max(?,${SQL_NOW}))
            RETURNING *`,
              leaseOwner,
              at,
              candidate.epoch,
              at,
              at,
              candidate.id,
              candidate.org_id,
              MAX_ATTEMPTS,
              at,
              candidate.epoch,
              at,
              at,
              at,
              MAX_WORKSPACE_RUNNING,
              at,
            ),
            statement(
              `INSERT INTO control_attempts(id,run_id,attempt,lease_owner,started_at)
            SELECT ?,id,attempts,lease_owner,max(?,${SQL_NOW}) FROM control_runs WHERE id=? AND status='running' AND lease_owner=?`,
              crypto.randomUUID(),
              at,
              candidate.id,
              leaseOwner,
            ),
            statement(
              `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
            SELECT ?,org_id,grant_id,id,'dispatch_claim',NULL,? FROM control_runs WHERE id=? AND status='running' AND lease_owner=?`,
              crypto.randomUUID(),
              at,
              candidate.id,
              leaseOwner,
            ),
          ]);
          const claimed = claims[0]?.results[0] as unknown as
            | RunRow
            | undefined;
          if (!claimed) continue;
          claimedCount++;
          await executeClaim(claimed);
        } catch (error) {
          if (candidate.fingerprint_version !== "m2") throw error;
          await blockWaiting(
            candidate,
            error instanceof ControlError ? error.code : "internal_error",
          );
        } finally {
          release();
        }
      }
      if (!claimedCount) return;
    }
  }

  return {
    setup,
    issueGrant,
    authenticate,
    discover,
    discoveryPage,
    authorizeArtifactAccess,
    authorizeArtifactRun,
    invoke,
    getRun,
    ownerRuns,
    ownerRun,
    decide,
    cancel,
    updateProfile,
    setPolicies,
    revokeGrant,
    fixtureStats,
    drain,
  };
}
