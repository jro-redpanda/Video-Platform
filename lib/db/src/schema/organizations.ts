import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const organizationStatusEnum = pgEnum("organization_status", [
  "provisioning",
  "active",
  "suspended",
  "failed",
]);

export const plansTable = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  storageLimitGb: integer("storage_limit_gb").notNull(),
  entitlements: jsonb("entitlements").$type<Record<string, boolean | number | string>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationsTable = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  status: organizationStatusEnum("status").notNull().default("provisioning"),
  planId: uuid("plan_id").notNull().references(() => plansTable.id),
  storageUsedBytes: bigint("storage_used_bytes", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("organizations_slug_idx").on(table.slug),
  index("organizations_plan_idx").on(table.planId),
]);

export const organizationCustomizationTable = pgTable("organization_customization", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
  playerAccent: text("player_accent").notNull().default("#6C5CE7"),
  logoInitials: text("logo_initials").notNull().default("V"),
  logoObjectKey: text("logo_object_key"),
  watermarkObjectKey: text("watermark_object_key"),
  customDomain: text("custom_domain"),
  customDomainVerified: boolean("custom_domain_verified").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Organization = typeof organizationsTable.$inferSelect;
export type Plan = typeof plansTable.$inferSelect;