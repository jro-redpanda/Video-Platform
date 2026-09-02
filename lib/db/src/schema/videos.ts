import { boolean, check, doublePrecision, foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { providerAccountsTable } from "./operations";

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
  masterStorageKey: text("master_storage_key"),
  masterArchivedAt: timestamp("master_archived_at", { withTimezone: true }),
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
  check("videos_thumbnail_metadata_check", sql`(
    ${table.thumbnailObjectKey} is null and ${table.thumbnailContentType} is null and ${table.thumbnailSizeBytes} is null and ${table.thumbnailVersion} is null and ${table.thumbnailGeneration} is null and ${table.thumbnailMutableUntil} is null
  ) or (
    ${table.thumbnailObjectKey} is not null
    and ${table.thumbnailContentType} in ('image/jpeg', 'image/png', 'image/webp')
    and ${table.thumbnailSizeBytes} between 1 and 10485760
    and ${table.thumbnailVersion} is not null
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
  day: text("day").notNull(),
  plays: integer("plays").notNull().default(0),
  watchTimeSeconds: integer("watch_time_seconds").notNull().default(0),
  completionRate: doublePrecision("completion_rate").notNull().default(0),
}, (table) => [uniqueIndex("video_rollups_video_day_idx").on(table.videoId, table.day)]);

export const playbackEventsTable = pgTable("playback_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  videoId: uuid("video_id").notNull().references(() => videosTable.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull(),
  eventType: text("event_type").notNull(),
  positionSeconds: doublePrecision("position_seconds").notNull().default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("playback_events_org_time_idx").on(table.organizationId, table.occurredAt)]);