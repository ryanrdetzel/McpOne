import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./auth";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const org = () =>
  text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });
const time = (name: string) =>
  integer(name, { mode: "timestamp_ms" }).notNull();

/** Every authority mutation and dispatch claim is fenced by this workspace epoch. */
export const controlWorkspaces = sqliteTable("control_workspaces", {
  orgId: org().primaryKey(),
  epoch: integer("epoch").notNull().default(0),
  createdAt: time("created_at"),
});
export const controlTools = sqliteTable(
  "control_tools",
  {
    id: id(),
    orgId: org(),
    name: text("name").notNull(),
    activeRevision: text("active_revision").notNull(),
    createdAt: time("created_at"),
  },
  (t) => [uniqueIndex("control_tools_org_name").on(t.orgId, t.name)],
);
export const controlToolRevisions = sqliteTable(
  "control_tool_revisions",
  {
    id: id(),
    toolId: text("tool_id")
      .notNull()
      .references(() => controlTools.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    inputSchema: text("input_schema").notNull(),
    createdAt: time("created_at"),
  },
  (t) => [
    uniqueIndex("control_tool_revisions_version").on(t.toolId, t.revision),
  ],
);
export const controlProfiles = sqliteTable(
  "control_profiles",
  {
    id: id(),
    orgId: org(),
    label: text("label").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    approvalLifetimeMs: integer("approval_lifetime_ms")
      .notNull()
      .default(10800000),
    dispatchPaused: integer("dispatch_paused", { mode: "boolean" })
      .notNull()
      .default(false),
    revision: integer("revision").notNull().default(1),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
  },
  (t) => [uniqueIndex("control_profiles_org_label").on(t.orgId, t.label)],
);
export const controlProfileTools = sqliteTable(
  "control_profile_tools",
  {
    id: id(),
    profileId: text("profile_id")
      .notNull()
      .references(() => controlProfiles.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => controlTools.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    uniqueIndex("control_profile_tools_membership").on(t.profileId, t.toolId),
  ],
);
export const controlGrants = sqliteTable(
  "control_grants",
  {
    id: id(),
    orgId: org(),
    profileId: text("profile_id")
      .notNull()
      .references(() => controlProfiles.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: time("created_at"),
  },
  (t) => [uniqueIndex("control_grants_profile_label").on(t.profileId, t.label)],
);
export const controlPolicies = sqliteTable(
  "control_policies",
  {
    id: id(),
    orgId: org(),
    profileId: text("profile_id").references(() => controlProfiles.id, {
      onDelete: "cascade",
    }),
    pattern: text("pattern").notNull(),
    decision: text("decision").notNull(),
    createdAt: time("created_at"),
  },
  (t) => [index("control_policies_layer").on(t.orgId, t.profileId)],
);

/** Display-safe Run ledger. Protected executable arguments and results live elsewhere. */
export const controlRuns = sqliteTable(
  "control_runs",
  {
    id: id(),
    orgId: org(),
    grantId: text("grant_id")
      .notNull()
      .references(() => controlGrants.id),
    profileId: text("profile_id")
      .notNull()
      .references(() => controlProfiles.id),
    tool: text("tool").notNull(),
    toolId: text("tool_id"),
    toolRevision: text("tool_revision").notNull(),
    status: text("status").notNull(),
    fingerprint: text("fingerprint"),
    traceId: text("trace_id"),
    policyDecision: text("policy_decision").notNull(),
    displayJson: text("display_json").notNull(),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
    deadline: integer("deadline", { mode: "timestamp_ms" }),
    admittedEpoch: integer("admitted_epoch").notNull(),
    approvedRevision: text("approved_revision"),
    attempts: integer("attempts").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorRetryable: integer("error_retryable", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [
    index("control_runs_queue").on(t.status, t.createdAt),
    index("control_runs_org").on(t.orgId, t.createdAt),
  ],
);
export const controlRunPayloads = sqliteTable("control_run_payloads", {
  runId: text("run_id")
    .primaryKey()
    .references(() => controlRuns.id, { onDelete: "cascade" }),
  orgId: org(),
  requestCipher: text("request_cipher"),
  resultCipher: text("result_cipher"),
  expiresAt: time("expires_at"),
});
export const controlApprovals = sqliteTable("control_approvals", {
  id: id(),
  orgId: org(),
  runId: text("run_id")
    .notNull()
    .unique()
    .references(() => controlRuns.id, { onDelete: "cascade" }),
  requestedRevision: text("requested_revision").notNull(),
  deadline: time("deadline"),
  decision: text("decision"),
  createdAt: time("created_at"),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
});
export const controlDedup = sqliteTable(
  "control_dedup",
  {
    id: id(),
    orgId: org(),
    grantId: text("grant_id")
      .notNull()
      .references(() => controlGrants.id),
    profileId: text("profile_id")
      .notNull()
      .references(() => controlProfiles.id),
    tool: text("tool").notNull(),
    callerKey: text("caller_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => controlRuns.id),
    expiresAt: time("expires_at"),
  },
  (t) => [
    uniqueIndex("control_dedup_scope").on(
      t.orgId,
      t.grantId,
      t.profileId,
      t.tool,
      t.callerKey,
    ),
  ],
);
export const controlAudit = sqliteTable(
  "control_audit",
  {
    id: id(),
    orgId: org(),
    grantId: text("grant_id"),
    runId: text("run_id"),
    action: text("action").notNull(),
    reason: text("reason"),
    createdAt: time("created_at"),
  },
  (t) => [index("control_audit_run").on(t.runId, t.createdAt)],
);
export const controlAttempts = sqliteTable(
  "control_attempts",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => controlRuns.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    leaseOwner: text("lease_owner").notNull(),
    startedAt: time("started_at"),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    outcome: text("outcome"),
  },
  (t) => [uniqueIndex("control_attempts_run_number").on(t.runId, t.attempt)],
);
/** Unique effect ledger is fixture instrumentation, never generic uncertain-write recovery. */
export const controlFixtureEffects = sqliteTable("control_fixture_effects", {
  runId: text("run_id")
    .primaryKey()
    .references(() => controlRuns.id),
  orgId: org(),
  value: integer("value").notNull(),
  createdAt: time("created_at"),
});
