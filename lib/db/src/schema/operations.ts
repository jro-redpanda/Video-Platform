import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./identity";

export const providerAccountsTable = pgTable("provider_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerKey: text("provider_key").notNull(),
  label: text("label").notNull(),
  externalAccountId: text("external_account_id"),
  encryptedCredentials: text("encrypted_credentials").notNull(),
  zoneCountCached: integer("zone_count_cached").notNull().default(0),
  maxZones: integer("max_zones").notNull(),
  acceptingNewTenants: boolean("accepting_new_tenants").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("provider_accounts_capacity_idx").on(table.providerKey, table.acceptingNewTenants)]);

export const providerTenantSpaceStateEnum = pgEnum("provider_tenant_space_state", ["creating", "created"]);

export const providerTenantSpacesTable = pgTable("provider_tenant_spaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  providerAccountId: uuid("provider_account_id").notNull().references(() => providerAccountsTable.id),
  providerSpaceId: text("provider_space_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  encryptedCredentials: text("encrypted_credentials"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  externalCallClaim: uuid("external_call_claim"),
  externalCallClaimedAt: timestamp("external_call_claimed_at", { withTimezone: true }),
  reconciliationRequired: boolean("reconciliation_required").notNull().default(false),
  state: providerTenantSpaceStateEnum("state").notNull().default("creating"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("provider_tenant_spaces_org_idx").on(table.organizationId),
  uniqueIndex("provider_tenant_spaces_provider_space_idx").on(table.providerAccountId, table.providerSpaceId),
]);

export const organizationEntitlementOverridesTable = pgTable("organization_entitlement_overrides", {
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: jsonb("value").$type<boolean | number | string>().notNull(),
}, (table) => [uniqueIndex("entitlement_overrides_org_key_idx").on(table.organizationId, table.key)]);

export const webhookEventsTable = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerKey: text("provider_key").notNull(),
  receiptDigest: text("receipt_digest").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  providerAccountId: uuid("provider_account_id").references(() => providerAccountsTable.id),
  providerTenantSpaceId: text("provider_tenant_space_id"),
  providerAssetId: text("provider_asset_id"),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  ownedVideoId: uuid("owned_video_id"),
  verificationState: text("verification_state").notNull(),
  processingState: text("processing_state").notNull(),
  diagnosticCode: text("diagnostic_code"),
  /** Legacy compatibility columns; payload is always an empty safe object in Step 10. */
  signatureValid: boolean("signature_valid").notNull(),
  payload: jsonb("payload").$type<Record<string, never>>().notNull().default({}),
  error: text("error"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  embedEnqueuedAt: timestamp("embed_enqueued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("webhook_events_provider_digest_idx").on(table.providerKey, table.receiptDigest),
  index("webhook_events_reconciliation_idx").on(table.processingState, table.createdAt),
]);

/** Transactional handoff to the future embed worker; payload never contains provider identifiers. */
export const embedGenerationOutboxTable = pgTable("embed_generation_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  webhookEventId: uuid("webhook_event_id").notNull().references(() => webhookEventsTable.id, { onDelete: "cascade" }),
  videoId: uuid("video_id").notNull(),
  state: text("state").notNull().default("pending"),
  dispatchClaim: uuid("dispatch_claim"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  diagnosticCode: text("diagnostic_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("embed_generation_outbox_receipt_video_idx").on(table.webhookEventId, table.videoId),
  index("embed_generation_outbox_pending_idx").on(table.state, table.createdAt),
]);

export const auditLogsTable = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  actorUserId: uuid("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  actorKind: text("actor_kind").notNull().default("user").$type<"user" | "system" | "webhook" | "job">(),
  action: text("action").notNull(),
  category: text("category").notNull().default("general"),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id"),
  subjectLabel: text("subject_label").notNull(),
  beforeState: jsonb("before_state").$type<Record<string, unknown> | null>(),
  afterState: jsonb("after_state").$type<Record<string, unknown> | null>(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  requestId: text("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("audit_logs_org_time_idx").on(table.organizationId, table.createdAt, table.id),
  index("audit_logs_org_category_time_idx").on(table.organizationId, table.category, table.createdAt, table.id),
  index("audit_logs_org_subject_time_idx").on(table.organizationId, table.subjectType, table.subjectId, table.createdAt, table.id),
  index("audit_logs_org_actor_time_idx").on(table.organizationId, table.actorKind, table.actorUserId, table.createdAt, table.id),
]);