import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./auth";
import { controlProfiles, controlRuns, controlTools } from "./control";

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
export const controlIntegrations = sqliteTable(
  "control_integrations",
  {
    id: id(),
    orgId: org(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    currentRevisionId: text("current_revision_id"),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
  },
  (t) => [uniqueIndex("control_integrations_org_slug").on(t.orgId, t.slug)],
);
/** Immutable UTF-8 snapshots use bounded rows on both SQLite and D1. */
export const controlCatalogBlobs = sqliteTable("control_catalog_blobs", {
  id: id(),
  orgId: org(),
  kind: text("kind").notNull(),
  digest: text("digest").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  createdAt: time("created_at"),
});
export const controlCatalogChunks = sqliteTable(
  "control_catalog_chunks",
  {
    blobId: text("blob_id")
      .notNull()
      .references(() => controlCatalogBlobs.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
  },
  (t) => [primaryKey({ columns: [t.blobId, t.chunkIndex] })],
);
export const controlIntegrationRevisions = sqliteTable(
  "control_integration_revisions",
  {
    id: id(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => controlIntegrations.id, { onDelete: "cascade" }),
    sourceBlobId: text("source_blob_id")
      .notNull()
      .references(() => controlCatalogBlobs.id),
    sourceDigest: text("source_digest").notNull(),
    status: text("status").notNull().default("draft"),
    available: integer("available", { mode: "boolean" })
      .notNull()
      .default(true),
    createdAt: time("created_at"),
  },
  (t) => [
    index("control_integration_revisions_parent").on(
      t.integrationId,
      t.createdAt,
    ),
  ],
);
export const controlRevisionManifests = sqliteTable(
  "control_revision_manifests",
  {
    revisionId: text("revision_id")
      .primaryKey()
      .references(() => controlIntegrationRevisions.id),
    blobId: text("blob_id")
      .notNull()
      .references(() => controlCatalogBlobs.id),
    digest: text("digest").notNull(),
  },
);
export const controlReviews = sqliteTable(
  "control_reviews",
  {
    id: id(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => controlIntegrationRevisions.id),
    reportDigest: text("report_digest").notNull(),
    reportBlobId: text("report_blob_id")
      .notNull()
      .references(() => controlCatalogBlobs.id),
    controlEpoch: integer("control_epoch").notNull(),
    expectedCurrentRevisionId: text("expected_current_revision_id"),
    createdAt: time("created_at"),
  },
  (t) => [
    index("control_reviews_revision_digest").on(t.revisionId, t.reportDigest),
  ],
);
export const controlPublications = sqliteTable("control_publications", {
  id: id(),
  orgId: org(),
  integrationId: text("integration_id")
    .notNull()
    .references(() => controlIntegrations.id),
  revisionId: text("revision_id")
    .notNull()
    .references(() => controlIntegrationRevisions.id),
  reviewId: text("review_id")
    .notNull()
    .references(() => controlReviews.id),
  createdAt: time("created_at"),
});
export const controlProfileBindings = sqliteTable(
  "control_profile_bindings",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => controlProfiles.id, { onDelete: "cascade" }),
    requirementKey: text("requirement_key").notNull(),
    accountId: text("account_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.requirementKey] })],
);
export const controlToolAvailability = sqliteTable(
  "control_tool_availability",
  {
    toolId: text("tool_id")
      .notNull()
      .references(() => controlTools.id),
    revision: text("revision").notNull(),
    available: integer("available", { mode: "boolean" })
      .notNull()
      .default(true),
    reason: text("reason"),
  },
  (t) => [primaryKey({ columns: [t.toolId, t.revision] })],
);
export const controlRunPayloadChunks = sqliteTable(
  "control_run_payload_chunks",
  {
    runId: text("run_id")
      .notNull()
      .references(() => controlRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    cipher: text("cipher").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.kind, t.chunkIndex] })],
);
export const controlRunLogChunks = sqliteTable(
  "control_run_log_chunks",
  {
    runId: text("run_id")
      .notNull()
      .references(() => controlRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    plaintextBytes: integer("plaintext_bytes").notNull(),
    cipher: text("cipher").notNull(),
    createdAt: time("created_at"),
    expiresAt: time("expires_at"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.sequence] })],
);
export const controlPublicationUpdates = sqliteTable(
  "control_publication_updates",
  {
    publicationId: text("publication_id").notNull(),
    profileId: text("profile_id").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
  },
  (t) => [primaryKey({ columns: [t.publicationId, t.profileId] })],
);
export const controlPublicationToolUpdates = sqliteTable(
  "control_publication_tool_updates",
  {
    publicationId: text("publication_id").notNull(),
    profileId: text("profile_id").notNull(),
    tool: text("tool").notNull(),
  },
  (t) => [primaryKey({ columns: [t.publicationId, t.profileId, t.tool] })],
);
export const controlPublicationBindingUpdates = sqliteTable(
  "control_publication_binding_updates",
  {
    publicationId: text("publication_id").notNull(),
    profileId: text("profile_id").notNull(),
    requirementKey: text("requirement_key").notNull(),
    accountId: text("account_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.publicationId, t.profileId, t.requirementKey] }),
  ],
);
export const controlPublicationPolicyUpdates = sqliteTable(
  "control_publication_policy_updates",
  {
    publicationId: text("publication_id").notNull(),
    profileId: text("profile_id").notNull(),
    pattern: text("pattern").notNull(),
    decision: text("decision").notNull(),
  },
  (t) => [primaryKey({ columns: [t.publicationId, t.profileId, t.pattern] })],
);
