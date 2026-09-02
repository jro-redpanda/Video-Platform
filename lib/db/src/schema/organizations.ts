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
  description: text("description").notNull().default(""),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  storageLimitGb: integer("storage_limit_gb").notNull(),
  entitlements: jsonb("entitlements").$type<Record<string, boolean | number | string>>().notNull().default({}),
  /** Provider identifiers only; product and price attributes remain Stripe-authoritative. */
  stripeProductId: text("stripe_product_id"),
  stripeMonthlyPriceId: text("stripe_monthly_price_id"),
  stripeAnnualPriceId: text("stripe_annual_price_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("plans_stripe_product_idx").on(table.stripeProductId),
  uniqueIndex("plans_stripe_monthly_price_idx").on(table.stripeMonthlyPriceId),
  uniqueIndex("plans_stripe_annual_price_idx").on(table.stripeAnnualPriceId),
]);

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
  playerControlForeground: text("player_control_foreground").notNull().default("#FFFFFF"),
  playerControlBackground: text("player_control_background").notNull().default("#111827"),
  logoInitials: text("logo_initials").notNull().default("V"),
  logoObjectKey: text("logo_object_key"),
  watermarkObjectKey: text("watermark_object_key"),
  posterTreatment: text("poster_treatment").notNull().default("default"),
  customDomain: text("custom_domain"),
  customDomainVerified: boolean("custom_domain_verified").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Organization = typeof organizationsTable.$inferSelect;
export type Plan = typeof plansTable.$inferSelect;