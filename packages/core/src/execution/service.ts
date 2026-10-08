import type { D1PreparedStatement as Statement } from "@cloudflare/workers-types";
import type { Database } from "@scaffold/database";
import {
  type ExecutionErrorCode,
  ExecutionRequestMetadata,
  FixtureArguments,
  type FixtureArguments as FixtureInput,
  IDEMPOTENCY_RETENTION_MS,
  PolicyPattern,
  type RunStatus,
} from "@scaffold/schema/execution";
import { canonicalJson, sha256 } from "./canonical";
import { CURRENT_POLICY_SQL, type PolicyRule, resolvePolicy } from "./policy";
import { createPayloadProtection } from "./protection";

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
export interface ProfileUpdate {
  enabled?: boolean;
  toolEnabled?: boolean;
  approvalLifetimeMs?: number;
  dispatchPaused?: boolean;
}
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
  ): Promise<{ grantId: string; token: string; expiresAt: number | null }>;
  authenticate(profileId: string, token: string): Promise<GrantIdentity>;
  discover(grant: GrantIdentity): Promise<ToolDescriptor[]>;
  invoke(
    grant: GrantIdentity,
    input: { name: string; arguments: unknown; metadata?: unknown },
  ): Promise<RunView>;
  getRun(grant: GrantIdentity, runId: string): Promise<RunView>;
  ownerRuns(orgId: string): Promise<RunView[]>;
  ownerRun(orgId: string, runId: string): Promise<RunView>;
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
}
interface PayloadRow {
  request_cipher: string | null;
  result_cipher: string | null;
  expires_at: number;
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

// These restrictions are evaluated in SQL, inside each owner's mutation and each claim.
const RESTRICTION_SQL = `(CASE
  WHEN NOT EXISTS (SELECT 1 FROM control_profiles p WHERE p.id=r.profile_id AND p.org_id=r.org_id AND p.enabled=1) THEN 'profile_disabled'
  WHEN EXISTS (SELECT 1 FROM control_grants g WHERE g.id=r.grant_id AND g.revoked_at IS NOT NULL) THEN 'grant_revoked'
  WHEN EXISTS (SELECT 1 FROM control_grants g WHERE g.id=r.grant_id AND g.expires_at IS NOT NULL AND g.expires_at<=max(?,${SQL_NOW})) THEN 'grant_expired'
  WHEN NOT EXISTS (SELECT 1 FROM control_tools t JOIN control_profile_tools pt ON pt.tool_id=t.id
    JOIN control_tool_revisions tr ON tr.tool_id=t.id AND tr.revision=r.tool_revision
    WHERE t.id=r.tool_id AND t.org_id=r.org_id AND t.name=r.tool
      AND pt.profile_id=r.profile_id AND pt.enabled=1) THEN 'tool_unavailable'
  WHEN r.deadline IS NOT NULL AND r.deadline<=max(?,${SQL_NOW}) THEN 'approval_expired'
  WHEN ${CURRENT_POLICY_SQL}='block' THEN 'policy_blocked'
  WHEN ${CURRENT_POLICY_SQL}='ask' AND r.deadline IS NULL AND r.approved_revision IS NULL THEN 'forbidden'
  ELSE NULL END)`;

/** Shared D1/SQLite domain. batch() is the adapter's real atomic transaction boundary. */
export function createExecutionService({
  db,
  secret,
  now = Date.now,
}: {
  db: Database;
  secret: string;
  now?: () => number;
}): ExecutionService {
  const client = db.$client;
  const protection = createPayloadProtection(secret);
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
      `SELECT g.id,g.org_id,g.profile_id,g.revoked_at,g.expires_at,
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
        "SELECT request_cipher,result_cipher,expires_at FROM control_run_payloads WHERE run_id=? AND org_id=?",
        run.id,
        run.org_id,
      );
      if (
        !protectedRow ||
        protectedRow.expires_at <= now() ||
        !protectedRow.result_cipher
      ) {
        result.error = {
          code: "content_expired",
          message: messages.content_expired!,
          retryable: false,
          run_id: run.id,
        };
      } else {
        try {
          result.result = await protection.decrypt(
            run.org_id,
            run.id,
            "result",
            protectedRow.result_cipher,
          );
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
        `INSERT INTO control_grants(id,org_id,profile_id,label,token_hash,expires_at,created_at)
        SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM control_grants WHERE profile_id=? AND label=?) RETURNING id`,
        grantId,
        orgId,
        profileId,
        label.trim(),
        hash,
        expiry,
        at,
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
        ? await row<{ id: string }>(
            "SELECT id FROM control_grants WHERE profile_id=? AND token_hash=?",
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
    const identity = { id: found.id, orgId: scoped.org_id, profileId };
    await requireGrant(identity);
    return identity;
  }
  async function discover(grant: GrantIdentity) {
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
    return tool?.active_revision === REVISION
      ? [fixtureDescriptor, getDescriptor]
      : [getDescriptor];
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
          policy_decision,display_json,created_at,updated_at,deadline,admitted_epoch,error_code,error_message,error_retryable,finished_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,admitted_at,admitted_at,
          CASE WHEN ?=1 THEN admitted_at+? ELSE NULL END,?,?,?,0,
          CASE WHEN ?=1 THEN admitted_at ELSE NULL END
        FROM (SELECT max(?,${SQL_NOW}) AS admitted_at) WHERE ${absent}
          AND EXISTS(SELECT 1 FROM control_workspaces WHERE org_id=? AND epoch=?)`,
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
        ),
      );
      if (cipher !== null)
        statements.push(
          statement(
            `INSERT INTO control_run_payloads(run_id,org_id,request_cipher,expires_at)
        SELECT id,org_id,?,created_at+? FROM control_runs WHERE id=?`,
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

  async function getRun(grant: GrantIdentity, runId: string): Promise<RunView> {
    await requireGrant(grant);
    const stored = await runRow(grant.orgId, runId, grant.id);
    if (stored.profile_id !== grant.profileId) throw problem("not_found", 404);
    return view(stored);
  }
  async function ownerRuns(orgId: string): Promise<RunView[]> {
    const stored = await rows<RunRow>(
      "SELECT * FROM control_runs WHERE org_id=? ORDER BY created_at DESC,id DESC",
      orgId,
    );
    return Promise.all(stored.map((run) => view(run, true)));
  }
  async function ownerRun(orgId: string, runId: string): Promise<RunView> {
    return view(await runRow(orgId, runId), true);
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
        `UPDATE control_runs SET status=CASE WHEN status='running' THEN 'outcome_unknown' ELSE 'canceled' END,
        error_code=CASE WHEN status='running' THEN 'outcome_unknown' ELSE 'canceled' END,
        error_message=CASE WHEN status='running' THEN ? ELSE ? END,error_retryable=0,
        lease_owner=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE id=? AND org_id=? AND status IN ('pending_approval','queued','running')`,
        messages.outcome_unknown!,
        messages.canceled!,
        at,
        at,
        runId,
        orgId,
      ),
      statement(
        `UPDATE control_attempts SET ended_at=?,outcome='outcome_unknown' WHERE run_id=? AND ended_at IS NULL
        AND EXISTS(SELECT 1 FROM control_runs WHERE id=? AND org_id=? AND status='outcome_unknown')`,
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
    const payload = await row<PayloadRow>(
      "SELECT request_cipher,result_cipher,expires_at FROM control_run_payloads WHERE run_id=? AND org_id=?",
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
        incremented: args.value,
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
    await client.batch([
      statement(
        `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
        SELECT lower(hex(randomblob(16))),org_id,grant_id,id,'lease_recovered','outcome_unknown',?
        FROM control_runs WHERE status='running' AND lease_until<=max(?,${SQL_NOW})`,
        at,
        at,
      ),
      statement(
        `UPDATE control_attempts SET ended_at=?,outcome='outcome_unknown' WHERE ended_at IS NULL AND run_id IN
        (SELECT id FROM control_runs WHERE status='running' AND lease_until<=max(?,${SQL_NOW}))`,
        at,
        at,
      ),
      statement(
        `UPDATE control_runs SET status='outcome_unknown',error_code='outcome_unknown',error_message=?,error_retryable=0,
        lease_owner=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE status='running' AND lease_until<=max(?,${SQL_NOW})`,
        messages.outcome_unknown!,
        at,
        at,
        at,
      ),
      statement(
        `INSERT INTO control_audit(id,org_id,grant_id,run_id,action,reason,created_at)
        SELECT lower(hex(randomblob(16))),org_id,grant_id,id,'safe_retry_exhausted','verified_before_effect',?
        FROM control_runs WHERE status='queued' AND started_at IS NOT NULL
          AND (attempts>=${MAX_ATTEMPTS} OR started_at+${EXECUTION_LEASE_MS}<=max(?,${SQL_NOW}))`,
        at,
        at,
      ),
      statement(
        `UPDATE control_runs SET status='failed',
        error_code=CASE WHEN started_at+${EXECUTION_LEASE_MS}<=max(?,${SQL_NOW}) THEN 'execution_timeout' ELSE 'execution_failed' END,
        error_message=CASE WHEN started_at+${EXECUTION_LEASE_MS}<=max(?,${SQL_NOW}) THEN ? ELSE ? END,
        error_retryable=0,finished_at=?,updated_at=? WHERE status='queued' AND started_at IS NOT NULL
          AND (attempts>=${MAX_ATTEMPTS} OR started_at+${EXECUTION_LEASE_MS}<=max(?,${SQL_NOW}))`,
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
          OR EXISTS(SELECT 1 FROM control_run_payloads p WHERE p.run_id=r.id AND (p.expires_at<=max(?,${SQL_NOW}) OR p.request_cipher IS NULL)))`,
        at,
        at,
      ),
      statement(
        `UPDATE control_runs AS r SET status='failed',error_code='content_expired',error_message=?,error_retryable=0,finished_at=?,updated_at=?
        WHERE status IN ('pending_approval','queued') AND (NOT EXISTS(SELECT 1 FROM control_run_payloads p WHERE p.run_id=r.id)
          OR EXISTS(SELECT 1 FROM control_run_payloads p WHERE p.run_id=r.id AND (p.expires_at<=max(?,${SQL_NOW}) OR p.request_cipher IS NULL)))`,
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
        const at = now();
        const leaseOwner = crypto.randomUUID();
        const claims = await client.batch([
          statement(
            `UPDATE control_runs AS r SET status='running',attempts=attempts+1,lease_owner=?,
            lease_until=coalesce(started_at,max(?,${SQL_NOW}))+${EXECUTION_LEASE_MS},
            started_at=coalesce(started_at,max(?,${SQL_NOW})),updated_at=max(?,${SQL_NOW}),
            error_code=NULL,error_message=NULL,error_retryable=0
            WHERE r.id=? AND r.org_id=? AND r.status='queued' AND r.attempts<?
              AND (r.started_at IS NULL OR r.started_at+${EXECUTION_LEASE_MS}>max(?,${SQL_NOW}))
              AND EXISTS(SELECT 1 FROM control_workspaces WHERE org_id=r.org_id AND epoch=?)
              AND EXISTS(SELECT 1 FROM control_grants g WHERE g.id=r.grant_id AND g.org_id=r.org_id AND g.profile_id=r.profile_id
                AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>max(?,${SQL_NOW})))
              AND EXISTS(SELECT 1 FROM control_profiles p WHERE p.id=r.profile_id AND p.org_id=r.org_id AND p.enabled=1 AND p.dispatch_paused=0)
              AND EXISTS(SELECT 1 FROM control_tools t JOIN control_profile_tools pt ON pt.tool_id=t.id
                JOIN control_tool_revisions tr ON tr.tool_id=t.id AND tr.revision=r.tool_revision
                WHERE t.id=r.tool_id AND t.org_id=r.org_id AND t.name=r.tool AND pt.profile_id=r.profile_id AND pt.enabled=1)
              AND (r.deadline IS NULL OR (r.deadline>max(?,${SQL_NOW}) AND r.approved_revision=r.tool_revision
                AND EXISTS(SELECT 1 FROM control_approvals a WHERE a.run_id=r.id AND a.org_id=r.org_id AND a.decision='approve'
                  AND a.requested_revision=r.tool_revision AND a.deadline=r.deadline)))
              AND (${CURRENT_POLICY_SQL}='allow' OR (${CURRENT_POLICY_SQL}='ask' AND r.approved_revision=r.tool_revision))
              AND (SELECT count(*) FROM control_runs occupied WHERE occupied.org_id=r.org_id AND occupied.status='running' AND occupied.lease_until>max(?,${SQL_NOW}))<?
              AND EXISTS(SELECT 1 FROM control_run_payloads protected WHERE protected.run_id=r.id AND protected.org_id=r.org_id
                AND protected.request_cipher IS NOT NULL AND protected.expires_at>max(?,${SQL_NOW}))
            RETURNING *`,
            leaseOwner,
            at,
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
        const claimed = claims[0]?.results[0] as unknown as RunRow | undefined;
        if (!claimed) continue;
        claimedCount++;
        await executeClaim(claimed);
      }
      if (!claimedCount) return;
    }
  }

  return {
    setup,
    issueGrant,
    authenticate,
    discover,
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
