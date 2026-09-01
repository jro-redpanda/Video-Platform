import { doublePrecision, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const videoStatusEnum = pgEnum("video_status", ["created", "uploading", "processing", "ready", "error"]);
export const videoVisibilityEnum = pgEnum("video_visibility", ["private", "unlisted", "public"]);

export const foldersTable = pgTable("folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("folders_org_parent_name_idx").on(table.organizationId, table.parentId, table.name),
  index("folders_org_idx").on(table.organizationId),
]);

export const videosTable = pgTable("videos", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  folderId: uuid("folder_id").references(() => foldersTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: videoStatusEnum("status").notNull().default("created"),
  visibility: videoVisibilityEnum("visibility").notNull().default("private"),
  durationSeconds: integer("duration_seconds").notNull().default(0),
  thumbnailColor: text("thumbnail_color").notNull().default("#5B5BD6"),
  providerKey: text("provider_key"),
  providerVideoId: text("provider_video_id"),
  masterStorageKey: text("master_storage_key"),
  masterArchivedAt: timestamp("master_archived_at", { withTimezone: true }),
  tags: text("tags").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("videos_org_created_idx").on(table.organizationId, table.createdAt),
  index("videos_org_status_idx").on(table.organizationId, table.status),
]);

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