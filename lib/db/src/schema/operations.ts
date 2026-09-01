import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./identity";

export const providerAccountsTable = pgTable("provider_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
  providerKey: text("provider_key").notNull(),
  externalAccountId: text("external_account_id"),
  encryptedCredentials: text("encrypted_credentials"),
  capacityTier: text("capacity_tier").notNull().default("dedicated"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("provider_accounts_org_idx").on(table.organizationId)]);

export const organizationEntitlementOverridesTable = pgTable("organization_entitlement_overrides", {
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: jsonb("value").$type<boolean | number | string>().notNull(),
}, (table) => [uniqueIndex("entitlement_overrides_org_key_idx").on(table.organizationId, table.key)]);

export const webhookEventsTable = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerKey: text("provider_key").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  signatureValid: boolean("signature_valid").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("webhook_events_provider_event_idx").on(table.providerKey, table.providerEventId)]);

export const auditLogsTable = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  actorUserId: uuid("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id"),
  subjectLabel: text("subject_label").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("audit_logs_org_time_idx").on(table.organizationId, table.createdAt)]);