-- Fresh D1 schema for the current application. Applied by Wrangler, never at startup.
-- IDs have no SQL default: application/Better Auth inserts generate crypto.randomUUID().
-- Date columns are epoch milliseconds, mapped to Date by Drizzle timestamp_ms.

CREATE TABLE "users" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" integer DEFAULT 0 NOT NULL,
  "image" text,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
  "updated_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
CREATE UNIQUE INDEX "users_email_unique" ON "users" ("email");

CREATE TABLE "organizations" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "logo" text,
  "metadata" text,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" ("slug");

CREATE TABLE "sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "expires_at" integer NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "active_organization_id" text,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
  "updated_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
CREATE UNIQUE INDEX "sessions_token_unique" ON "sessions" ("token");

CREATE TABLE "accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" integer,
  "refresh_token_expires_at" integer,
  "scope" text,
  "password" text,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
  "updated_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);

CREATE TABLE "verifications" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" integer NOT NULL,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
  "updated_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);

CREATE TABLE "members" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "role" text DEFAULT 'member' NOT NULL,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);

CREATE TABLE "invitations" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "inviter_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "expires_at" integer NOT NULL,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);

CREATE TABLE "feature_flags" (
  "id" text PRIMARY KEY NOT NULL,
  "key" text NOT NULL,
  "enabled" integer DEFAULT 0 NOT NULL,
  "rollout_pct" integer DEFAULT 100 NOT NULL,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
CREATE UNIQUE INDEX "feature_flags_key_unique" ON "feature_flags" ("key");
