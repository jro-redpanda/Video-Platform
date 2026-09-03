import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const customDomainLifecycleEnum = pgEnum("custom_domain_lifecycle", [
  "pending_verification", "verifying", "verified", "failed", "suspended", "removed", "reconciliation_required",
]);

/** Historical claims are retained; only rows with an active lifecycle hold a hostname. */
export const customDomainsTable = pgTable("custom_domains", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "restrict" }),
  hostname: text("hostname").notNull(),
  lifecycleState: customDomainLifecycleEnum("lifecycle_state").notNull().default("pending_verification"),
  challengeName: text("challenge_name").notNull(),
  challengeValue: text("challenge_value").notNull(),
  retryable: boolean("retryable").notNull().default(true),
  attempts: integer("attempts").notNull().default(0),
  claimToken: uuid("claim_token"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  verifyRequestedAt: timestamp("verify_requested_at", { withTimezone: true }),
  retryAfterAt: timestamp("retry_after_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  diagnosticCode: text("diagnostic_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("custom_domains_worker_idx").on(table.lifecycleState, table.retryAfterAt, table.createdAt),
]);

export type CustomDomain = typeof customDomainsTable.$inferSelect;

export const customDomainVerificationWindowsTable = pgTable("custom_domain_verification_windows", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});