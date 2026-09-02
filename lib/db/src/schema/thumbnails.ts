import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { videosTable } from "./videos";

/** A tenant-scoped capability to upload exactly one candidate thumbnail object. */
export const thumbnailUploadIntentsTable = pgTable("thumbnail_upload_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  videoId: uuid("video_id").notNull().references(() => videosTable.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull(),
  declaredContentType: text("declared_content_type").notNull(),
  declaredSizeBytes: integer("declared_size_bytes").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  finalizedObjectKey: text("finalized_object_key"),
  finalizedVersion: uuid("finalized_version"),
  finalizedContentType: text("finalized_content_type"),
  finalizedSizeBytes: integer("finalized_size_bytes"),
  finalizedGeneration: text("finalized_generation"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("thumbnail_upload_intents_object_key_idx").on(table.objectKey),
  index("thumbnail_upload_intents_video_idx").on(table.organizationId, table.videoId),
  index("thumbnail_upload_intents_expiry_idx").on(table.finalizedAt, table.expiresAt),
  check("thumbnail_upload_intents_size_check", sql`${table.declaredSizeBytes} between 1 and 10485760`),
  check("thumbnail_upload_intents_type_check", sql`${table.declaredContentType} in ('image/jpeg', 'image/png', 'image/webp')`),
  check("thumbnail_upload_intents_key_check", sql`(${table.objectKey} like 'thumbnails/%' or ${table.objectKey} like 'thumbnail-candidates/%') and ${table.objectKey} not like '%..%'`),
]);

/** Durable, idempotent handoff for deleting private objects after DB commits. */
export const objectCleanupOutboxTable = pgTable("object_cleanup_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Deliberately no cascading FK: cleanup must survive organization deletion. */
  organizationId: uuid("organization_id").notNull(),
  objectKey: text("object_key").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("object_cleanup_outbox_object_key_idx").on(table.objectKey),
  index("object_cleanup_outbox_org_idx").on(table.organizationId, table.createdAt),
  index("object_cleanup_outbox_pending_idx").on(table.completedAt, table.quarantinedAt, table.nextAttemptAt),
]);