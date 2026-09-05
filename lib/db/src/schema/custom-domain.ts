import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
  uniqueIndex("custom_domains_one_active_org_idx").on(table.organizationId)
    .where(sql`${table.lifecycleState} not in ('removed')`),
  uniqueIndex("custom_domains_unique_active_hostname_idx").on(table.hostname)
    .where(sql`${table.lifecycleState} not in ('removed')`),
  index("custom_domains_worker_idx").on(table.lifecycleState, table.retryAfterAt, table.createdAt),
  check("custom_domains_attempts_check", sql`${table.attempts} >= 0 and ${table.attempts} <= 8`),
  check("custom_domains_removed_fields", sql`(
    ${table.lifecycleState} = 'removed'
    and ${table.removedAt} is not null
    and ${table.retryable} = false
    and ${table.challengeValue} = 'revoked'
  ) or (
    ${table.lifecycleState} <> 'removed'
    and ${table.removedAt} is null
    and ${table.challengeValue} <> 'revoked'
  )`),
  check("custom_domains_claim_fields", sql`(
    ${table.lifecycleState} = 'verifying'
    and ${table.claimToken} is not null
    and ${table.claimedAt} is not null
  ) or (
    ${table.lifecycleState} <> 'verifying'
    and ${table.claimToken} is null
    and ${table.claimedAt} is null
  )`),
  check("custom_domains_verified_fields", sql`
    (${table.lifecycleState} = 'verified' and ${table.verifiedAt} is not null and ${table.retryable} = false)
    or (${table.lifecycleState} in ('pending_verification', 'verifying', 'failed', 'suspended') and ${table.verifiedAt} is null)
    or ${table.lifecycleState} in ('removed', 'reconciliation_required')
  `),
  check("custom_domains_retry_state", sql`
    (${table.lifecycleState} in ('pending_verification', 'verifying') and ${table.retryable} = true)
    or (${table.lifecycleState} in ('verified', 'suspended', 'removed', 'reconciliation_required') and ${table.retryable} = false)
    or ${table.lifecycleState} = 'failed'
  `),
]);

export type CustomDomain = typeof customDomainsTable.$inferSelect;

export const customDomainVerificationWindowsTable = pgTable("custom_domain_verification_windows", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  check("custom_domain_verification_windows_attempts_check", sql`${table.attempts} >= 1`),
]);