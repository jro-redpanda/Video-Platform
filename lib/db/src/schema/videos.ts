import { bigint, boolean, check, date, doublePrecision, foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { providerAccountsTable } from "./operations";
import { usersTable } from "./identity";

export const videoStatusEnum = pgEnum("video_status", ["created", "uploading", "processing", "ready", "error"]);
export const videoVisibilityEnum = pgEnum("video_visibility", ["private", "unlisted", "public"]);

export const foldersTable = pgTable("folders", {
  id: uuid("id").notNull().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  primaryKey({ name: "folders_org_id_pk", columns: [table.organizationId, table.id] }),
  uniqueIndex("folders_org_root_name_ci_idx")
    .on(table.organizationId, sql`lower(${table.name})`)
    .where(sql`${table.parentId} is null`),
  uniqueIndex("folders_org_parent_name_ci_idx")
    .on(table.organizationId, table.parentId, sql`lower(${table.name})`)
    .where(sql`${table.parentId} is not null`),
  index("folders_org_idx").on(table.organizationId),
  index("folders_org_parent_idx").on(table.organizationId, table.parentId),
  foreignKey({
    name: "folders_org_parent_fk",
    columns: [table.organizationId, table.parentId],
    foreignColumns: [table.organizationId, table.id],
  }).onDelete("restrict"),
  check("folders_not_self_parent_check", sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`),
  check("folders_name_normalized_check", sql`${table.name} = btrim(${table.name}) and char_length(${table.name}) between 1 and 120`),
]);

export const videosTable = pgTable("videos", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  folderId: uuid("folder_id"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: videoStatusEnum("status").notNull().default("created"),
  visibility: videoVisibilityEnum("visibility").notNull().default("private"),
  durationSeconds: integer("duration_seconds").notNull().default(0),
  thumbnailColor: text("thumbnail_color").notNull().default("#5B5BD6"),
  /** Private App Storage linkage. Never project this key in an API response. */
  thumbnailObjectKey: text("thumbnail_object_key"),
  thumbnailContentType: text("thumbnail_content_type"),
  thumbnailSizeBytes: integer("thumbnail_size_bytes"),
  thumbnailVersion: uuid("thumbnail_version"),
  thumbnailGeneration: text("thumbnail_generation"),
  /** Legacy signed-key safety horizon; null for immutable promoted finals. */
  thumbnailMutableUntil: timestamp("thumbnail_mutable_until", { withTimezone: true }),
  /** Legacy pre-adapter linkage retained for non-destructive migration only. */
  legacyProviderKey: text("provider_key"),
  legacyProviderVideoId: text("provider_video_id"),
  /** Private control-plane linkage. Never project these columns in public APIs. */
  providerAccountId: uuid("provider_account_id").references(() => providerAccountsTable.id),
  providerTenantSpaceId: text("provider_tenant_space_id"),
  providerAssetId: text("provider_asset_id"),
  uploadIdempotencyKey: text("upload_idempotency_key"),
  uploadFailureDetail: text("upload_failure_detail"),
  uploadSourceBytes: integer("upload_source_bytes"),
  uploadSourceFileName: text("upload_source_file_name"),
  uploadSourceContentType: text("upload_source_content_type"),
  reservedBytes: integer("reserved_bytes").notNull().default(0),
  quotaReleasedAt: timestamp("quota_released_at", { withTimezone: true }),
  reservationExpiresAt: timestamp("reservation_expires_at", { withTimezone: true }),
  assetCreationClaim: uuid("asset_creation_claim"),
  assetCreationClaimedAt: timestamp("asset_creation_claimed_at", { withTimezone: true }),
  /** Durable claim preventing retries of an ambiguously completed provider deletion. */
  deletionClaim: uuid("deletion_claim"),
  deletionClaimedAt: timestamp("deletion_claimed_at", { withTimezone: true }),
  reconciliationRequired: text("reconciliation_required"),
  /** Set only for safe-to-repeat initialization failures; terminal flows clear it. */
  initializationRetryable: boolean("initialization_retryable").notNull().default(false),
  /** Private immutable verified archive metadata. Legacy key/time-only rows are unverified. */
  masterStorageKey: text("master_storage_key"),
  masterArchivedAt: timestamp("master_archived_at", { withTimezone: true }),
  masterSha256: text("master_sha256"),
  masterSizeBytes: bigint("master_size_bytes", { mode: "number" }),
  masterContentType: text("master_content_type"),
  tags: text("tags").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("videos_org_created_idx").on(table.organizationId, table.createdAt),
  index("videos_org_status_idx").on(table.organizationId, table.status),
  index("videos_org_folder_idx").on(table.organizationId, table.folderId),
  foreignKey({
    name: "videos_org_folder_fk",
    columns: [table.organizationId, table.folderId],
    foreignColumns: [foldersTable.organizationId, foldersTable.id],
  }).onDelete("restrict"),
  uniqueIndex("videos_org_upload_idempotency_idx").on(table.organizationId, table.uploadIdempotencyKey),
  uniqueIndex("videos_private_provider_asset_idx").on(
    table.providerAccountId,
    table.providerTenantSpaceId,
    table.providerAssetId,
  ),
  uniqueIndex("videos_id_organization_identity_idx").on(table.id, table.organizationId),
  check("videos_thumbnail_metadata_check", sql`(
    ${table.thumbnailObjectKey} is null and ${table.thumbnailContentType} is null and ${table.thumbnailSizeBytes} is null and ${table.thumbnailVersion} is null and ${table.thumbnailGeneration} is null and ${table.thumbnailMutableUntil} is null
  ) or (
    ${table.thumbnailObjectKey} is not null
    and ${table.thumbnailContentType} in ('image/jpeg', 'image/png', 'image/webp')
    and ${table.thumbnailSizeBytes} between 1 and 10485760
    and ${table.thumbnailVersion} is not null
  )`),
  check("videos_master_archive_metadata_check", sql`(
    ${table.masterStorageKey} is null and ${table.masterArchivedAt} is null and ${table.masterSha256} is null and ${table.masterSizeBytes} is null and ${table.masterContentType} is null
  ) or (
    ${table.masterStorageKey} is not null and ${table.masterArchivedAt} is not null and ${table.masterSha256} is null and ${table.masterSizeBytes} is null and ${table.masterContentType} is null
  ) or (
    ${table.masterStorageKey} is not null and ${table.masterArchivedAt} is not null
    and ${table.masterSha256} ~ '^[a-f0-9]{64}$'
    and ${table.masterSizeBytes} between 1 and 9223372036854775807
    and ${table.masterContentType} = btrim(${table.masterContentType})
    and char_length(${table.masterContentType}) between 1 and 255
    and ${table.masterContentType} !~ '[[:cntrl:]]'
  )`),
]);

/** Private durable ledger for master archive/restore work. Never project snapshots or storage keys. */
export const masterStorageOperationStateEnum = pgEnum("master_storage_operation_state", [
  "pending", "dispatching", "queued", "processing", "completed", "failed", "reconciliation_required", "cancelled",
]);
export const masterStorageOperationKindEnum = pgEnum("master_storage_operation_kind", ["archive", "restore"]);
export const masterStorageOperationsTable = pgTable("master_storage_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  videoId: uuid("video_id").notNull().references(() => videosTable.id, { onDelete: "cascade" }),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  operation: masterStorageOperationKindEnum("operation").notNull(),
  state: masterStorageOperationStateEnum("state").notNull().default("pending"),
  idempotencyKey: text("idempotency_key").notNull(),
  providerAccountId: uuid("provider_account_id").notNull(),
  providerTenantSpaceId: text("provider_tenant_space_id").notNull(),
  providerAssetId: text("provider_asset_id").notNull(),
  /** Private snapshot; populated for restore and never exposed in API/audit. */
  restoreStorageKey: text("restore_storage_key"),
  restoreSha256: text("restore_sha256"),
  restoreSizeBytes: bigint("restore_size_bytes", { mode: "number" }),
  restoreContentType: text("restore_content_type"),
  dispatchGeneration: integer("dispatch_generation").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  claimToken: uuid("claim_token"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  retryAfterAt: timestamp("retry_after_at", { withTimezone: true }),
  retryable: boolean("retryable").notNull().default(true),
  diagnosticCode: text("diagnostic_code"),
  resultMetadata: jsonb("result_metadata").$type<Record<string, unknown>>().notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("master_storage_operations_idempotency_idx").on(table.idempotencyKey),
  uniqueIndex("master_storage_operations_one_active_video_idx").on(table.videoId)
    .where(sql`${table.state} in ('pending','dispatching','queued','processing')`),
  index("master_storage_operations_dispatch_idx").on(table.state, table.retryAfterAt, table.createdAt),
  index("master_storage_operations_org_video_idx").on(table.organizationId, table.videoId, table.createdAt),
  foreignKey({
    name: "master_storage_operations_video_organization_fk",
    columns: [table.videoId, table.organizationId],
    foreignColumns: [videosTable.id, videosTable.organizationId],
  }).onDelete("cascade"),
  check("master_storage_operations_attempts_check", sql`${table.attempts} between 0 and 8`),
  check("master_storage_operations_restore_snapshot_check", sql`(
    ${table.operation} = 'archive'
    and ${table.restoreStorageKey} is null and ${table.restoreSha256} is null and ${table.restoreSizeBytes} is null and ${table.restoreContentType} is null
  ) or (
    ${table.operation} = 'restore'
    and ${table.restoreStorageKey} is not null
    and ${table.restoreSha256} ~ '^[a-f0-9]{64}$'
    and ${table.restoreSizeBytes} between 1 and 9223372036854775807
    and ${table.restoreContentType} = btrim(${table.restoreContentType})
    and char_length(${table.restoreContentType}) between 1 and 255
    and ${table.restoreContentType} !~ '[[:cntrl:]]'
  )`),
]);

export type VideoEmbedMetadata = {
  title: string;
  description: string;
  durationSeconds: number;
};

/** Durable provider-neutral embed generation state. Never stores playback URLs or provider linkage. */
export const videoEmbedsTable = pgTable("video_embeds", {
  videoId: uuid("video_id").primaryKey().references(() => videosTable.id, { onDelete: "cascade" }),
  embedPath: text("embed_path").notNull(),
  generationVersion: integer("generation_version").notNull(),
  generationStatus: text("generation_status").notNull(),
  generatedMetadata: jsonb("generated_metadata").$type<VideoEmbedMetadata>().notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const videoAnalyticsRollupsTable = pgTable("video_analytics_rollups", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  videoId: uuid("video_id").notNull().references(() => videosTable.id, { onDelete: "cascade" }),
  day: date("day", { mode: "string" }).notNull(),
  plays: integer("plays").notNull().default(0),
  uniqueSessions: integer("unique_sessions").notNull().default(0),
  watchTimeSeconds: integer("watch_time_seconds").notNull().default(0),
  completions: integer("completions").notNull().default(0),
  completionRate: doublePrecision("completion_rate").notNull().default(0),
}, (table) => [
  uniqueIndex("video_rollups_org_video_day_idx").on(table.organizationId, table.videoId, table.day),
  index("video_rollups_org_day_idx").on(table.organizationId, table.day),
]);

export const playbackEventsTable = pgTable("playback_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  videoId: uuid("video_id").notNull().references(() => videosTable.id, { onDelete: "cascade" }),
  embedId: uuid("embed_id").notNull().references(() => videoEmbedsTable.videoId, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull(),
  eventType: text("event_type").notNull(),
  positionSeconds: doublePrecision("position_seconds").notNull().default(0),
  durationSeconds: doublePrecision("duration_seconds"),
  errorCategory: text("error_category"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("playback_events_org_event_idx").on(table.organizationId, table.eventId),
  index("playback_events_org_time_idx").on(table.organizationId, table.occurredAt),
  index("playback_events_org_video_session_idx").on(table.organizationId, table.videoId, table.sessionId, table.occurredAt, table.eventId),
  index("playback_events_retention_idx").on(table.receivedAt),
]);

export const analyticsDirtyDaysTable = pgTable("analytics_dirty_days", {
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  videoId: uuid("video_id").notNull().references(() => videosTable.id, { onDelete: "cascade" }),
  day: date("day", { mode: "string" }).notNull(),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.videoId, table.day] }),
  index("analytics_dirty_days_available_idx").on(table.availableAt, table.claimedAt),
]);

export const analyticsRateWindowsTable = pgTable("analytics_rate_windows", {
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  dimensionType: text("dimension_type").notNull(),
  dimensionHash: text("dimension_hash").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  requestCount: integer("request_count").notNull().default(0),
  eventCount: integer("event_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.dimensionType, table.dimensionHash, table.windowStartedAt] }),
  index("analytics_rate_windows_expiry_idx").on(table.expiresAt),
]);

/** Server-receipt attestation; never stores a grant, IP address, or provider identity. */
export const analyticsPlaybackSessionsTable = pgTable("analytics_playback_sessions", {
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  videoId: uuid("video_id").notNull().references(() => videosTable.id, { onDelete: "cascade" }),
  embedId: uuid("embed_id").notNull().references(() => videoEmbedsTable.videoId, { onDelete: "cascade" }),
  clientSessionId: uuid("client_session_id").notNull(),
  grantJtiHash: text("grant_jti_hash").notNull(),
  firstReceivedAt: timestamp("first_received_at", { withTimezone: true }).notNull(),
  loadOccurredAt: timestamp("load_occurred_at", { withTimezone: true }).notNull(),
  lastReceivedAt: timestamp("last_received_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.videoId, table.clientSessionId] }),
  uniqueIndex("analytics_playback_sessions_org_jti_idx").on(table.organizationId, table.grantJtiHash),
  index("analytics_playback_sessions_expiry_idx").on(table.expiresAt),
  index("analytics_playback_sessions_org_video_idx").on(table.organizationId, table.videoId, table.clientSessionId),
]);