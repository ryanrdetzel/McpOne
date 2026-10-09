import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./auth";
import { controlGrants, controlProfiles, controlRuns } from "./control";

/** Ready manifests remain as authenticated audit metadata after content cleanup. */
export const controlArtifacts = sqliteTable(
  "control_artifacts",
  {
    id: text("id").primaryKey().notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    grantId: text("grant_id")
      .notNull()
      .references(() => controlGrants.id),
    profileId: text("profile_id")
      .notNull()
      .references(() => controlProfiles.id),
    ownerUserId: text("owner_user_id"),
    runId: text("run_id").references(() => controlRuns.id),
    state: text("state", { enum: ["staging", "ready"] }).notNull(),
    format: text("format").notNull(),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
    stagingExpiresAt: integer("staging_expires_at").notNull(),
    expiresAt: integer("expires_at"),
    sizeBytes: integer("size_bytes"),
    chunkCount: integer("chunk_count"),
    sha256: text("sha256"),
    metadataCipher: text("metadata_cipher"),
    metadataDigest: text("metadata_digest"),
    contentDeletedAt: integer("content_deleted_at"),
    cleanupCheckedAt: integer("cleanup_checked_at"),
  },
  (t) => [
    index("control_artifacts_scope").on(t.orgId, t.grantId, t.profileId, t.id),
    index("control_artifacts_cleanup").on(
      t.state,
      t.stagingExpiresAt,
      t.expiresAt,
    ),
    index("control_artifacts_run").on(t.orgId, t.runId),
  ],
);

/** Ciphertext BLOB rows contain one nonce, at most 512 KiB plaintext, and one GCM tag. */
export const controlArtifactChunks = sqliteTable(
  "control_artifact_chunks",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => controlArtifacts.id),
    chunkIndex: integer("chunk_index").notNull(),
    plaintextBytes: integer("plaintext_bytes").notNull(),
    declaredSize: integer("declared_size").notNull(),
    ciphertext: blob("ciphertext", { mode: "buffer" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.chunkIndex] })],
);

/** A checked active Run may retain an input only through its existing immutable deadline. */
export const controlArtifactInputs = sqliteTable(
  "control_artifact_inputs",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => controlArtifacts.id),
    runId: text("run_id")
      .notNull()
      .references(() => controlRuns.id),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    grantId: text("grant_id")
      .notNull()
      .references(() => controlGrants.id),
    profileId: text("profile_id")
      .notNull()
      .references(() => controlProfiles.id),
    deadline: integer("deadline").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.runId] }),
    index("control_artifact_inputs_deadline").on(t.deadline, t.artifactId),
  ],
);

/** Immutable authenticated file-reference/digest/target set frozen with the durable Run. */
export const controlArtifactRunInputs = sqliteTable(
  "control_artifact_run_inputs",
  {
    runId: text("run_id")
      .primaryKey()
      .notNull()
      .references(() => controlRuns.id),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    grantId: text("grant_id")
      .notNull()
      .references(() => controlGrants.id),
    profileId: text("profile_id")
      .notNull()
      .references(() => controlProfiles.id),
    refsCipher: text("refs_cipher").notNull(),
    refsDigest: text("refs_digest").notNull(),
    createdAt: integer("created_at").notNull(),
  },
);
