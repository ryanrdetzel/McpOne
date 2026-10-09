import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./auth";
import { controlRuns } from "./control";

export const controlAccounts = sqliteTable(
  "control_accounts",
  {
    id: text("id").primaryKey().notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id"),
    ownership: text("ownership").notNull(),
    provider: text("provider").notNull(),
    method: text("method").notNull(),
    identityJson: text("identity_json").notNull(),
    identityDigest: text("identity_digest").notNull(),
    scopesJson: text("scopes_json").notNull(),
    alias: text("alias").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    health: text("health").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    credentialVersion: integer("credential_version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("control_accounts_org").on(t.orgId, t.createdAt)],
);
export const controlCredentials = sqliteTable("control_credentials", {
  accountId: text("account_id")
    .primaryKey()
    .notNull()
    .references(() => controlAccounts.id, { onDelete: "cascade" }),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  cipher: text("cipher").notNull(),
  refreshLeaseId: text("refresh_lease_id"),
  refreshLeaseUntil: integer("refresh_lease_until", { mode: "timestamp_ms" }),
  refreshUnusable: integer("refresh_unusable", { mode: "boolean" })
    .notNull()
    .default(false),
});
export const controlRunAccounts = sqliteTable(
  "control_run_accounts",
  {
    runId: text("run_id")
      .notNull()
      .references(() => controlRuns.id, { onDelete: "cascade" }),
    requirement: text("requirement").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => controlAccounts.id),
    identityDigest: text("identity_digest").notNull(),
    alias: text("alias").notNull(),
    requirementJson: text("requirement_json").notNull().default("{}"),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.requirement] }),
    index("control_run_accounts_account").on(t.accountId, t.runId),
  ],
);
export const controlOAuthStates = sqliteTable(
  "control_oauth_states",
  {
    stateDigest: text("state_digest").primaryKey().notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    sessionDigest: text("session_digest").notNull(),
    provider: text("provider").notNull(),
    registrationId: text("registration_id").notNull(),
    intentCipher: text("intent_cipher").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("control_oauth_state_expiry").on(t.expiresAt)],
);
